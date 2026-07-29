//! Debounced filesystem watcher for the active repository.
//!
//! Per CLAUDE.md ("events over polling"): any change under the repo root fires
//! a single debounced (~300 ms) notification, which the command layer forwards
//! as the `repo://changed` Tauri event; the frontend re-requests `git_status`
//! in response. No timers poll git.
//!
//! The change sink is a plain `Fn()` closure so this module has no Tauri
//! dependency (mirroring `pty.rs`): production wraps an `AppHandle::emit`, tests
//! use an mpsc channel.
//!
//! The recursive watch deliberately includes `.git/`, so staging (which writes
//! `.git/index`) also triggers a refresh. The debounce coalesces the churn a
//! busy repo produces; a status that rewrites the stat cache settles after one
//! extra cycle rather than looping.
//!
//! Which paths are *worth* a refresh is [`crate::watchfilter`]'s job, and without
//! it the debounce alone was not nearly enough: a batch is re-emitted every ~300 ms
//! for as long as anything under the root keeps being written, so a build running
//! into `target/` kept the sidebar reading a repo that never changed (Part 9).
//!
//! **How the watch is assembled differs by platform, and only here.** On Linux a
//! recursive watch means one inotify watch per directory, so the tree is walked
//! and armed a directory at a time, skipping everything the filter would discard
//! anyway ([`crate::watchtree`]); 4,419 watches become 32 in this checkout.
//! Everywhere else one recursive watch on the root is what the OS gives us and it
//! is already cheap — macOS rebuilds its entire FSEvents stream on *every*
//! `watch()` call (stopping and joining its run-loop thread each time), and
//! Windows holds an open handle and a 16 KB buffer per watch, so arming a
//! directory at a time there would cost more than it saves. `arm` and `reconcile`
//! are the two seams; everything else is shared.
//!
//! One behaviour that used to look like a bug the first time it was seen: **arming
//! a recursive watch replays the tree it just discovered**, one synthetic event
//! per pre-existing path. That is `notify`'s inotify backend walking the tree to
//! arm it, so on Linux it is gone — the walk records what the replay used to
//! teach, and arming is silent. macOS and Windows never replayed. A test still
//! cannot assume the *first* batch it sees came from a change it made, because a
//! `git` fixture leaves its own writes settling.
//!
//! Not covered, and not covered before either: a **linked worktree or submodule**,
//! where the project's `.git` is a *file* and the index, HEAD and refs live
//! outside the watch root entirely, so staging never reaches us. The `.git` rules
//! in the filter read as though that case were handled; it is not.
//!
//! **Why a thread owns the debouncer.** The handler has to *add* watches, but it
//! is owned by the `Debouncer` that owns the watcher, so the obvious fix — share
//! an `Arc<Mutex<Debouncer>>` with the closure — is a reference cycle: the
//! debouncer owns the closure that owns the `Arc` back to it, nothing is ever
//! dropped and the watcher outlives the project. Break the cycle with a `Weak` and
//! the handler thread can end up dropping the debouncer and joining itself. So one
//! thread owns it outright and holds `&mut` on the watcher with no lock at all.
//! Batches are still processed strictly in order on a single thread, which the
//! filter's cache depends on; the difference is that git subprocesses now run off
//! the debouncer's own tick thread rather than on it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use notify_debouncer_mini::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

use crate::watchfilter::WatchFilter;
use crate::watchtree::WatchTree;

/// Debounce window. Long enough to collapse a burst of writes (a `git`
/// operation touching many files) into one refresh, short enough to feel live.
const DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("failed to create file watcher: {0}")]
    Create(#[source] notify::Error),
    #[error("failed to watch '{path}': {source}")]
    Watch {
        path: String,
        #[source]
        source: notify::Error,
    },
    #[error("failed to start the watcher thread: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("the watcher stopped before it finished arming")]
    Stopped,
}

/// How much of the tree the watch actually covers.
///
/// Reported rather than kept private because the interesting failure is partial:
/// a directory-at-a-time watch can run out of inotify watches half way through,
/// and what follows is a sidebar that updates for some paths and not others. That
/// used to be indistinguishable from a working one — the whole failure mode this
/// part exists to fix — so the count travels to the frontend, which warns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSummary {
    /// Directories under an active watch. Always 1 where the watch is recursive.
    pub watched: usize,
    /// Directories the OS refused to watch. Anything above zero means events from
    /// somewhere in the tree will be missed.
    pub failed: usize,
}

