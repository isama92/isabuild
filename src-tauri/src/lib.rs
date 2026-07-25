pub mod branch;
mod commands;
pub mod diff;
pub mod fonts;
pub mod git;
pub mod gitops;
pub mod menu;
pub mod merge;
pub mod mergechunks;
pub mod project;
pub mod pty;
pub mod remote;
pub mod settings;
pub mod spawn;
#[cfg(test)]
pub mod testrepo;
pub mod watcher;

use gitops::GitOps;
use menu::MenuState;
use project::ActiveProject;
use pty::PtyManager;
use settings::SettingsStore;
use tauri::{AppHandle, Emitter as _, Manager as _};
use watcher::GitWatcher;

/// Label of the window declared in `tauri.conf.json`. Tauri defaults an
/// unnamed window to `main`; the diff windows are labelled `diff-<hash>`.
const MAIN_WINDOW_LABEL: &str = "main";

/// Close every window that is not the workspace.
///
/// Two callers, for the same reason: a `diff-*` or `merge-*` window auto-saves
/// into the project, so it must not outlive the workspace behind it (Tauri keeps
/// the process alive while any window is open) nor the project itself. `close`
/// rather than `destroy` so each one still flushes a pending save through its
/// own close handler.
pub(crate) fn close_secondary_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label != MAIN_WINDOW_LABEL {
            let _ = window.close();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(PtyManager::default());
            app.manage(GitWatcher::default());
            // Serialises mutating git operations and backs the Cancel button.
            app.manage(GitOps::default());
            // Which repository the workspace is looking at. Empty until the
            // welcome screen or a reopened `lastProject` fills it in, which is
            // why `git_status` and `pty_spawn` refuse to guess a directory.
            app.manage(ActiveProject::default());

            // `app_config_dir` is derived from the bundle identifier, so this is
            // ~/.config/com.isabuild.desktop on Linux, ~/Library/Application
            // Support/... on macOS and %APPDATA%\... on Windows. A settings file
            // we cannot even find a home for is not worth refusing to start
            // over: fall back to a path beside the executable's cwd.
            let config_path = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join(settings::FILE_NAME);
            app.manage(SettingsStore::load_from(config_path));

            // The menu is built here with an empty project so the window has one
            // from the first frame. `bootstrap` asks again with the real
            // recents; if there are none, that second call is a no-op rather
            // than a second menubar swap.
            app.manage(MenuState::default());
            if let Err(err) = app.state::<MenuState>().refresh(app.handle(), &[], false) {
                eprintln!("could not build the application menu: {err}");
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(action) = menu::action_for(event.id().as_ref()) else {
                return;
            };
            if action == menu::MenuAction::Quit {
                app.exit(0);
                return;
            }
            // Everything else is driven by the frontend: it owns the confirm
            // dialog, the error banner and the workspace swap. The menu only
            // says what was clicked.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.emit(
                    "menu://action",
                    match action {
                        menu::MenuAction::OpenFolder => {
                            serde_json::json!({ "action": "open-folder" })
                        }
                        menu::MenuAction::CloseProject => {
                            serde_json::json!({ "action": "close-project" })
                        }
                        menu::MenuAction::Settings => serde_json::json!({ "action": "settings" }),
                        menu::MenuAction::OpenRecent(index) => {
                            serde_json::json!({ "action": "open-recent", "index": index })
                        }
                        menu::MenuAction::Quit => unreachable!("handled above"),
                    },
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_exists,
            commands::git_status,
            commands::git_watch,
            commands::git_file_diff,
            commands::write_working_file,
            commands::git_branch_state,
            commands::git_switch_branch,
            commands::git_create_branch,
            commands::git_delete_branch,
            commands::git_rename_branch,
            commands::git_validate_branch_name,
            commands::git_remote_op,
            commands::git_cancel_op,
            commands::git_merge_state,
            commands::git_conflict_stages,
            commands::git_merge,
            commands::git_op,
            commands::git_write_resolved,
            commands::git_resolve_path,
            commands::bootstrap,
            commands::settings_get,
            commands::settings_update,
            commands::list_fonts,
            commands::pick_folder,
            commands::project_open,
            commands::project_close,
            commands::project_current,
            commands::recent_projects,
            commands::recent_remove
        ])
        .on_window_event(|window, event| {
            // Only the main window owns the PTY sessions. Diff windows
            // (label `diff-*`, opened per file in Part 4) come and go while
            // Claude Code keeps running, so their close must not touch them.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() != MAIN_WINDOW_LABEL {
                    return;
                }
                let app = window.app_handle();
                app.state::<PtyManager>().kill_all();
                close_secondary_windows(app);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Covers exits that never fire CloseRequested (macOS Cmd+Q).
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyManager>().kill_all();
            }
        });
}
