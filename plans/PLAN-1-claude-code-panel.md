# Plan 1: Claude Code Terminal Panel

## Goal
A minimal Tauri 2 desktop app whose entire window is a terminal running Claude Code, fully interactive, on macOS, Linux and Windows. This establishes the project scaffold and the PTY infrastructure that every later part reuses.

Out of scope for this plan: git anything, panel layout, bottom terminal, tabs. One window, one terminal.

## Stack for this part
- Tauri 2, Rust stable
- React 18 + TypeScript + Vite
- `portable-pty` crate (PTY abstraction, ConPTY on Windows)
- `@xterm/xterm` + `@xterm/addon-fit` (+ `@xterm/addon-webgl` optional)

## Deliverables

### 1. Project scaffold
- `npm create tauri-app` (React + TS + Vite template) or equivalent manual setup.
- Repo layout: `src/` (frontend), `src-tauri/` (Rust).
- Dev command (`npm run tauri dev`) and release build working.

### 2. Rust: PTY manager (`src-tauri/src/pty.rs`)
Design it generic from day one — later parts spawn shells with it too.

State: `HashMap<String, PtySession>` behind a `Mutex`, held in Tauri managed state. A `PtySession` owns the PTY master, the child handle, and the writer.

Tauri commands:
- `pty_spawn(id: String, cmd: Option<String>, args: Vec<String>, cwd: Option<String>, cols: u16, rows: u16)`
  - Default `cmd`: the user's login shell (`$SHELL` on Unix, `powershell.exe` or detected Git Bash on Windows). For this plan the frontend will pass `claude` — but see "spawn strategy" below.
  - Spawns a reader thread: reads PTY output in chunks, emits Tauri event `pty://output/{id}` with the bytes (base64-encode to survive JSON safely).
  - On child exit, emit `pty://exit/{id}` with the exit code.
- `pty_write(id, data: String)` — base64-decoded, written to the PTY.
- `pty_resize(id, cols, rows)`.
- `pty_kill(id)` — kill child, drop session.
- On app exit / window destroy: kill all sessions (hook Tauri's `on_window_event` close).

Spawn strategy for Claude Code:
- Preferred: spawn the user's interactive shell with `claude` as the command (`$SHELL -ilc claude` on Unix) so PATH, nvm/asdf shims and environment resolve exactly like the user's terminal. Spawning the `claude` binary directly often fails because GUI apps don't inherit the shell's PATH.
- Windows: run via Git Bash if present (`bash.exe -ilc claude`), else PowerShell. If `claude` isn't found, the PTY will show the shell's own error — additionally detect this case and render a friendly hint (install instructions link).
- Claude Code handles its own subscription auth (stored in the user's home directory); nothing to do in the app.

### 3. Frontend: terminal component (`src/components/TerminalView.tsx`)
- Instantiate `Terminal` from xterm.js with a sensible theme and font; `open()` into a full-window div.
- FitAddon: fit on mount and on window resize (ResizeObserver), then call `pty_resize` with the new cols/rows.
- Listen to `pty://output/{id}`, decode base64, `terminal.write(bytes)`.
- `terminal.onData` → `pty_write(id, base64(data))`.
- On `pty://exit/{id}`: show an overlay with the exit code and a "Restart Claude Code" button (respawn with the same id).
- Critical rule: the PTY id and lifecycle live outside React. On component unmount (e.g. HMR in dev), detach listeners only — do NOT kill the PTY. On remount, re-attach to the existing session. Add a `pty_exists(id)` command to support this.
- One hardcoded session id for now: `"claude-main"`.

### 4. App shell (`src/App.tsx`)
- Full-viewport TerminalView, dark background, no chrome beyond the native window.
- Spawn `claude-main` on first mount if it doesn't exist.

## Acceptance criteria
- [ ] `npm run tauri dev` opens a window that boots into Claude Code.
- [ ] Full TUI interactivity: typing, arrow keys, Enter, Ctrl+C, slash commands, colors, cursor rendering all correct.
- [ ] Resizing the window reflows Claude Code correctly (no garbled redraw).
- [ ] Closing the window terminates the child process (no orphan `claude` processes).
- [ ] Quitting Claude Code (`/exit`) shows the exit overlay; restart button works.
- [ ] In dev, a frontend hot-reload re-attaches to the running Claude Code session without restarting it.
- [ ] If `claude` is not installed, a readable message with install guidance appears instead of a dead window.
- [ ] Verified on macOS, Linux and Windows (Windows: with Git for Windows installed).

## Risks specific to this part
- **PATH resolution in GUI apps** — mitigated by the login-shell spawn strategy; test on macOS especially (apps launched from Finder get a minimal environment).
- **Windows ConPTY resize glitches** — resize through portable-pty only, debounce resize events (~100 ms).
- **Event throughput** — Claude Code can emit bursts of output; batch PTY reads (e.g. 4–8 KB buffers) rather than emitting per-byte events. If rendering lags, enable the WebGL addon.

## Definition of done
All acceptance criteria checked on all three OSes; PTY manager API documented in a short `src-tauri/src/pty.rs` module doc comment, since Parts 2+ build on it unchanged.
