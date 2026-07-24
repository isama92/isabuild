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
//! extra cycle rather than looping. Gitignore-aware filtering (skip
//! node_modules/target) is a later refinement.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

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
    /// debounced batch of changes beneath it.
    pub fn watch<F>(&self, on_change: F, root: &Path) -> Result<(), WatchError>
    where
        F: Fn() + Send + 'static,
    {
        let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            // We only need "something changed" — ignore which paths, and treat
            // a transient watch error as simply "no refresh this round".
            if res.is_ok() {
                on_change();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn emits_when_a_watched_file_changes() {
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

        std::fs::write(dir.path().join("change.txt"), b"hello").expect("write");

        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "expected a debounced change event within 5s"
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
