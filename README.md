# isabuild

[![CI](https://github.com/isama92/isabuild/actions/workflows/ci.yml/badge.svg)](https://github.com/isama92/isabuild/actions/workflows/ci.yml) [![Cross-OS tests](https://github.com/isama92/isabuild/actions/workflows/cross-os.yml/badge.svg)](https://github.com/isama92/isabuild/actions/workflows/cross-os.yml)

A cross-platform desktop app (macOS, Linux, Windows) that embeds Claude Code in a terminal and wraps it with live git tooling: a real-time changed-files panel, diff viewer, branch/remote operations, and a graphical 3-pane merge conflict resolver.

## Stack

- **Shell**: Tauri 2 (Rust backend)
- **Frontend**: React 18 + TypeScript + Vite, Zustand, react-resizable-panels
- **Terminals**: xterm.js + `portable-pty` (ConPTY on Windows)
- **Git**: system `git` binary via subprocess (porcelain/plumbing output only)
- **Diff viewer**: Monaco Editor · **Merge editor**: CodeMirror 6

## Development

```bash
npm install
npm run tauri dev      # run the app in dev mode
npm run tauri build    # produce release bundles (DMG / AppImage+deb / MSI)
cargo test --manifest-path src-tauri/Cargo.toml   # backend tests
npm test               # frontend tests (vitest)
```

Prerequisites: Rust stable, Node 20+, system `git` **2.23 or newer** (branch switching uses `git switch`), and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed. On Windows, Git for Windows is required.

## Roadmap

Each part is an independent plan (see `plans/`), executed in order. A part is done only when its acceptance criteria pass on macOS, Linux and Windows. Tick the box when a part is completed.

- [x] **Part 1 — Claude Code terminal panel** (`plans/PLAN-1-claude-code-panel.md`)
  Tauri scaffold + PTY infrastructure + xterm.js terminal running Claude Code. Foundation for every later terminal.

- [x] **Part 2 — Layout shell + bottom terminal**
  IDE-style resizable regions (split panes, not browser tabs): a large main area running Claude Code above a collapsible bottom strip running the user's login shell (reuses the Part 1 PTY manager), so both are usable at once. Hide or show the terminal with its close button, the status-bar toggle, or Alt+1; an exiting shell closes the region too.

- [x] **Part 3 — Git status panel**
  Adds the resizable sidebar region and fills it: repo picker, `git status --porcelain=v2 -z` parsing, colored file list (green added, yellow modified, red deleted), debounced file watcher for live refresh.

- [x] **Part 4 — Diff viewer** (`plans/PLAN-4-diff-viewer.md`)
  Click a file in the Status panel → its own window, dedicated to the diff: HEAD (short sha) beside the working tree ("Current version"), whole file including unchanged lines, synchronised scrolling, `»` arrows that restore a block from HEAD, an editable right pane that auto-saves, green/blue/red change marks in the scrollbar, and rename/binary/untracked/deleted handling. No options bar yet.

- [x] **Part 5 — Branch & remote operations** (`plans/PLAN-5-branch-remote-operations.md`)
  GitHub Desktop-style branch management from the status bar's right cluster: current branch, `↑ahead ↓behind` against the upstream, and Fetch / Pull / Push (reading "Publish branch" when there is no upstream). The branch menu opens upward with a filter, locals before remote-only branches, per-row rename/delete, and New branch (name + base). Switching with uncommitted changes asks Bring or Leave; Leave stashes under a marker and returning to that branch restores it with staging intact. Network ops stream git's own progress, can be cancelled, run one at a time, and surface a failure as a modal with git's verbatim output, Copy, and Retry in terminal.

- [ ] **Part 6 — Merge conflicts MVP**
  Merge command, conflict detection, conflicted-file markers, per-conflict Accept ours / theirs / both, resolve → `git add`, merge continue/abort.

- [ ] **Part 7 — Full 3-pane merge editor**
  JetBrains-style ours | result | theirs on CodeMirror 6: chunk model from `git show :1: :2: :3:`, arrow gutters, scroll sync, auto-apply of non-conflicting changes.

- [ ] **Part 8 — Polish & packaging**
  Themes, settings, keybindings, PTY cleanup on close, Tauri bundling and signing.

## Global decisions

- Git operations shell out to the system `git` binary — inherits the user's SSH agent, credential helpers and hooks. Human-readable git output is never parsed.
- PTYs live in the Rust backend keyed by id; the frontend attaches and re-attaches. PTY lifetime is never tied to a React component.
- Claude Code manages its own subscription auth; the app just gives it a PTY.

