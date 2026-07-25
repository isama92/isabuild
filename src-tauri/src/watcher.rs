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
//! One behaviour of the underlying watcher worth knowing, because it looks like a
//! bug the first time it is seen: **arming a recursive watch replays the tree it
//! just discovered**, one synthetic event per pre-existing path, spread over
//! several debounce batches. So a re-arm always produces a refresh or two, and on
//! a large tree the filter spends a handful of `check-ignore` batches learning the
//! ignored directories. Harmless (the frontend reads on mount anyway, and the
//! ancestor cache collapses the rest), but it is why a test cannot assume the first
//! batch it sees came from a change it made.
//!
//! Not covered, and not covered before either: a **linked worktree or submodule**,
//! where the project's `.git` is a *file* and the index, HEAD and refs live
//! outside the watch root entirely, so staging never reaches us. The `.git` rules
//! in the filter read as though that case were handled; it is not.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

use crate::watchfilter::WatchFilter;

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
}

/// Holds the single active watcher in Tauri managed state. Replacing it (a new
/// repo, or a re-arm) drops the previous debouncer, which stops its background
/// thread and releases the OS watch.
#[derive(Default)]
pub struct GitWatcher {
    inner: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

impl GitWatcher {
    /// (Re)start watching `root` recursively; `on_change` runs once per
    /// debounced batch of changes beneath it that could alter what the UI shows.
    ///
    /// The filter lives inside the handler closure, so a re-arm or a `stop`
    /// discards its cache along with the debouncer and a new repo can never
    /// inherit the previous one's verdicts. `check_ignored` runs on the
    /// debouncer's own thread, which is safe and deliberate: its inbound channel
    /// is unbounded, so a slow batch delays the next tick without losing an event,
    /// and it is not the Tauri main thread. Do not "improve" it into a spawned
    /// task; the cache depends on batches being processed in order.
    pub fn watch<F>(&self, on_change: F, root: &Path) -> Result<(), WatchError>
    where
        F: Fn() + Send + 'static,
    {
        let mut filter = WatchFilter::new(root);
        let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            match res {
                // `kind` is deliberately not consulted. Skipping `AnyContinuous`
                // would look like a cheap way to throttle, but it is the signal a
                // file is *still* being written: dropping it would mean no refresh
                // at all, for the whole duration of a long checkout or an LFS
                // smudge, on exactly the file the user is watching. With the paths
                // filtered, a repeat costs two hash lookups.
                Ok(events) => {
                    if filter.should_refresh(events.iter().map(|event| event.path.as_path())) {
                        on_change();
                    }
                }
                // A lost batch, which on Linux most likely means the inotify queue
                // overflowed. Previously dropped in silence, leaving a stale panel
                // with no route back to the truth; the only sound response to
                // "events were lost" is to read, and to stop trusting the cache
                // since one of the lost events may have been a `.gitignore` write.
                Err(_) => {
                    filter.invalidate();
                    on_change();
                }
            }
        })
        .map_err(WatchError::Create)?;

        debouncer
            .watcher()
            .watch(root, RecursiveMode::Recursive)
            .map_err(|source| WatchError::Watch {
                path: root.display().to_string(),
                source,
            })?;

        // Swap in the new watcher only once it is fully armed, so a failed
        // re-arm leaves any previous watch untouched.
        *self.inner.lock().expect("git watcher mutex poisoned") = Some(debouncer);
        Ok(())
    }

    /// Stop watching entirely. Closing a project has nothing to watch, and a
    /// live watch on a folder the user has finished with would keep firing
    /// `repo://changed` at a workspace that is no longer there.
    pub fn stop(&self) {
        *self.inner.lock().expect("git watcher mutex poisoned") = None;
    }
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
    // the arming replay (see the module note) has been measured emitting its tail
    // batch 2.4 s after the watch was armed, so no amount of waiting first makes
    // "nothing arrived" attributable to the churn. A bound separates the two
    // populations instead, because the replay is a fixed handful while unfiltered
    // churn is one notification per debounce window for as long as it runs.
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
}
