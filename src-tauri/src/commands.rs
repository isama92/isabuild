//! Thin Tauri command layer over [`crate::pty`]. Commands are `async` so
//! blocking PTY writes stay off the main thread; they return `Result<_, String>`
//! with actionable messages for the frontend.

use tauri::{AppHandle, Emitter, State};

use crate::pty::{PtyEvent, PtyManager, SpawnParams};
use crate::spawn::{default_cwd, joined_command, shell_spec};

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
