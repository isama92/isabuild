mod commands;
pub mod diff;
pub mod git;
pub mod pty;
pub mod spawn;
pub mod watcher;

use pty::PtyManager;
use tauri::Manager as _;
use watcher::GitWatcher;

/// Label of the window declared in `tauri.conf.json`. Tauri defaults an
/// unnamed window to `main`; the diff windows are labelled `diff-<hash>`.
const MAIN_WINDOW_LABEL: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(PtyManager::default());
            app.manage(GitWatcher::default());
            Ok(())
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
            commands::write_working_file
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
                // Closing the workspace has to take the diff windows with it:
                // Tauri keeps the process alive while any window is open, which
                // would otherwise leave editors auto-saving to disk with no
                // workspace behind them. `close` (not `destroy`) so each one
                // still flushes a pending save through its own close handler.
                for (label, other) in app.webview_windows() {
                    if label != MAIN_WINDOW_LABEL {
                        let _ = other.close();
                    }
                }
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
