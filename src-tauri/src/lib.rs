mod commands;
pub mod git;
pub mod pty;
pub mod spawn;
pub mod watcher;

use pty::PtyManager;
use tauri::Manager as _;
use watcher::GitWatcher;

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
            commands::git_watch
        ])
        .on_window_event(|window, event| {
            // Single-window app: closing it tears down every session. Once a
            // later part adds more windows, this must become per-window.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().state::<PtyManager>().kill_all();
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
