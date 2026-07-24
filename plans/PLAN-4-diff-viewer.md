# Plan 4: Diff Viewer

## Goal
Clicking a file in the Status panel opens that file's diff in its **own OS window**, dedicated entirely to diff viewing — no main-area tab. JetBrains-style: two panes, the whole file, arrows in the middle gutter that restore a block, an editable right pane, and a colour-coded change map in the scrollbar.

Out of scope for this plan: an options/settings bar, a staged/unstaged toggle, staging individual hunks (right → left), and the merge editor (Parts 6–7).

## Decisions

| Decision | Choice |
|---|---|
| What is compared | Always **HEAD vs working tree**, for rows in both `Staged Changes` and `Changes`. Left header: short HEAD sha + repo-relative path. Right header: `Current version`. |
| Editing | The right pane is editable and **auto-saves** to the working-tree file, debounced 400 ms. No dirty marker. |
| Windows | **One window per file**, deduped by a label derived from the path: clicking the same file again focuses its window. |
| Middle arrows | **Left → right only**: restore a block from HEAD into the working file. The left pane is a git blob, so it is read-only. |
| External edits | The window **follows the file live** on `repo://changed`, guarded so neither our own auto-save echo nor in-flight typing is clobbered. |
| Closing | Esc, Cmd/Ctrl+W, or the OS controls. A pending save is flushed first. |

## Deliverables

### 1. Rust: `src-tauri/src/diff.rs`
`FileDiff { path, orig_path, head_sha, left, right, binary, eol }` plus:
- `head_short_sha` — `git rev-parse --short HEAD`; non-zero exit means an unborn HEAD, not an error.
- `blob_at_head` — `git cat-file blob HEAD:<path>` (plumbing, no smudge filters); non-zero exit means "not in HEAD" (new file). Reads the rename origin when there is one.
- `read_worktree_file` / `write_worktree_file` — through `resolve_read`/`resolve_write`, which reject `..`, absolute paths, and anything canonicalising outside the repo; writes additionally refuse symlinks and refuse to create a file.
- `looks_binary` — NUL in the first 8000 bytes (git's heuristic) or undecodable as UTF-8.
- `detect_eol` / `normalize_to_lf` / `apply_eol` — **the cross-platform crux**: with `core.autocrlf` the blob is LF and the checked-out file CRLF, which would otherwise render every line as changed. Both sides go to the frontend as LF; the detected EOL travels back on save.

### 2. Rust: commands, window scoping, capabilities
- `git_file_diff` and `write_working_file`, both on the blocking pool like `git_status`.
- `lib.rs`: `kill_all()` only when the closing window is `main` — a diff window's close must not kill Claude Code.
- `capabilities/diff.json` for `diff-*` (`core:default` + `close` + `destroy`); `default.json` gains `create-webview-window` + `set-focus`.

### 3. Frontend: second window
- `diff.html` + `src/diff-main.tsx` as a second Vite entry (`build.rollupOptions.input`), so the diff document never mounts the workspace Layout and never spawns a PTY.
- `lib/diffWindow.ts` — label (slug + FNV-1a hash of the path), URL, and open-or-focus.
- `lib/diffSource.ts` — the two invoke wrappers, the `FileDiff` type, and query-string parsing.
- `lib/diffMarkers.ts` — pure: Monaco line changes → marker ranges per side, plus the green/blue/red colours.
- `lib/diffSync.ts` — pure: `shouldAdoptDiskContent`, the guard that lets auto-save and live refresh coexist.
- `lib/diffLanguage.ts` — pure: pick a language from Monaco's own registry (longest extension, exact filenames first).

### 4. Frontend: the window
- `diff/monacoSetup.ts` — Monaco composed by hand: `editor/editor.api` + `features/register.all` + `basic-languages/monaco.contribution`. This deliberately excludes the four worker-backed language services, so the single core editor worker (which computes the diff) is the only one needed. Also defines the dark theme, which blanks Monaco's own two-colour diff ruler so our three-colour decorations are the only marks.
- `diff/DiffPane.tsx` — the sole Monaco boundary: `originalEditable: false`, `hideUnchangedRegions: { enabled: false }`, `renderMarginRevertIcon: true`, `renderGutterMenu: false`, `ignoreTrimWhitespace: false`, no minimap. Overview-ruler decorations from `diffMarkers`, and a `ResizeObserver` on the original editor so the header tracks the sash.
- `diff/DiffWindow.tsx` — load, headers, auto-save debounce, `repo://changed` refresh through the adopt guard, flush-then-destroy on close, Esc/Ctrl+W/Ctrl+S.
- `StatusPanel` rows become buttons that open (or focus) the file's window; failures surface in the panel.

## Acceptance criteria
- [ ] Clicking a changed file opens a window titled `Diff: <path>`; clicking it again focuses that window instead of opening a second.
- [ ] Both panes show the whole file including unchanged lines, with their own line numbers, and stay on the same lines when either is scrolled.
- [ ] Headers read `<short sha> <path>` and `Current version`, and follow the sash when it is dragged.
- [ ] A `»` arrow per changed block restores that block from HEAD; the change disappears from the diff and the file on disk is updated (~400 ms).
- [ ] Typing in the right pane reaches disk; the left pane refuses edits.
- [ ] The scrollbar shows green for added, blue for changed and red for removed lines, at the height of each change.
- [ ] An external edit (Claude Code, another editor) is picked up live, and never clobbers typing in progress.
- [ ] Untracked (`(new file)`), deleted (`(deleted)`, read-only), binary (message) and renamed (HEAD side from the origin path) files each render their state.
- [ ] Esc closes; a save queued at that moment still lands.
- [ ] Closing a diff window leaves Claude Code running; closing the main window leaves no orphan processes.
- [ ] A CRLF working-tree file against an LF blob shows only the real changes (verify on Windows).
- [ ] Verified on macOS, Linux and Windows.

## Risks specific to this part
- **Line endings** — see `detect_eol`; a whole-file phantom diff on Windows is the failure mode.
- **Auto-save vs the watcher** — our write re-enters as `repo://changed`; `shouldAdoptDiskContent` is what keeps that from overwriting the buffer.
- **Monaco packaging** — must be bundled locally, no CDN; the module worker has to load from Tauri's asset protocol in a release build, so check a real `tauri build`, not just dev.
- **Window-scoped teardown** — the pre-existing `kill_all()` on any window close would have killed Claude Code from a diff window.
