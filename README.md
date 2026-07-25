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

### Settings

Settings live in one JSON file, in the OS's own config directory:

| OS | Path |
|---|---|
| Linux | `~/.config/com.isabuild.desktop/config.json` |
| macOS | `~/Library/Application Support/com.isabuild.desktop/config.json` |
| Windows | `%APPDATA%\com.isabuild.desktop\config.json` |

It holds the theme, the monospace font and size, keybinding overrides, and the recent
projects. Every field is optional, so it is safe to hand-edit down to the one key you care
about. A file that cannot be parsed is renamed to `config.json.bak` rather than overwritten,
and the app starts from defaults and says so. Deleting the file resets everything.

### Installing a build

Every release carries prebuilt installers, so no toolchain is needed to run the app —
grab one from the [Releases page](https://github.com/isama92/isabuild/releases):

| OS | Asset |
|---|---|
| Linux | `.deb`, `.rpm` (both declare `git`), or `.AppImage` |
| Windows | `*-setup.exe` (NSIS, per-user) |
| macOS | `*_universal.dmg` (Intel and Apple Silicon) |

Each asset ships a matching `.sha256`. To install the deb, prefer `apt` over `dpkg -i` so
the `git` dependency resolves: `sudo apt install ./isabuild_<version>_amd64.deb`.

`npm run tauri build`, the **Bundle installers** workflow and the released installers are
all **unsigned**. They install and run, but the OS will say it cannot verify them:

- **macOS**: Gatekeeper refuses the first launch. Right-click the app and choose Open, or
  System Settings → Privacy & Security → Open Anyway.
- **Windows**: SmartScreen shows "Windows protected your PC". More info → Run anyway. The
  NSIS installer installs per-user, so it needs no administrator prompt.
- **Linux**: the `.deb` and `.rpm` declare `git` as a dependency; the AppImage does not, so
  make sure `git` is on `PATH`.

Signing and notarisation are deliberately out of scope; they need certificates that are not
in this repository.

### Releases

Versioning and releases are automated by [release-plz](https://release-plz.dev), driven by
Conventional Commit PR titles. Nobody edits a version by hand.

1. A PR merges to `main`. Because PRs are squash-merged, its `feat:`/`fix:`/… title becomes
   the commit release-plz reads to pick the next version.
2. `release-plz.yml` opens a `chore: release X.Y.Z` PR bumping `src-tauri/Cargo.toml`,
   `src-tauri/Cargo.lock`, `CHANGELOG.md` and the npm pair. Review it like any other PR.
3. Merging it tags `vX.Y.Z` and publishes the GitHub release, which triggers `release.yml`
   to build the installers above and attach them.

`src-tauri/Cargo.toml` is the single source of truth for the version: `tauri.conf.json` has
no `version` key, so Tauri reads the manifest, and a test in `src-tauri/src/lib.rs` fails if
that ever stops being true.

This needs one repository secret, **`RELEASE_PLZ_TOKEN`** — a fine-grained PAT (or GitHub App
token) with *Contents: read/write* and *Pull requests: read/write*. It cannot be replaced by
the built-in `GITHUB_TOKEN`: a release created by that token fires no `release` event, so
`release.yml` would never run and every release would ship with no installers. Repository
settings must also allow GitHub Actions to create pull requests.

## Known limitations

- **The whole tree is watched, even the parts that are then filtered out.** Part 9 stopped
  ignored paths producing refreshes, but not the OS-level watch itself. On Linux
  `RecursiveMode::Recursive` installs one inotify watch per directory: in this checkout that
  is 4,923 of them, of which 2,915 are `src-tauri/target/` and 1,731 `node_modules/`, leaving
  279 anyone cares about. Comfortable against the usual 524,288 limit, but a distro still
  shipping the old 8,192 default sits at 60% for a single project, and exhausting it makes
  the sidebar stop updating. macOS and Windows use one stream per root and are unaffected.
  Part 11 is the fix.
- **A linked worktree or a submodule is not watched properly.** When the project's `.git` is a
  *file* rather than a directory, the index, HEAD and refs live outside the watch root, so
  staging in the terminal does not refresh the panel.
- **A `git add -f` inside an ignored directory** can be missed until the next time the ignore
  cache is discarded. The `git add` itself is always seen; later edits to that file may not
  be.
- **The app does not sign or notarise its installers.** See "Installing a build" above.

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

- [x] **Part 8 — Polish & packaging** (`plans/PLAN-8-polish-and-packaging.md`)
  A **File menu** (native: Open Folder, Open Recent, Close Project, Settings, Exit) and the
  concept of an open **project** that the app did not have. Before this, the repo came from
  wherever the app happened to be launched; now it is chosen, remembered, and reopened next
  launch, with a **welcome screen** listing the last five and marking any that have gone or
  are no longer a repo. Closing or switching kills the workspace PTYs and closes the diff and
  merge windows, after a confirmation, because both end a running Claude Code session.
  Settings live in `config.json` in the OS config directory and get their own window:
  **light and dark themes** that reach the workspace, both terminals and every diff and merge
  window live, a **monospace font** for the terminals and both editors (pick a Nerd Font and
  your shell prompt's icons render), and **rebindable shortcuts** with conflict detection.
  Bundles carry proper metadata and declare `git` as a dependency. Signing is not done: see
  "Installing a build" under Development.

- [x] **Part 9 — The "No changes" flicker** (`plans/PLAN-9-no-changes-flicker.md`)
  On a clean repo the sidebar's "No changes" text flickered. Three independent defects
  compose into that one symptom, and all three are fixed.

  A **transient value in a render gate**: `refresh()` opened by setting `phase: "loading"`
  and the empty state was gated on `phase === "ready"`, so every read blanked the panel
  body for its duration. A *dirty* repo never showed it, because its rows are not gated on
  the phase at all — which is why review and the existing test both missed it. `"loading"`
  is gone from the type rather than merely worked around, so `phase` is the settled outcome
  and no future reader can gate on an in-flight one. `phase: "idle"` gets its own
  **"Loading changes…"**, for a first mount and a project switch, which also fixes a blank
  first-mount panel; there is deliberately no spinner, because at the event rate involved a
  spinner *is* the strobe.

  A **watcher with no filtering**: the recursive watch discarded its debounced batch, so
  `src-tauri/target/` (12 GB here) and `node_modules/` fed it continuously during
  development, roughly 13 git subprocesses per event to be told the tree was still clean.
  `watchfilter` now decides in five passes, cheapest first, asking `git check-ignore` only
  as a last resort and caching each verdict for the whole ancestor chain, so a build
  directory costs one question ever.

  And **our own reads were the loudest source of events**: `notify`'s inotify mask includes
  `OPEN`, so every file `git status` reads is itself an event, and answering one refresh
  asked for the next — about seven a second on an idle clean repo, on ext4 as well as
  tmpfs. That predates the filter (a plain `git status` was always enough) and is likely
  much of what the original report was seeing. Paths are now compared against a remembered
  mtime, length, ctime and mode instead of being taken at face value.

  Reads are also **coalesced** (one cascade, at most one queued behind it, always resolving
  after a read that began after the call), and two adjacent bugs are fixed: a project opened
  mid-merge showed **no merge banner** until an unrelated file changed, and a read or
  operation in flight across a **project switch** could report against the repo the user had
  just moved to.

- [ ] **Part 10 — Retire Monaco: one editor stack**
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

- [ ] **Part 11 — Watch only what matters**
  Stop asking the OS to watch directories the filter is only going to discard.

  **Why this exists.** Part 9 made ignored paths cost nothing *once reported*, but the watch
  itself is still recursive over everything. On Linux that is one inotify watch per
  directory: 4,923 in this checkout to observe the 279 that are not `target/` or
  `node_modules/`, so 94% of the kernel memory and of the watch budget is spent on paths whose
  events are thrown away. It is invisible at the usual 524,288 limit and fatal at the old
  8,192 default, where a large monorepo can exhaust the budget and leave the sidebar silently
  frozen — which is the same failure the user cannot detect and cannot force a refresh out of.

  **What it needs.** `notify` has no include/exclude hook for `RecursiveMode::Recursive`, so
  this means watching non-recursively and managing sub-watches ourselves: walk the tree
  applying `watchfilter`'s own ignore rules, add a watch per surviving directory, and add or
  drop watches as directories appear and disappear. The ignore decisions are already written
  and tested; the new work is the bookkeeping, and getting "a directory was created inside a
  watched one" right without racing the events that arrive before its watch exists.

  **Also worth folding in**, since it needs the same code: the arming replay. Watching
  recursively today reports every path it discovers as a synthetic event, so opening a project
  spends a burst of `check-ignore` batches learning what it could have learned during the walk.

## Global decisions

- Git operations shell out to the system `git` binary — inherits the user's SSH agent, credential helpers and hooks. Human-readable git output is never parsed.
- PTYs live in the Rust backend keyed by id; the frontend attaches and re-attaches. PTY lifetime is never tied to a React component.
- Claude Code manages its own subscription auth; the app just gives it a PTY.

