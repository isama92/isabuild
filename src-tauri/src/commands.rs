//! Thin Tauri command layer over [`crate::pty`]. Commands are `async` so
//! blocking PTY writes stay off the main thread; they return `Result<_, String>`
//! with actionable messages for the frontend.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager as _, State};

use crate::branch::{self, BranchState, DirtyPolicy, SwitchOutcome, SwitchTarget};
use crate::diff::{self, Eol, FileDiff};
use crate::fonts::{self, FontFamily};
use crate::git::{self, GitError, GitStatus};
use crate::gitops::GitOps;
use crate::menu::MenuState;
use crate::merge::{
    self, ConflictStages, MergeOutcome, MergeState, OpAction, PathResolution, ResolveOutcome,
};
use crate::project::{self, ActiveProject, Project, RecentProject, RecentState};
use crate::pty::{PtyEvent, PtyManager, SpawnParams};
use crate::remote::{self, OpEvent, RemoteOpSpec};
use crate::settings::{Settings, SettingsPatch, SettingsStore};
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
///
/// `cwd: None` means "the open project", which is how both workspace terminals
/// call it. Since Part 8 the frontend only mounts them once a project is open,
/// so no project is a bug rather than a state to guess a directory for.
// The arg list mirrors the frontend invoke payload 1:1; grouping into a
// struct would only move the count into JSON nesting.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    active: State<'_, ActiveProject>,
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
        None => Some(
            active
                .repo_root()
                .ok_or_else(|| "cannot start a terminal: no project is open".to_string())?,
        ),
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
/// `path: None` we use the open project, which is also what both terminals are
/// started in, so the panel and the shells can never disagree about the repo.
///
/// The `git` subprocess blocks, so it runs on the blocking pool rather than
/// stalling an async runtime worker (a git status on a large repo is not fast).
#[tauri::command]
pub async fn git_status(
    active: State<'_, ActiveProject>,
    path: Option<String>,
) -> Result<GitStatus, String> {
    let open = active.repo_root();
    // Skip discovery only where the root is provably one already: the open project's
    // own, or the value a previous call returned, which the frontend echoes back on
    // every refresh after the first.
    //
    // The comparison is what makes that safe. `run_status` reports whatever root it
    // was handed, so trusting `path` blindly would let a *subdirectory* come back as
    // `repoRoot`, and the frontend stores that and then uses it for every diff, merge,
    // branch and remote operation afterwards. Not a trade worth one process.
    let (start, resolved) = match path {
        Some(p) => {
            let p = PathBuf::from(p);
            let known = open.as_deref() == Some(p.as_path());
            (p, known)
        }
        None => (open.ok_or_else(|| "no project is open".to_string())?, true),
    };
    tauri::async_runtime::spawn_blocking(move || {
        if resolved {
            git::status_at(&start)
        } else {
            git::status_from(&start)
        }
    })
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

/// One conflicted file for the three-pane editor: its index stages, the chunks
/// between them, the buffer to open with, and the revision a write has to quote
/// back. A read.
#[tauri::command]
pub async fn git_conflict_stages(
    repo_root: String,
    path: String,
) -> Result<ConflictStages, String> {
    tauri::async_runtime::spawn_blocking(move || {
        merge::conflict_stages(Path::new(&repo_root), &path)
    })
    .await
    .map_err(|e| format!("conflict stages task failed: {e}"))?
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

/// Continue, skip or abort whatever is in progress — a merge, a rebase, a
/// cherry-pick or a revert. The argv follows from the state `merge::run_op` reads
/// for itself, not from anything the frontend believes.
#[tauri::command]
pub async fn git_op(
    ops: State<'_, GitOps>,
    repo_root: String,
    action: OpAction,
) -> Result<(), String> {
    with_op_lock(&ops, "git-op", move || {
        merge::run_op(Path::new(&repo_root), action)
    })
    .await
}

/// Write a fully resolved file and stage it. Takes the op lock: it writes into
/// the working tree, so it must not interleave with a switch, a pull or another
/// resolution.
#[tauri::command]
pub async fn git_write_resolved(
    ops: State<'_, GitOps>,
    repo_root: String,
    path: String,
    text: String,
    revision: String,
) -> Result<ResolveOutcome, String> {
    with_op_lock(&ops, "write-resolved", move || {
        merge::write_resolved(Path::new(&repo_root), &path, &text, &revision)
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

// --- Part 8: settings, the open project and the menu ------------------------

/// Everything the frontend needs before it can draw anything, in one round trip:
/// which project to reopen, what the recents are, and whether the settings file
/// on disk was readable.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub settings: Settings,
    pub recents: Vec<RecentProject>,
    /// The reopened project, or `None` for the welcome screen.
    pub project: Option<Project>,
    /// Why `last_project` did not reopen, if it did not.
    pub project_error: Option<String>,
    /// Why the settings on disk were replaced by defaults, if they were.
    pub settings_warning: Option<String>,
    /// The directory the app was launched from, when it is a repo that is not
    /// already the open project. The welcome screen offers it as one click, so
    /// `npm run tauri dev` from a checkout still lands in that checkout.
    pub launch_folder: Option<RecentProject>,
}

/// Emit the settings to every window and bring the menu up to date. Called
/// after any change to something either of them shows.
///
/// The menu only reinstalls when what it *displays* changed (see
/// `MenuState::refresh`), so a font or theme save does not replace it.
fn broadcast(app: &AppHandle, settings: &Settings, project_open: bool) {
    // Emit failures only happen during teardown; ignore.
    let _ = app.emit("settings://changed", settings);
    if let Err(err) = app
        .state::<MenuState>()
        .refresh(app, &settings.recent_projects, project_open)
    {
        // A menu that failed to rebuild is stale, not fatal: it still opens the
        // previous set of recents, all of which still work.
        eprintln!("could not rebuild the application menu: {err}");
    }
}

#[tauri::command]
pub async fn bootstrap(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    active: State<'_, ActiveProject>,
) -> Result<Bootstrap, String> {
    let settings = store.get();

    // Reopening is best-effort: a project that has been deleted or is no longer
    // a repo puts the user on the welcome screen with the reason, rather than
    // failing the whole startup.
    let (project, project_error) = match &settings.last_project {
        Some(path) => {
            let path = path.clone();
            match tauri::async_runtime::spawn_blocking(move || project::open(&path))
                .await
                .map_err(|e| format!("open project task failed: {e}"))?
            {
                Ok(project) => {
                    active.set(project.clone());
                    (Some(project), None)
                }
                Err(err) => (None, Some(err.to_string())),
            }
        }
        None => (None, None),
    };

    let launch_folder = match project {
        Some(_) => None,
        None => tauri::async_runtime::spawn_blocking(default_launch_folder)
            .await
            .map_err(|e| format!("launch folder task failed: {e}"))?,
    };

    let recents = project::describe(&settings.recent_projects);
    if let Err(err) =
        app.state::<MenuState>()
            .refresh(&app, &settings.recent_projects, project.is_some())
    {
        eprintln!("could not build the application menu: {err}");
    }

    Ok(Bootstrap {
        settings_warning: store.warning().map(str::to_string),
        settings,
        recents,
        project,
        project_error,
        launch_folder,
    })
}

/// The repository the app was launched from, if it was launched from one.
/// Blocking: runs `git`.
///
/// Reported as the *repo root*, not the launch directory, so the welcome screen
/// can compare it to a recents entry by string: launching from a subdirectory
/// would otherwise offer a row duplicating one already in the list, and on
/// Windows git's forward slashes would never match the process cwd's
/// backslashes.
fn default_launch_folder() -> Option<RecentProject> {
    let root = project::repo_root_of(&default_cwd()?)?;
    let path = root.to_string_lossy().into_owned();
    Some(RecentProject {
        name: project::folder_name(&path),
        path,
        state: RecentState::Ok,
    })
}

#[tauri::command]
pub async fn settings_get(store: State<'_, SettingsStore>) -> Result<Settings, String> {
    Ok(store.get())
}

/// Apply a partial change and persist it. The saved settings are returned to the
/// caller *and* broadcast, so a window that changed nothing still repaints.
#[tauri::command]
pub async fn settings_update(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    active: State<'_, ActiveProject>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    let settings = store
        .update(|current| current.apply(patch))
        .map_err(|e| e.to_string())?;
    broadcast(&app, &settings, active.get().is_some());
    Ok(settings)
}

/// Installed font families. Blocking (it parses every font file), so it runs on
/// the blocking pool; the result is cached for the life of the process.
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFamily>, String> {
    tauri::async_runtime::spawn_blocking(|| fonts::families().to_vec())
        .await
        .map_err(|e| format!("font scan task failed: {e}"))
}

/// Native folder picker. `None` means the user cancelled.
///
/// Driven from Rust rather than the JS dialog API so no window needs a dialog
/// capability. The command is `async`, so it runs off the main thread, which is
/// what `blocking_pick_folder` requires.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt as _;

    let picked = app.dialog().file().blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("could not read the chosen folder: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Open `path` as the project: validate it, make it the active project, and
/// remember it as the one to reopen next launch.
///
/// The caller is the frontend, which swaps the workspace only once this resolves
/// — so by the time the new Layout mounts, `git_status` and `pty_spawn` already
/// answer for the new repo.
#[tauri::command]
pub async fn project_open(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    active: State<'_, ActiveProject>,
    pty: State<'_, PtyManager>,
    watcher: State<'_, GitWatcher>,
    path: String,
) -> Result<Project, String> {
    let project = tauri::async_runtime::spawn_blocking(move || project::open(&path))
        .await
        .map_err(|e| format!("open project task failed: {e}"))?
        .map_err(|e| e.to_string())?;

    // Persist BEFORE tearing anything down. `update` writes to disk and can
    // fail (a read-only config directory, a full disk); failing after the
    // teardown would leave a mounted workspace whose PTYs are dead, whose
    // watcher is stopped, and whose git reads answer for a different repo.
    // Nothing here has changed yet, so the caller's error path is honest.
    let settings = store
        .update(|current| {
            current.push_recent(&project.repo_root);
            current.last_project = Some(project.repo_root.clone());
        })
        .map_err(|e| e.to_string())?;

    // Switching projects is a close plus an open: the running Claude Code and
    // shell are rooted in the old directory and cannot follow.
    if active
        .get()
        .is_some_and(|current| current.repo_root != project.repo_root)
    {
        teardown_workspace(&app, &pty, &watcher);
    }

    active.set(project.clone());
    broadcast(&app, &settings, true);
    Ok(project)
}

/// Return to the welcome screen: stop everything rooted in the project, and
/// forget it so the next launch does not reopen it.
#[tauri::command]
pub async fn project_close(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    active: State<'_, ActiveProject>,
    pty: State<'_, PtyManager>,
    watcher: State<'_, GitWatcher>,
) -> Result<(), String> {
    // Persisted first, for the reason in `project_open`: a failed write here
    // must leave a working workspace, not a dead one.
    let settings = store
        .update(|current| current.last_project = None)
        .map_err(|e| e.to_string())?;

    teardown_workspace(&app, &pty, &watcher);
    active.clear();
    broadcast(&app, &settings, false);
    Ok(())
}

/// Stop everything rooted in the project that is going away.
///
/// The PTY kill deliberately does *not* live in a React cleanup: CLAUDE.md's
/// rule is that unmounting a component never kills a PTY (that is what makes
/// dev HMR survivable), and this is an explicit user action instead. Diff and
/// merge windows go with it because they auto-save into a repo that is about to
/// stop being the project; `close` (not `destroy`) so each still flushes. And
/// the watcher stops rather than being left to be replaced by the next
/// `git_watch`: `useRepoWatch` swallows a failed re-arm, which would otherwise
/// leave the old project's watch firing `repo://changed` at the new one.
fn teardown_workspace(app: &AppHandle, pty: &PtyManager, watcher: &GitWatcher) {
    pty.kill_all();
    watcher.stop();
    crate::close_secondary_windows(app);
}

#[tauri::command]
pub async fn project_current(active: State<'_, ActiveProject>) -> Result<Option<Project>, String> {
    Ok(active.get())
}

#[tauri::command]
pub async fn recent_projects(
    store: State<'_, SettingsStore>,
) -> Result<Vec<RecentProject>, String> {
    Ok(project::describe(&store.get().recent_projects))
}

/// Forget one recent project. Only touches the list: the folder is left alone.
#[tauri::command]
pub async fn recent_remove(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    active: State<'_, ActiveProject>,
    path: String,
) -> Result<Vec<RecentProject>, String> {
    let settings = store
        .update(|current| {
            current.remove_recent(&path);
            // A project removed from the list should not come back at the next
            // launch either. Compared with `settings::same_path`, the same way
            // the list itself is: two comparisons that can drift apart would
            // eventually remove the row and still reopen it.
            if current.last_project_is(&path) {
                current.last_project = None;
            }
        })
        .map_err(|e| e.to_string())?;
    broadcast(&app, &settings, active.get().is_some());
    Ok(project::describe(&settings.recent_projects))
}
