pub mod branch;
mod commands;
pub mod diff;
pub mod files;
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
pub mod watchfilter;
pub mod watchtree;

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

/// Prefix of the diff window's atomic-save temp file, which lands in the target's
/// own directory so the rename cannot cross a filesystem.
///
/// Named in three places, hence the shared constant: where it is created
/// (`diff::write_worktree_file`), where the watcher drops its events
/// (`watchfilter`), and where a status read that caught it mid-write drops the
/// phantom untracked row (`git::parse_porcelain_v2`).
pub(crate) const SAVE_TEMP_PREFIX: &str = ".isabuild-save-";

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
            let store = SettingsStore::load_from(config_path);

            // Built from the settings just loaded, not from an empty list. The
            // window then has the right menu on its first frame, and — because
            // `MenuState` skips an install whose signature is unchanged —
            // `bootstrap`'s own refresh is a no-op rather than a second menubar
            // swap on every launch. (GTK logs a warning for each accelerator it
            // moves, so the swap was visible in the console as well as on
            // screen.)
            //
            // `last_project.is_some()` is a *prediction* of the open state: the
            // project usually reopens, and when it does not, bootstrap corrects
            // the menu with the one swap that case deserves.
            let settings = store.get();
            let predicted_open = settings.last_project.is_some();
            app.manage(store);

            app.manage(MenuState::default());
            if let Err(err) = app.state::<MenuState>().refresh(
                app.handle(),
                &settings.recent_projects,
                predicted_open,
            ) {
                eprintln!("could not build the application menu: {err}");
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(action) = menu::action_for(event.id().as_ref()) else {
                return;
            };
            if action == menu::MenuAction::Quit {
                // Closed, not `app.exit(0)`. Exiting fires neither
                // `CloseRequested` nor a close on the other windows, and a diff
                // or merge window's close handler is where a pending save is
                // flushed — so quitting from the menu with an edit inside the
                // debounce window would drop it. Closing the main window runs
                // exactly the path the window's own X button does: kill the
                // PTYs, close the secondary windows (each flushing on the way
                // out), and let Tauri exit once none are left.
                match app.get_webview_window(MAIN_WINDOW_LABEL) {
                    Some(window) => {
                        let _ = window.close();
                    }
                    // No workspace to close: nothing can be holding a save.
                    None => app.exit(0),
                }
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
            commands::git_stage_path,
            commands::git_unstage_path,
            commands::git_rollback_path,
            commands::git_commit_path,
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

#[cfg(test)]
mod tests {
    /// `tauri.conf.json` deliberately carries no `version` key, so Tauri falls
    /// back to `src-tauri/Cargo.toml` — the one file release-please bumps.
    ///
    /// Fails if anyone re-adds a hardcoded version to the config: two sources of
    /// truth drift silently, and the symptom surfaces late and confusingly as an
    /// installer whose filename disagrees with the version the app reports.
    ///
    /// Skipped on macOS: there `generate_context!()` also emits a
    /// `#[link_section = "__TEXT,__info_plist"]` static, and `run()` already
    /// expands the macro in this crate — a second expansion defines
    /// `_EMBED_INFO_PLIST` twice and the lib test fails to *compile*. The
    /// invariant is platform-independent, so Linux (every PR) and Windows cover
    /// it. Do not "fix" this by dropping the cfg.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn app_version_comes_from_the_cargo_manifest() {
        // Annotated because `Context` is generic over the runtime, which only
        // `Builder::default()` infers for us in `run()`.
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        assert_eq!(
            context.package_info().version.to_string(),
            env!("CARGO_PKG_VERSION")
        );
    }

    /// release-please bumps `src-tauri/Cargo.toml` through a *generic* TOML
    /// updater, and a JSONPath that stops matching does not fail the release:
    /// `GenericToml` logs a warning and returns the file unchanged. On its own
    /// that would tag a version and ship installers built from the old one, with
    /// every workflow green.
    ///
    /// `package.json` is bumped by a different, native updater, so comparing the
    /// two catches the silent no-op. Anything that restructures `[package]`
    /// (a rename, `version.workspace = true`, a move into a real workspace)
    /// fails here rather than in a published release.
    #[test]
    fn package_json_version_matches_the_cargo_manifest() {
        let package_json: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json"))
                .expect("package.json is valid JSON");
        assert_eq!(
            package_json["version"]
                .as_str()
                .expect("package.json has a string version"),
            env!("CARGO_PKG_VERSION"),
            "package.json and src-tauri/Cargo.toml disagree: release-please's \
             Cargo.toml updater may have silently stopped matching"
        );
    }
}
