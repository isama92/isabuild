//! Thin Tauri command layer over [`crate::pty`]. Commands are `async` so
//! blocking PTY writes stay off the main thread; they return `Result<_, String>`
//! with actionable messages for the frontend.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager as _, State};

use crate::branch::{self, BranchState, DirtyPolicy, SwitchOutcome, SwitchTarget};
use crate::diff::{self, Eol, FileDiff};
use crate::git::{self, GitError, GitStatus};
use crate::gitops::GitOps;
use crate::merge::{
    self, ConflictChoice, ConflictFile, MergeOutcome, MergeState, PathResolution, ResolveOutcome,
};
use crate::pty::{PtyEvent, PtyManager, SpawnParams};
use crate::remote::{self, OpEvent, RemoteOpSpec};
use crate::spawn::{default_cwd, joined_command, shell_spec};
use crate::watcher::GitWatcher;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    exit_code: u32,
}

/// Production event sink: forwards PTY events to the webview. Emit failures
/// are ignored — they only happen during webview teardown.
fn event_sink(app: AppHandle) -> impl Fn(PtyEvent) + Send + 'static {
    move |event| match event {
        PtyEvent::Output { id, data_b64 } => {
            let _ = app.emit(&format!("pty://output/{id}"), data_b64);
        }
        PtyEvent::Exit { id, exit_code } => {
            let _ = app.emit(&format!("pty://exit/{id}"), ExitPayload { exit_code });
        }
    }
}

