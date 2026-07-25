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

- [x] **Part 6 — Merge conflicts MVP** (`plans/PLAN-6-merge-conflicts-mvp.md`)
  Merge from a branch row in the branch menu, and a conflicted repo you can get out of without the shell. Conflicts get their own **Conflicts** group in the Status panel (carrying git's `u XY` kind) under a banner saying what is merging into what, how many are left, and offering Continue / Abort. A conflicted file opens its own `merge-<hash>` window: the whole file read-only, each conflict as a block with Accept ours / theirs / both, and the file staged automatically the moment its last marker goes. Conflicts with no text to merge — delete/modify, one-sided add, both-deleted, binary — take a whole-file decision instead. `--no-edit` and `GIT_EDITOR=true` throughout, so a merge commit can never sit waiting on an editor nobody can see. A conflicting pull and a stash that would not reapply land in the same UI; a rebase, cherry-pick or revert is named and left alone.

- [x] **Part 7 — Full 3-pane merge editor** (`plans/PLAN-7-three-pane-merge-editor.md`)
  JetBrains-style ours | result | theirs on CodeMirror 6, replacing Part 6's marker view. The chunk model is rebuilt from the index stages (`ls-files -u` + the blobs) rather than from the markers on disk, so a change only one side made is visible and reversible too, not just the regions git could not decide: non-conflicting changes arrive auto-applied, and every chunk has gutter arrows plus ours/theirs/both/base. The result pane is editable, undecided conflicts sit in it as real marker text, and the file writes itself once and stages the instant the last marker goes. A file edited since git wrote it is detected against `git merge-file`'s own output and the user chooses which version to open. Panes scroll in proportion, with next/previous conflict to move between them. And because the stages look the same for one, a **rebase, cherry-pick or revert is now driven** rather than just named — continue / skip / abort, with `--skip` behind a confirm that says the commit is dropped.

- [ ] **Part 8 — Polish & packaging**
  Themes, settings, keybindings, PTY cleanup on close, Tauri bundling and signing.

- [ ] **Part 9 — Retire Monaco: one editor stack**
  Replace Part 4's Monaco diff viewer with `@codemirror/merge`, leaving CodeMirror 6 as the only editor in the app.

  **Why this exists.** Part 7 brought CodeMirror in for the merge editor, so the app now ships *two* full editor stacks doing overlapping jobs: two syntax-highlighting registries, two theme definitions, two sets of test shims, two mental models. `@codemirror/merge`'s `MergeView` already covers most of what Part 4 needs — side-by-side panes, one editable side, built-in revert controls (Part 4's `»` restore-a-block arrow), intra-line highlighting — and it aligns the two documents with **spacer blocks**, which is strictly better than the proportional scroll sync Part 7 settled for.

  **Pros**
  - One editor stack and one highlighting source (`@codemirror/language-data`, already a dependency). `lib/diffLanguage.ts` and its Monaco-registry tests are deleted, and both windows highlight identically *by construction* instead of by coincidence.
  - Much smaller: `monaco-editor` is 101 MB in `node_modules` against 12 MB for all of CodeMirror and Lezer, with a correspondingly smaller shipped bundle. `diff/monacoSetup.ts`, the editor-worker wiring, and the `vite.config.ts` gymnastics that keep Monaco out of the main bundle all go with it.
  - Spacer-block alignment becomes available to the *merge* editor too, retiring Part 7's "the panes drift apart in a long file" limitation.
  - Removes the only path by which the `dompurify` advisory reaches this project.

  **Cons — the real cost; do not start without budgeting for these**
  - **CodeMirror has no overview ruler.** "Green for added, blue for changed, red for removed, at the height of each change" is a Part 4 acceptance criterion that Monaco gave us for free. It becomes our own widget (a positioned strip beside the scroller, heights from the chunk list) plus tests, and `lib/diffMarkers.ts` gets rewritten around CodeMirror chunks instead of Monaco's `getLineChanges()`.
  - **The diff moves onto the main thread.** Monaco computes it in the one worker it loads; `@codemirror/merge` computes it inline, so a few-thousand-line file may hitch when its window opens. **Measure this first** — if it is bad, the migration also needs a worker of our own and most of the simplification evaporates.
  - The draggable sash between the panes, and the `ResizeObserver` that keeps the headers tracking it, have to be rebuilt (probably *simpler* with `react-resizable-panels`, already a dependency).
  - Part 4's whole acceptance list needs re-verifying on all three OSes, including the auto-save and `shouldAdoptDiskContent` dance — subtle, and currently correct.

  **Do not do this for security.** The `dompurify` advisory that arrives with Monaco is closed on its own by a `"dompurify": "^3.4.12"` entry in `package.json`'s `overrides` (Monaco pins `3.4.8` exactly, which is why npm cannot lift it unaided). Its vulnerable paths are rendered-markdown sanitising for hovers and suggestion docs, and `monacoSetup.ts` already excludes the worker-backed language services that would produce any — so the exposure here is theoretical. Do this part for the one-stack simplification and the bundle size, or leave it undone.

## Global decisions

- Git operations shell out to the system `git` binary — inherits the user's SSH agent, credential helpers and hooks. Human-readable git output is never parsed.
- PTYs live in the Rust backend keyed by id; the frontend attaches and re-attaches. PTY lifetime is never tied to a React component.
- Claude Code manages its own subscription auth; the app just gives it a PTY.