/// What reaches the owner thread. A batch from the debouncer, or the end.
enum Msg {
    Batch(DebounceEventResult),
    Stop,
}

/// Holds the single active watch in Tauri managed state. Replacing it (a new
/// repo, or a re-arm) drops the previous [`Session`], which stops its thread and
/// releases every OS watch it held.
#[derive(Default)]
pub struct GitWatcher {
    inner: Mutex<Option<Session>>,
}

/// A live watch: the owner thread, and the way to ask it to stop.
struct Session {
    stop: Sender<Msg>,
    /// Out-of-band, because `Msg::Stop` queues *behind* whatever batches are
    /// already in the channel and each of those can be a full walk. Dropping a
    /// session happens on a Tauri async worker (`teardown_workspace`, reached
    /// from `project_open` and `project_close`), so waiting for the backlog to
    /// drain would stall the UI for the length of it. With the flag, the join
    /// waits for at most the batch already in flight.
    stopping: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        // A send failure means the thread is already gone, which is the state we
        // are asking for. It is still sent, to wake a thread parked on `recv`.
        // The join is what makes "the watch is released" true by the time a
        // caller has dropped this, rather than eventually.
        let _ = self.stop.send(Msg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl GitWatcher {
    /// (Re)start watching `root`; `on_change` runs once per debounced batch of
    /// changes beneath it that could alter what the UI shows.
    ///
    /// Blocks until the watch is armed, so a caller learns synchronously that
    /// (say) the path does not exist, and so no event can arrive before the tree
    /// it describes has been walked.
    ///
    /// The filter and the watch set both live on the owner thread, so a re-arm or
    /// a `stop` discards them along with the debouncer and a new repo can never
    /// inherit the previous one's verdicts.
    pub fn watch<F>(&self, on_change: F, root: &Path) -> Result<WatchSummary, WatchError>
    where
        F: Fn() + Send + 'static,
    {
        let (outbox, inbox) = mpsc::channel::<Msg>();
        let (ready, armed) = mpsc::channel::<Result<WatchSummary, WatchError>>();
        let root = root.to_path_buf();
        let handler = outbox.clone();
        let stopping = Arc::new(AtomicBool::new(false));
        let watching = Arc::clone(&stopping);

        let thread = std::thread::Builder::new()
            .name("isabuild-watcher".to_string())
            .spawn(move || own(root, on_change, handler, inbox, ready, &watching))
            .map_err(WatchError::Spawn)?;

        match armed.recv() {
            Ok(Ok(summary)) => {
                let session = Session {
                    stop: outbox,
                    stopping,
                    thread: Some(thread),
                };
                // Swapped in only once armed, so a failed re-arm leaves any
                // previous watch untouched. The old session is dropped *outside*
                // the lock: dropping it joins a thread, and holding the mutex
                // across a join is how this deadlocks the first time someone
                // reaches for the tidier one-liner.
                let previous = {
                    let mut slot = self.inner.lock().expect("git watcher mutex poisoned");
                    slot.replace(session)
                };
                drop(previous);
                Ok(summary)
            }
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            // The thread ended without answering, which means it panicked.
            Err(_) => {
                let _ = thread.join();
                Err(WatchError::Stopped)
            }
        }
    }

    /// Stop watching entirely. Closing a project has nothing to watch, and a
    /// live watch on a folder the user has finished with would keep firing
    /// `repo://changed` at a workspace that is no longer there.
    pub fn stop(&self) {
        let session = {
            let mut slot = self.inner.lock().expect("git watcher mutex poisoned");
            slot.take()
        };
        drop(session);
    }
}

/// The owner thread: builds the debouncer, arms the watch, then filters batches
/// and keeps the watch set in step until asked to stop.
fn own<F>(
    root: PathBuf,
    on_change: F,
    handler: Sender<Msg>,
    inbox: Receiver<Msg>,
    ready: Sender<Result<WatchSummary, WatchError>>,
    stopping: &AtomicBool,
) where
    F: Fn() + Send + 'static,
{
    // The handler does nothing but forward. It runs on the debouncer's tick
    // thread, the channel is unbounded, so it can never block and can never be
    // the reason a batch is late.
    let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let _ = handler.send(Msg::Batch(res));
    });
    let mut debouncer = match debouncer {
        Ok(debouncer) => debouncer,
        Err(error) => {
            let _ = ready.send(Err(WatchError::Create(error)));
            return;
        }
    };