/// Spawn a PTY session. `cmd`/`args` are joined unquoted and run through the
/// platform shell (login shell on Unix, Git Bash/PowerShell on Windows);
/// `cmd: None` gives a plain interactive shell.
// The arg list mirrors the frontend invoke payload 1:1; grouping into a
// struct would only move the count into JSON nesting.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cmd: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let command = joined_command(cmd.as_deref(), &args);
    let spec = shell_spec(command.as_deref());
    let cwd = match cwd {
        Some(dir) => {
            let dir = std::path::PathBuf::from(dir);
            if !dir.is_dir() {
                return Err(format!(
                    "working directory '{}' does not exist or is not a directory",
                    dir.display()
                ));
            }
            Some(dir)
        }
        None => default_cwd(),
    };
    state
        .spawn(
            SpawnParams {
                id,
                spec,
                cwd,
                cols,
                rows,
            },
            event_sink(app),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    state.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_exists(state: State<'_, PtyManager>, id: String) -> Result<bool, String> {
    Ok(state.exists(&id))
}

/// Read the working-tree status of the repository containing `path`. With
/// `path: None` we resolve the app's launch directory (`spawn::default_cwd`,
/// the same directory the bottom terminal opens in) — Part 3 ships without a
/// folder picker, so this is the sole repo source for now.
///
/// The `git` subprocess blocks, so it runs on the blocking pool rather than
/// stalling an async runtime worker (a git status on a large repo is not fast).
#[tauri::command]
pub async fn git_status(path: Option<String>) -> Result<GitStatus, String> {
    let start = match path {
        Some(p) => PathBuf::from(p),
        None => default_cwd()
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "could not determine a working directory".to_string())?,
    };
    tauri::async_runtime::spawn_blocking(move || git::status_from(&start))
        .await
        .map_err(|e| format!("git status task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Both sides of one file's diff: the HEAD revision and the working-tree file.
/// `orig_path` is the rename/copy origin from `git_status`, when there is one.
///
/// Like [`git_status`], the git subprocess and the file read block, so this
/// runs on the blocking pool.
#[tauri::command]
pub async fn git_file_diff(
    repo_root: String,
    path: String,
    orig_path: Option<String>,
) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff::file_diff(Path::new(&repo_root), &path, orig_path.as_deref())
    })
    .await
    .map_err(|e| format!("diff task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Write the diff window's edited buffer back to the working-tree file. The
/// buffer is LF-separated; `eol` is the file's own ending, returned by
/// [`git_file_diff`], so a save cannot silently rewrite every line.
#[tauri::command]
pub async fn write_working_file(
    repo_root: String,
    path: String,
    content: String,
    eol: Eol,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff::write_worktree_file(Path::new(&repo_root), &path, &content, eol)
    })
    .await
    .map_err(|e| format!("write task failed: {e}"))?
    .map_err(|e| e.to_string())
}

// --- Part 5: branch & remote operations ------------------------------------

/// Ids for the operation lock. Branch mutations are not addressable from the
/// frontend (nothing subscribes to them), so their id is only ever used to hold
/// and release the slot. Network ops get their id from the caller instead — see
/// [`git_remote_op`].
static OP_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_op_id(label: &str) -> String {
    format!("{label}-{}", OP_SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Run one mutating git operation on the blocking pool, holding the op lock for
/// its duration so it cannot interleave with another (a checkout racing a pull,
/// two switches from a double click).
async fn with_op_lock<T, F>(ops: &State<'_, GitOps>, label: &str, work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    let id = next_op_id(label);
    ops.begin(&id).map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(work).await;
    // Released whichever way the work went, or the app would wedge on the
    // first failure.
    ops.finish(&id);
    result
        .map_err(|e| format!("{label} task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Branch, upstream, ahead/behind and the branch lists, in one round trip.
/// A read, so it takes no lock — see `git::git_read_command` for why that is
/// safe while an operation is running.
#[tauri::command]
pub async fn git_branch_state(repo_root: String) -> Result<BranchState, String> {
    tauri::async_runtime::spawn_blocking(move || branch::branch_state(Path::new(&repo_root)))
        .await
        .map_err(|e| format!("branch state task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Switch branch, handling uncommitted changes per `policy` and restoring any
/// changes previously left on the target. One command, not several, so the
/// sequence cannot be interrupted midway.
#[tauri::command]
pub async fn git_switch_branch(
    ops: State<'_, GitOps>,
    repo_root: String,
    target: SwitchTarget,
    policy: DirtyPolicy,
) -> Result<SwitchOutcome, String> {
    with_op_lock(&ops, "switch", move || {
        branch::switch(Path::new(&repo_root), &target, policy)
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    ops: State<'_, GitOps>,
    repo_root: String,
    name: String,
    base: Option<String>,
) -> Result<(), String> {
    with_op_lock(&ops, "create-branch", move || {
        branch::create(Path::new(&repo_root), &name, base.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(
    ops: State<'_, GitOps>,
    repo_root: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    with_op_lock(&ops, "delete-branch", move || {
        branch::delete(Path::new(&repo_root), &name, force)
    })
    .await
}

#[tauri::command]
pub async fn git_rename_branch(
    ops: State<'_, GitOps>,
    repo_root: String,
    from: String,
    to: String,
) -> Result<(), String> {
    with_op_lock(&ops, "rename-branch", move || {
        branch::rename(Path::new(&repo_root), &from, &to)
    })
    .await
}

/// `None` when `name` is usable as a new branch, `Some(reason)` when it is not.
/// A rejected name is an answer, not an error, so this does not fail.
#[tauri::command]
pub async fn git_validate_branch_name(
    repo_root: String,
    name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        branch::validate_new_branch_name(Path::new(&repo_root), &name)
    })
    .await
    .map_err(|e| format!("validate branch name task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpDonePayload {
    exit_code: i32,
    /// Everything git said, on both pipes, verbatim. Never parsed.
    output: String,
    cancelled: bool,
}

/// Emit an operation's single terminal event and release the op slot. Called by
/// whichever side claimed the terminal event — the reader thread normally, the
/// canceller when the user cancels.
fn complete_op(app: &AppHandle, id: &str, payload: OpDonePayload) {
    // Emit failures only happen during webview teardown; ignore.
    let _ = app.emit(&format!("git://done/{id}"), payload);
    app.state::<GitOps>().finish(id);
}

/// Production event sink for a network op. Mirrors [`event_sink`]: per-id event
/// names, emit failures ignored.
fn op_event_sink(app: AppHandle) -> impl Fn(OpEvent) + Send + 'static {
    move |event| match event {
        OpEvent::Progress { id, line } => {
            let _ = app.emit(&format!("git://progress/{id}"), line);
        }
        OpEvent::Done {
            id,
            exit_code,
            output,
            cancelled,
        } => complete_op(
            &app,
            &id,
            OpDonePayload {
                exit_code,
                output,
                cancelled,
            },
        ),
    }
}

/// Start a fetch, pull or push. Returns as soon as the child is spawned;
/// progress arrives on `git://progress/<opId>` and the single terminal event on
/// `git://done/<opId>`.
///
/// `op_id` comes from the caller (like `pty_spawn`'s `id`) so the frontend can
/// subscribe *before* the op starts and cannot miss an early progress line.
#[tauri::command]
pub async fn git_remote_op(
    app: AppHandle,
    ops: State<'_, GitOps>,
    repo_root: String,
    op_id: String,
    spec: RemoteOpSpec,
) -> Result<(), String> {
    let lease = ops.begin(&op_id).map_err(|e| e.to_string())?;
    let label = spec.kind.as_str();
    let root = PathBuf::from(repo_root);
    let sink = op_event_sink(app.clone());

    // Spawning shells out (`git config core.sshCommand`) before it returns, so
    // it belongs on the blocking pool even though it does not wait for the op.
    let joined =
        tauri::async_runtime::spawn_blocking(move || remote::run(&root, &spec, lease, sink)).await;

    // The slot is normally released by whoever emits the terminal event. Both
    // failure paths below mean nobody ever will, so each releases it itself: a
    // leaked slot refuses every later fetch, pull, push, switch, create, delete
    // and rename until the app is restarted.
    let started = match joined {
        Ok(result) => result,
        // The blocking task panicked, or the runtime is shutting down.
        Err(join_error) => {
            ops.finish(&op_id);
            return Err(format!("git {label} task failed: {join_error}"));
        }
    };
    if let Err(error) = started {
        ops.finish(&op_id);
        return Err(error.to_string());
    }
    Ok(())
}

/// Cancel a running network op. Emitting the terminal event here (rather than
/// leaving it to the reader thread) is deliberate: git may have handed its
/// stderr pipe to an `ssh` child that survives the kill, so the reader can be
/// stuck on a pipe that never reaches EOF. The UI must not wait for it.
#[tauri::command]
pub async fn git_cancel_op(
    app: AppHandle,
    ops: State<'_, GitOps>,
    op_id: String,
) -> Result<(), String> {
    if ops.cancel(&op_id) {
        complete_op(
            &app,
            &op_id,
            OpDonePayload {
                exit_code: -1,
                output: String::new(),
                cancelled: true,
            },
        );
    }
    Ok(())
}

// --- Part 6: merge conflicts -----------------------------------------------

/// What the repository is in the middle of, for the banner above the file list.
/// A read, so it takes no lock.
#[tauri::command]
pub async fn git_merge_state(repo_root: String) -> Result<MergeState, String> {
    tauri::async_runtime::spawn_blocking(move || merge::merge_state(Path::new(&repo_root)))
        .await
        .map_err(|e| format!("merge state task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// One conflicted file: its lines, its conflicts, and the revision a resolution
/// has to quote back. A read.
#[tauri::command]
pub async fn git_conflict_file(repo_root: String, path: String) -> Result<ConflictFile, String> {
    tauri::async_runtime::spawn_blocking(move || merge::conflict_file(Path::new(&repo_root), &path))
        .await
        .map_err(|e| format!("conflict file task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Merge `reference` into the current branch. A conflict is a successful outcome
/// with `conflicted: true`, not an error — only a merge git refused fails.
#[tauri::command]
pub async fn git_merge(
    ops: State<'_, GitOps>,
    repo_root: String,
    reference: String,
) -> Result<MergeOutcome, String> {
    with_op_lock(&ops, "merge", move || {
        merge::merge(Path::new(&repo_root), &reference)
    })
    .await
}

#[tauri::command]
pub async fn git_merge_continue(ops: State<'_, GitOps>, repo_root: String) -> Result<(), String> {
    with_op_lock(&ops, "merge-continue", move || {
        merge::continue_merge(Path::new(&repo_root))
    })
    .await
}

#[tauri::command]
pub async fn git_merge_abort(ops: State<'_, GitOps>, repo_root: String) -> Result<(), String> {
    with_op_lock(&ops, "merge-abort", move || {
        merge::abort(Path::new(&repo_root))
    })
    .await
}

/// Apply one side of conflict `index` and stage the file if that was the last
/// one. Takes the op lock: it writes into the working tree, so it must not
/// interleave with a switch, a pull or another resolution.
#[tauri::command]
pub async fn git_resolve_conflict(
    ops: State<'_, GitOps>,
    repo_root: String,
    path: String,
    index: usize,
    choice: ConflictChoice,
    revision: String,
) -> Result<ResolveOutcome, String> {
    with_op_lock(&ops, "resolve-conflict", move || {
        merge::resolve_conflict(Path::new(&repo_root), &path, index, choice, &revision)
    })
    .await
}

/// Resolve a whole conflicted path, for the kinds with no merged text.
#[tauri::command]
pub async fn git_resolve_path(
    ops: State<'_, GitOps>,
    repo_root: String,
    path: String,
    resolution: PathResolution,
) -> Result<(), String> {
    with_op_lock(&ops, "resolve-path", move || {
        merge::resolve_path(Path::new(&repo_root), &path, resolution)
    })
    .await
}

/// (Re)start the debounced file watcher on `repo_root`; changes there emit
/// `repo://changed`, which the frontend answers by re-requesting `git_status`.
#[tauri::command]
pub async fn git_watch(
    app: AppHandle,
    watcher: State<'_, GitWatcher>,
    repo_root: String,
) -> Result<(), String> {
    watcher
        .watch(
            move || {
                // Emit failures only happen during webview teardown; ignore.
                let _ = app.emit("repo://changed", ());
            },
            Path::new(&repo_root),
        )
        .map_err(|e| e.to_string())
}
