//! Serialises mutating git operations and backs the Cancel button.
//!
//! Two jobs:
//!
//! 1. **One at a time.** A checkout must not race a pull, and the watcher fires
//!    `repo://changed` *during* both — so a read triggered by an operation can
//!    land while it is still running. Reads are made safe separately (see
//!    `git::git_read_command`); writes queue behind this lock, or rather are
//!    refused, because silently queueing a branch switch the user asked for
//!    seconds ago is worse than telling them it did not happen.
//!
//! 2. **Cancellation.** A network op holds a child process that Cancel needs to
//!    kill from another thread.
//!
//! The terminal-event latch is the subtle part. git may hand its stderr pipe to
//! a child (`ssh`) that outlives a kill, so the reader thread can block on a
//! pipe that never reaches EOF. Recovery therefore cannot depend on that thread
//! noticing: whichever of the reader and the canceller claims the latch first
//! emits the one terminal event, and the other stays quiet. Same shape as the
//! `killed` flag in `crate::pty`.
//!
//! Kept free of Tauri types, like `pty` and `watcher`, so the event emission
//! stays in the command layer and the tests here need no app handle.

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::git::GitError;

/// A claim on the single mutating-operation slot. Cheap to clone (all state is
/// shared), so the reader thread and the command layer can both hold one.
#[derive(Clone, Debug)]
pub struct OpLease {
    id: String,
    child: Arc<Mutex<Option<Child>>>,
    terminal_claimed: Arc<AtomicBool>,
}

impl OpLease {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Hand the spawned child over so [`OpLease::kill`] can reach it.
    pub fn set_child(&self, child: Child) {
        *self.lock() = Some(child);
    }

    /// Claim the right to emit this operation's terminal event. Exactly one
    /// caller ever gets `true`.
    pub fn claim_terminal(&self) -> bool {
        self.terminal_claimed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Kill the child, if one is still registered. Best effort: the process may
    /// already have exited, and a grandchild (`ssh`) is not reached.
    pub fn kill(&self) {
        if let Some(child) = self.lock().as_mut() {
            let _ = child.kill();
        }
    }

    /// Reap the child and return its exit code (-1 when it cannot be
    /// determined). Takes the child out, so a later [`OpLease::kill`] is a
    /// no-op rather than touching a reaped pid.
    ///
    /// **The guard is released before the wait, deliberately.** `let child =
    /// self.lock().take();` drops the temporary guard at the semicolon, so the
    /// blocking `child.wait()` below holds no lock and a concurrent
    /// [`OpLease::kill`] is never blocked by it. Writing this as
    /// `match self.lock().take() { … }` would look equivalent but keep the
    /// temporary guard alive for the whole `match`, deadlocking cancellation
    /// against a wait that is itself waiting for the process a cancel would
    /// have killed. Do not fold it back.
    pub fn wait(&self) -> i32 {
        let child = self.lock().take();
        match child {
            Some(mut child) => child.wait().ok().and_then(|s| s.code()).unwrap_or(-1),
            None => -1,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Child>> {
        self.child.lock().expect("git op child mutex poisoned")
    }
}

/// The single mutating-operation slot, held in Tauri managed state.
#[derive(Default)]
pub struct GitOps {
    running: Mutex<Option<OpLease>>,
}

impl GitOps {
    /// Claim the slot for `id`. Fails when an operation is already running.
    pub fn begin(&self, id: &str) -> Result<OpLease, GitError> {
        let mut slot = self.lock();
        if let Some(current) = slot.as_ref() {
            return Err(GitError::Invalid(format!(
                "another git operation ({}) is still running",
                current.id
            )));
        }
        let lease = OpLease {
            id: id.to_string(),
            child: Arc::new(Mutex::new(None)),
            terminal_claimed: Arc::new(AtomicBool::new(false)),
        };
        *slot = Some(lease.clone());
        Ok(lease)
    }

    /// Release the slot if `id` still holds it. Releasing a slot that has moved
    /// on is a no-op, so a late-finishing op cannot evict its successor.
    pub fn finish(&self, id: &str) {
        let mut slot = self.lock();
        if slot.as_ref().is_some_and(|lease| lease.id == id) {
            *slot = None;
        }
    }

    /// Kill the running operation if it is `id`.
    ///
    /// Returns `true` when this call claimed the terminal event, meaning the
    /// caller is responsible for emitting it — the reader thread may never get
    /// the chance. `false` means there was nothing to cancel or the operation
    /// had already reported its own result.
    pub fn cancel(&self, id: &str) -> bool {
        let lease = {
            let slot = self.lock();
            match slot.as_ref() {
                Some(lease) if lease.id == id => lease.clone(),
                _ => return false,
            }
        };
        // Claim before killing: if the reader is mid-emit it wins the latch and
        // we must not emit a second terminal event for the same operation.
        let claimed = lease.claim_terminal();
        lease.kill();
        claimed
    }

    /// Id of the running operation, if any.
    pub fn running_id(&self) -> Option<String> {
        self.lock().as_ref().map(|lease| lease.id.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<OpLease>> {
        self.running.lock().expect("git op slot mutex poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_operation_is_refused_while_one_runs() {
        let ops = GitOps::default();
        let _lease = ops.begin("op-1").expect("first op claims the slot");
        let error = ops.begin("op-2").expect_err("second op refused");
        assert!(error.to_string().contains("op-1"), "{error}");
    }

    #[test]
    fn the_slot_is_reusable_after_finish() {
        let ops = GitOps::default();
        ops.begin("op-1").expect("claim");
        assert_eq!(ops.running_id().as_deref(), Some("op-1"));
        ops.finish("op-1");
        assert_eq!(ops.running_id(), None);
        ops.begin("op-2").expect("slot free again");
    }

    #[test]
    fn finishing_a_stale_id_does_not_evict_its_successor() {
        let ops = GitOps::default();
        ops.begin("op-1").expect("claim");
        ops.finish("op-1");
        ops.begin("op-2").expect("claim");
        // op-1's thread finishing late must not release op-2's slot.
        ops.finish("op-1");
        assert_eq!(ops.running_id().as_deref(), Some("op-2"));
    }

    #[test]
    fn the_terminal_event_can_only_be_claimed_once() {
        let ops = GitOps::default();
        let lease = ops.begin("op-1").expect("claim");
        assert!(lease.claim_terminal());
        assert!(!lease.claim_terminal());
        // And the canceller loses, because the reader already reported.
        assert!(!ops.cancel("op-1"));
    }

    #[test]
    fn cancelling_claims_the_terminal_event_so_the_caller_reports_it() {
        let ops = GitOps::default();
        let lease = ops.begin("op-1").expect("claim");
        assert!(ops.cancel("op-1"), "canceller reports the outcome");
        // The reader thread, waking up later, must stay quiet.
        assert!(!lease.claim_terminal());
    }

    #[test]
    fn cancelling_an_unknown_or_finished_operation_is_a_no_op() {
        let ops = GitOps::default();
        assert!(!ops.cancel("nothing-running"));
        ops.begin("op-1").expect("claim");
        assert!(!ops.cancel("op-2"), "a different id must not be cancelled");
    }

    #[test]
    fn waiting_without_a_child_reports_an_unknown_code() {
        let ops = GitOps::default();
        let lease = ops.begin("op-1").expect("claim");
        // No child was ever attached (spawn failed): wait must not panic.
        assert_eq!(lease.wait(), -1);
        lease.kill();
    }
}