    let mut filter = WatchFilter::new(&root);
    let mut tree = WatchTree::new(&root);
    match arm(&mut debouncer, &mut tree, &mut filter, &root) {
        Ok(summary) => {
            if ready.send(Ok(summary)).is_err() {
                return; // the caller gave up; nothing to watch for
            }
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    }

    while let Ok(message) = inbox.recv() {
        // Checked before the work, not only on `Msg::Stop`: a backlog of batches
        // sits ahead of that message in the same channel, and whoever is dropping
        // this session is blocked in a join until we get to it.
        if stopping.load(Ordering::Relaxed) {
            break;
        }
        match message {
            Msg::Stop => break,
            // `kind` is deliberately not consulted. Skipping `AnyContinuous`
            // would look like a cheap way to throttle, but it is the signal a
            // file is *still* being written: dropping it would mean no refresh
            // at all, for the whole duration of a long checkout or an LFS
            // smudge, on exactly the file the user is watching. With the paths
            // filtered, a repeat costs two hash lookups.
            Msg::Batch(Ok(events)) => {
                let paths: Vec<PathBuf> = events.into_iter().map(|event| event.path).collect();
                let generation = filter.generation();
                let mut refresh = filter.should_refresh(paths.iter().map(PathBuf::as_path));
                if reconcile(&mut debouncer, &mut tree, &mut filter, &paths, generation) {
                    refresh = true;
                }
                if refresh {
                    on_change();
                }
            }
            // A lost batch, which on Linux most likely means the inotify queue
            // overflowed. Previously dropped in silence, leaving a stale panel
            // with no route back to the truth; the only sound response to
            // "events were lost" is to read, and to stop trusting the cache
            // since one of the lost events may have been a `.gitignore` write.
            // The watch set is equally suspect — one of them may have been a
            // `mkdir` — so it is rebuilt too, where we assemble it ourselves.
            Msg::Batch(Err(_)) => {
                filter.invalidate();
                rearm(&mut debouncer, &mut tree, &mut filter);
                on_change();
            }
        }
    }
    // Dropping the debouncer here stops its thread and releases every watch.
}

/// Arm the watch. One recursive watch on the root, except on Linux.
#[cfg(not(target_os = "linux"))]
fn arm(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    _tree: &mut WatchTree,
    _filter: &mut WatchFilter,
    root: &Path,
) -> Result<WatchSummary, WatchError> {
    debouncer
        .watcher()
        .watch(root, RecursiveMode::Recursive)
        .map_err(|source| WatchError::Watch {
            path: root.display().to_string(),
            source,
        })?;
    Ok(WatchSummary {
        watched: 1,
        failed: 0,
    })
}

/// Arm the watch a directory at a time, skipping everything the filter would
/// discard. See [`crate::watchtree`] for why, and for what the walk costs.
#[cfg(target_os = "linux")]
fn arm(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    tree: &mut WatchTree,
    filter: &mut WatchFilter,
    root: &Path,
) -> Result<WatchSummary, WatchError> {
    // The root first, and on its own: a failure here is the one that means this
    // cannot work at all (the path does not exist, or is not readable), while a
    // failure on any directory below it is partial and reported rather than fatal.
    debouncer
        .watcher()
        .watch(root, RecursiveMode::NonRecursive)
        .map_err(|source| WatchError::Watch {
            path: root.display().to_string(),
            source,
        })?;
    tree.armed(root);

    // Before the walk, so the directories on the way to a force-added file are in
    // the plan rather than arriving one plan late.
    tree.forced_changed();
    let plan = tree.plan(filter);
    let failed = apply(debouncer, tree, &plan);
    Ok(WatchSummary {
        watched: tree.watched(),
        failed,
    })
}

/// Add and drop watches to match `plan`, returning how many the OS refused.
fn apply(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    tree: &mut WatchTree,
    plan: &crate::watchtree::Plan,
) -> usize {
    for dir in &plan.remove {
        // An error here means the watch is already gone, which is the goal.
        let _ = debouncer.watcher().unwatch(dir);
        tree.released(dir);
    }
    let mut failed = 0;
    for dir in &plan.add {
        match debouncer.watcher().watch(dir, RecursiveMode::NonRecursive) {
            // Recorded only once the OS has agreed, so a refusal is retried by the
            // next plan instead of being remembered as a watch we do not have.
            Ok(()) => tree.armed(dir),
            // Out of inotify watches, or the directory vanished between the walk
            // and here. Neither is fatal — what is armed still works — but the
            // count travels to the frontend so a partial watch is not a silent one.
            Err(_) => failed += 1,
        }
    }
    failed
}

/// Rebuild the whole watch set, after events were lost and we cannot know what
/// changed. A no-op where the watch is recursive and the OS keeps it current.
///
/// The third `cfg` seam, and the one easiest to forget: without it a lost batch
/// on macOS or Windows would walk the tree and arm a watch per directory *on top
/// of* the live recursive one, which is exactly the cost those platforms are
/// spared from paying.
#[cfg(not(target_os = "linux"))]
fn rearm(
    _debouncer: &mut Debouncer<RecommendedWatcher>,
    _tree: &mut WatchTree,
    _filter: &mut WatchFilter,
) {
}

#[cfg(target_os = "linux")]
fn rearm(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    tree: &mut WatchTree,
    filter: &mut WatchFilter,
) {
    // One of the lost events may have been the index write for a `git add -f`,
    // and this is the only pass that will look.
    tree.forced_changed();
    let plan = tree.plan(filter);
    apply(debouncer, tree, &plan);
}

/// Keep the watch set in step with what the batch just told us about the tree.
/// A no-op where the watch is recursive: the OS does this itself.
#[cfg(not(target_os = "linux"))]
fn reconcile(
    _debouncer: &mut Debouncer<RecommendedWatcher>,
    _tree: &mut WatchTree,
    _filter: &mut WatchFilter,
    _paths: &[PathBuf],
    _generation: u64,
) -> bool {
    false
}

/// Keep the watch set in step with what the batch just told us about the tree.
///
/// Returns whether anything it found is itself worth a refresh, which only the
/// newly discovered subtrees can be.
#[cfg(target_os = "linux")]
fn reconcile(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    tree: &mut WatchTree,
    filter: &mut WatchFilter,
    paths: &[PathBuf],
    generation: u64,
) -> bool {
    // The ignore rules moved, so the watch set derived from them is stale in both
    // directions: un-ignoring `build/` has to start watching it, ignoring it has
    // to stop.
    let mut stale = filter.generation() != generation;

    // An index write is what a `git add -f` always produces, and it is the only
    // warning we get that a path git reports has appeared inside a directory git
    // ignores. The cached "this directory is ignored" verdict that let the walk
    // skip it is the same verdict that would now drop the file's events, so the
    // filter has to forget as well as the tree.
    //
    // `index_moved` and not "the batch mentions the index": the answer costs a
    // `git ls-files`, which opens the index, which is itself an event — see the
    // loop written out on `WatchFilter::index_moved`.
    if filter.index_moved() && tree.forced_changed() {
        filter.invalidate();
        stale = true;
    }

    if stale {
        let plan = tree.plan(filter);
        apply(debouncer, tree, &plan);
        // No refresh of its own: whatever made the rules move — a `.gitignore`
        // write, an index write — was itself an event this batch already answered.
        return false;
    }

    let mut refresh = false;
    for path in paths {
        if tree.is_watched(path) {
            if !is_directory(path) {
                // Gone. `notify` has already released the kernel watch, but a
                // stale entry here would stop us re-arming it if it came back.
                tree.released(path);
            }
            continue;
        }
        if !is_directory(path) {
            continue;
        }
        let plan = tree.discover(path, filter);
        if plan.add.is_empty() {
            continue;
        }
        apply(debouncer, tree, &plan);
        // Only now that they are armed, so content created in the gap between the
        // walk and the watch is found rather than lost. A directory found in that
        // gap has the same gap of its own, hence the loop: it is armed, then swept
        // in turn, until a pass turns up nothing new.
        //
        // Bounded because the alternative is unbounded: a `mkdir` running in a
        // tight loop could otherwise keep this pass alive indefinitely, and a
        // watcher that never returns to its inbox is worse than one that catches
        // the remainder on the next batch.
        let mut pending = plan.add;
        for _ in 0..MAX_SWEEPS {
            let swept = tree.sweep(&pending, filter);
            if swept.refresh {
                refresh = true;
            }
            if swept.unwatched.is_empty() {
                break;
            }
            pending = Vec::new();
            for found in swept.unwatched {
                let plan = tree.discover(&found, filter);
                apply(debouncer, tree, &plan);
                pending.extend(plan.add);
            }
            if pending.is_empty() {
                break;
            }
        }
    }
    refresh
}

/// How many times [`crate::watchtree::WatchTree::sweep`] will chase directories
/// that appeared while it was arming the last lot. Deep enough for `mkdir -p` to
/// settle, shallow enough that a directory being created in a loop cannot hold
/// the watcher off its inbox.
#[cfg(target_os = "linux")]
const MAX_SWEEPS: usize = 8;

/// A directory, and not a symlink to one — the walk does not follow links, so
/// neither can this, or the two would disagree about what is watched.
#[cfg(target_os = "linux")]
fn is_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn emits_when_a_watched_file_changes() {
        // A real repository, so this exercises the filter's decision rather than
        // passing because a non-repo makes `check-ignore` fail and everything
        // falls back to refreshing.
        let dir = crate::testrepo::repo_with_commit("file.txt", "one\n");
        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");

        // Drain the arming replay first, or this passes on an event it did not
        // cause: the replay reports every path it discovers, so a filter that
        // dropped the whole working tree would still satisfy the assertion.
        while rx.recv_timeout(Duration::from_millis(900)).is_ok() {}

        std::fs::write(dir.path().join("file.txt"), b"two\n").expect("write");

        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "expected a debounced change event within 5s"
        );
    }

    #[test]
    fn a_directory_that_is_not_a_repo_still_emits() {
        // `check-ignore` cannot answer, and not knowing has to mean refresh.
        let dir = tempfile::tempdir().expect("temp dir");
        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");

        while rx.recv_timeout(Duration::from_millis(900)).is_ok() {}

        std::fs::write(dir.path().join("change.txt"), b"hello").expect("write");

        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn our_own_reads_do_not_feed_the_watcher() {
        // The loop this filter could easily have created instead of fixing, and the
        // reason `watchfilter::WatchFilter::changed_on_disk` exists: `notify`'s
        // inotify mask includes OPEN, so every file and directory `git status` reads
        // is itself an event. Answering one refresh by reading the repo therefore
        // asked for the next, measured at roughly seven a second on an idle clean
        // tree, on ext4 as well as tmpfs.
        //
        // So this runs the frontend's actual cascade on every notification and
        // requires it to stop of its own accord.
        let dir = crate::testrepo::repo_with_commit("file.txt", "one\n");
        std::fs::create_dir(dir.path().join("src")).expect("create dir");
        crate::testrepo::write(dir.path(), "src/app.ts", "export const a = 1;\n");
        crate::testrepo::git_in(dir.path(), &["add", "src/app.ts"]);
        crate::testrepo::commit(dir.path(), "more to read");

        let (tx, rx) = mpsc::channel();
        let root = dir.path().to_path_buf();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    // Exactly what the frontend does on `repo://changed`.
                    let _ = crate::git::status_from(&root);
                    let _ = crate::branch::branch_state(&root);
                    let _ = crate::merge::merge_state(&root);
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");

        // Let the arming replay, and the cascade it triggers, settle.
        std::thread::sleep(Duration::from_millis(2000));
        while rx.try_recv().is_ok() {}

        let mut refreshes = 0;
        std::thread::sleep(Duration::from_millis(2000));
        while rx.try_recv().is_ok() {
            refreshes += 1;
        }

        // Unfiltered, and with the loop open, this window held a dozen or more.
        assert!(
            refreshes <= 2,
            "our own reads must not feed the watcher; saw {refreshes} in a quiet window"
        );
    }

    // The one timing-dependent test in this file, and it earns that: nothing else
    // proves the filter is wired into the debouncer's callback rather than merely
    // correct in isolation, which `watchfilter`'s own tests establish with no
    // timing at all through its query counter.
    //
    // It counts notifications against a **wide** bound rather than asserting
    // silence, and that is the whole trick. Asserting silence does not work here:
    // arming settles asynchronously, and where the watch is recursive the replay
    // (see the module note) has been measured emitting its tail batch 2.4 s after
    // the watch was armed, so no amount of waiting first makes "nothing arrived"
    // attributable to the churn. A bound separates the two populations instead,
    // because arming is a fixed handful while unfiltered churn is one notification
    // per debounce window for as long as it runs. On Linux the directory is now
    // never watched at all and the honest count is zero, which the same bound
    // covers.
    #[test]
    fn churn_in_an_ignored_directory_does_not_keep_firing() {
        // The whole point of Part 9, end to end: this is what `npm run tauri dev`
        // does to `target/` for minutes at a time.
        let dir = crate::testrepo::repo_with_commit("file.txt", "one\n");
        std::fs::write(dir.path().join(".gitignore"), b"ignored/\n").expect("write");
        crate::testrepo::git_in(dir.path(), &["add", ".gitignore"]);
        crate::testrepo::commit(dir.path(), "ignore rules");
        // Created before the watch is armed, so a `dir/` pattern can match it: git
        // will not call a path ignored unless it can see that it is a directory.
        let churn = dir.path().join("ignored");
        std::fs::create_dir(&churn).expect("create dir");

        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");

        // Three seconds of continuous writing, which is ten debounce windows.
        let mut notifications = 0;
        for round in 0..20 {
            for index in 0..5 {
                std::fs::write(churn.join(format!("out{round}-{index}")), b"x").expect("write");
            }
            std::thread::sleep(Duration::from_millis(150));
            while rx.try_recv().is_ok() {
                notifications += 1;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
        while rx.try_recv().is_ok() {
            notifications += 1;
        }

        // Unfiltered this was ten or more, one per window, indefinitely — the strobe
        // as the user reported it. Filtered, the only notifications that can arrive
        // are the arming replay's own two or three.
        assert!(
            notifications <= 4,
            "ignored churn must not keep firing; saw {notifications} notifications"
        );
    }

    #[test]
    fn rewatch_replaces_the_previous_target() {
        let first = tempfile::tempdir().expect("temp dir a");
        let second = tempfile::tempdir().expect("temp dir b");
        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                {
                    let tx = tx.clone();
                    move || {
                        let _ = tx.send(());
                    }
                },
                first.path(),
            )
            .expect("first watch starts");
        // Re-arm on the second dir; the first watcher is dropped in the swap.
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                second.path(),
            )
            .expect("second watch starts");

        std::fs::write(second.path().join("change.txt"), b"hello").expect("write");
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the re-armed watch on the second dir must fire"
        );
    }

    #[test]
    fn stop_releases_the_watch() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");

        watcher.stop();
        std::fs::write(dir.path().join("change.txt"), b"hello").expect("write");

        assert!(
            rx.recv_timeout(Duration::from_millis(800)).is_err(),
            "a stopped watcher must not fire at the closed project"
        );
    }

    // inotify reliably rejects a non-existent path; FSEvents/ReadDirectoryChanges
    // do not, so this negative case is scoped to Linux.
    #[cfg(target_os = "linux")]
    #[test]
    fn watching_a_missing_path_errors() {
        let watcher = GitWatcher::default();
        let missing = Path::new("/no/such/isabuild/watch/target");
        let err = watcher
            .watch(|| {}, missing)
            .expect_err("missing path must error");
        assert!(matches!(err, WatchError::Watch { .. }));
    }

    /// A repo with an ignored directory and a couple of source directories, which
    /// is the shape every test below wants.
    fn repo_with_an_ignored_tree() -> tempfile::TempDir {
        let dir = crate::testrepo::repo_with_commit("file.txt", "one\n");
        crate::testrepo::write(dir.path(), ".gitignore", "ignored/\n");
        crate::testrepo::git_in(dir.path(), &["add", ".gitignore"]);
        crate::testrepo::commit(dir.path(), "ignore rules");
        for path in ["src/lib", "ignored/deep/deeper"] {
            std::fs::create_dir_all(dir.path().join(path)).expect("create dir");
        }
        dir
    }

    #[test]
    fn a_directory_created_after_arming_is_watched() {
        // The case a non-recursive watch has to handle itself: `notify` only
        // auto-arms a new subdirectory when its parent's watch is recursive. Not
        // gated by platform on purpose — it is the behaviour both arming
        // strategies owe the user, and the recursive one gets it from the OS.
        let dir = repo_with_an_ignored_tree();
        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");
        while rx.recv_timeout(Duration::from_millis(900)).is_ok() {}

        std::fs::create_dir_all(dir.path().join("src/fresh/deep")).expect("create dir");
        // Wait for the directory to be discovered and armed before writing, so
        // this tests the watch rather than the sweep.
        let _ = rx.recv_timeout(Duration::from_secs(5));
        std::fs::write(dir.path().join("src/fresh/deep/new.ts"), b"export {};\n").expect("write");

        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "a file written in a directory created after arming must refresh"
        );
    }

    #[test]
    fn content_created_before_its_watch_lands_is_still_reported() {
        // The arm-gap: the directory and everything in it exist before we hear
        // about any of it, so no event will ever name the file.
        //
        // What this can and cannot establish, because the distinction matters: the
        // batch also carries the `src/fresh` create event, which is a first
        // sighting and refreshes on its own, so a pass here does **not** prove the
        // sweep found the file. It proves the end-to-end path does not regress.
        // The mechanism is pinned without that ambiguity by
        // `watchtree::tests::sweeping_a_freshly_armed_subtree_reports_its_contents`,
        // which asserts on the sweep's own return value.
        let dir = repo_with_an_ignored_tree();
        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");
        while rx.recv_timeout(Duration::from_millis(900)).is_ok() {}

        // Populated in one go, so the whole subtree predates its own watch.
        std::fs::create_dir_all(dir.path().join("src/fresh/deep")).expect("create dir");
        std::fs::write(dir.path().join("src/fresh/deep/new.ts"), b"export {};\n").expect("write");

        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "a subtree that appeared whole must still refresh"
        );
    }

    #[test]
    fn un_ignoring_a_directory_starts_watching_it() {
        // The re-plan. A directory skipped at arming time has no watch, so nothing
        // in it can be seen until the rules change and it is armed.
        let dir = repo_with_an_ignored_tree();
        let (tx, rx) = mpsc::channel();
        let watcher = GitWatcher::default();
        watcher
            .watch(
                move || {
                    let _ = tx.send(());
                },
                dir.path(),
            )
            .expect("watch starts");
        while rx.recv_timeout(Duration::from_millis(900)).is_ok() {}

        std::fs::write(dir.path().join(".gitignore"), b"other/\n").expect("write");
        // Drain the refresh the `.gitignore` write itself earns, which is also
        // what carries the re-plan.
        while rx.recv_timeout(Duration::from_millis(1500)).is_ok() {}

        std::fs::write(dir.path().join("ignored/deep/now.txt"), b"seen\n").expect("write");
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "a directory that stopped being ignored must be watched"
        );
    }

    // The measurement the whole part exists for, and it only means anything where
    // the watch is assembled per directory.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_watch_covers_far_less_than_the_tree() {
        let dir = repo_with_an_ignored_tree();
        // Enough ignored directories that a recursive watch would be dominated by
        // them, which is the real shape: `node_modules` and `target`.
        for index in 0..200 {
            std::fs::create_dir_all(dir.path().join(format!("ignored/pkg{index}/dist")))
                .expect("create dir");
        }

        let watcher = GitWatcher::default();
        let summary = watcher.watch(|| {}, dir.path()).expect("watch starts");

        assert_eq!(summary.failed, 0, "nothing should have been refused here");
        // The root, `src`, `src/lib`, `.git` and its handful of state directories.
        // A recursive watch would have held over 400.
        assert!(
            summary.watched < 15,
            "expected a watch per surviving directory; got {}",
            summary.watched
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn a_recursive_watch_reports_the_one_watch_it_holds() {
        let dir = repo_with_an_ignored_tree();
        let watcher = GitWatcher::default();
        let summary = watcher.watch(|| {}, dir.path()).expect("watch starts");
        assert_eq!(
            summary,
            WatchSummary {
                watched: 1,
                failed: 0
            }
        );
    }
}
