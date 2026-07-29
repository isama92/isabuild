# isabuild

[![CI](https://github.com/isama92/isabuild/actions/workflows/ci.yml/badge.svg)](https://github.com/isama92/isabuild/actions/workflows/ci.yml) [![Cross-OS tests](https://github.com/isama92/isabuild/actions/workflows/cross-os.yml/badge.svg)](https://github.com/isama92/isabuild/actions/workflows/cross-os.yml)

A cross-platform desktop app (macOS, Linux, Windows) that embeds Claude Code in a terminal and wraps it with live git tooling: a real-time changed-files panel, diff viewer, branch/remote operations, and a graphical 3-pane merge conflict resolver.

## Stack

- **Shell**: Tauri 2 (Rust backend)
- **Frontend**: React 18 + TypeScript + Vite, Zustand, react-resizable-panels
- **Terminals**: xterm.js + `portable-pty` (ConPTY on Windows)
- **Git**: system `git` binary via subprocess (porcelain/plumbing output only)
- **Editors**: CodeMirror 6 (`@codemirror/merge` for the diff panes)

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

It holds the theme, the monospace font and size, keybinding overrides, the editor windows'
view options, and the recent projects. Every field is optional, so it is safe to hand-edit
down to the one key you care about. `keybindings` and `viewOptions` hold **overrides only** —
an action or an option with no entry uses its default, and an id the app does not recognise is
kept but ignored. Getting a *type* wrong is not so gentle: `"collapse-unchanged": "yes"` does
not parse as a boolean, and a file that cannot be parsed is renamed to `config.json.bak` and
replaced with defaults, which the app says on startup. Deleting the file resets everything.

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

Versioning and releases are automated by
[release-please](https://github.com/googleapis/release-please), driven by Conventional Commit
PR titles. Nobody edits a version by hand.

1. A PR merges to `main`. Because PRs are squash-merged, its `feat:`/`fix:`/… title becomes
   the commit release-please reads to pick the next version.
2. `release-please.yml` opens a `chore: release X.Y.Z` PR bumping `src-tauri/Cargo.toml`,
   `src-tauri/Cargo.lock`, `CHANGELOG.md` and the npm pair. Review it like any other PR.
3. Merging it tags `vX.Y.Z` and publishes the GitHub release, which triggers `release.yml`
   to build the installers above and attach them.

`src-tauri/Cargo.toml` is the single source of truth for the version: `tauri.conf.json` has
no `version` key, so Tauri reads the manifest, and a test in `src-tauri/src/lib.rs` fails if
that ever stops being true. `.release-please-manifest.json` records the last released
version and should not be hand-edited.

While the app is pre-1.0 a breaking change bumps the **minor** version, not the major, so
1.0.0 has to be cut deliberately rather than by a commit message.

This needs one repository secret, **`RELEASE_PLZ_TOKEN`** — a fine-grained PAT (or GitHub App
token) with *Contents: read/write* and *Pull requests: read/write*; grant *Issues: read/write*
too if label creation on the release PR fails. It cannot be replaced by the built-in
`GITHUB_TOKEN`: a release created by that token fires no `release` event, so `release.yml`
would never run and every release would ship with no installers. Because every call runs
through the PAT, the workflow's own `permissions:` block is not what authorises any of this.

## Known limitations

- **A very large repository can still exhaust the watch budget.** On Linux the watch is assembled a
  directory at a time and skips everything git ignores, so this checkout holds 32 watches rather
  than the 4,419 a recursive watch spends to observe them. Two shapes can still run past a distro's
  `fs.inotify.max_user_watches` (the old 8,192 default is the one to watch for): tens of thousands
  of *unignored* directories, and a **submodule**, where `git check-ignore` refuses to classify
  anything inside and "not knowing means watching" then covers the whole of it, ignored
  subdirectories included. Arming succeeds partially rather than failing, and `git_watch` returns
  the count of refused directories — but that count currently only reaches a `console.warn`, so a
  user without devtools open still has no visible signal. macOS and Windows use one recursive
  stream per root, which is already cheap there, and are unaffected either way.
- **A linked worktree or a submodule is not watched properly.** When the project's `.git` is a
  *file* rather than a directory, the index, HEAD and refs live outside the watch root, so
  staging in the terminal does not refresh the panel.
- **A `git add -f` inside an ignored directory** can be missed on macOS and Windows until the next
  time the ignore cache is discarded. The `git add` itself is always seen; later edits to that file
  may not be. Handled on Linux, where an index write re-reads the force-added set, watches the
  directories on the way to each one, and discards the stale "this directory is ignored" verdict.
- **The app does not sign or notarise its installers.** See "Installing a build" above.

## Roadmap

Each part is an independent piece of work, executed in order, and its entry below *is* its plan — rationale, scope and acceptance criteria. A part is done only when those pass on macOS, Linux and Windows, and it is then **removed** from this list rather than ticked, with the rest renumbered. A number is therefore a position in the queue and not a stable id: what shipped and why is in `CHANGELOG.md` and the git history, and code comments name the number a part had at the time.

- [ ] **Part 1 — Watch only what matters**
  Built and verified on Linux; **outstanding: confirmation on macOS and Windows.**

  **What shipped.** The watch is assembled a directory at a time on Linux (`src-tauri/src/watchtree.rs`),
  walking the tree, asking `watchfilter` which directories survive, and arming only those: 4,419
  inotify watches became 32 in this checkout, and arming got 41x faster with them (813 ms to 20 ms),
  because a recursive watch spends one watch per directory and 99% of them were on paths whose
  events were thrown away. `.git/objects` and `.git/logs`
  alone are 255 of the 264 directories under `.git`, and the filter already knew every event they
  produce is worthless. A directory appearing or disappearing is reconciled from the event batch,
  a subtree is re-read *after* it is armed so nothing created in the gap is lost, and a
  `.gitignore` edit re-plans the set in both directions. The arming replay is folded in: the walk
  records what the replay used to teach, at one `check-ignore` per level of the tree. Arming can
  now fail partially, so `git_watch` returns the coverage and the frontend warns on a refused
  count.

  **Still outstanding on the reporting.** That warning is a `console.warn`, which a user without
  devtools open will never see, so a partially armed watch is quieter than before rather than
  actually visible. Making it a UI signal is deliberately not in this part; the known-limitation
  entry above says so plainly rather than claiming the failure is now surfaced.

  **Deliberately Linux-only.** `notify`'s macOS backend stops, joins and rebuilds its entire
  FSEvents stream on *every* `watch()` call, so arming per directory would cost one rebuild each;
  Windows holds an open handle and a 16 KB buffer per watch. Both use one recursive stream per
  root today, which is already cheap. `arm` and `reconcile` in `watcher.rs` are the two seams;
  everything else, including the owner thread, is shared and exercised on all three platforms.

  **What is outstanding.** `cross-os.yml` runs the Rust suite on `windows-2022` and `macos-14`,
  which covers the shared lifecycle and the walk's own tests. Still to confirm by hand on macOS
  and Windows: opening a project, staging from the embedded terminal, a branch switch, and a
  build churning an ignored directory, all still refreshing the panel exactly as before.

- [ ] **Part 2 — Align the merge panes**
  Give ours | result | theirs the vertical alignment the diff panes have, and retire the
  proportional scroll sync.

  **Why this exists.** The three panes are synchronised in proportion (`lib/paneScroll.ts`), not
  aligned, so they drift apart in a long file and next/previous conflict is the only reliable way
  to move between chunks. The diff panes do not have that problem, and the obvious thought — reuse
  whatever they use — does not work: `@codemirror/merge` aligns with spacer blocks, but the aligner
  lives inside the `MergeView` class rather than being an exported extension, and a `MergeView` is
  strictly two documents, so a three-pane editor cannot be one.

  **What it needs.** Our own spacer widgets, from a chunk model we already have: Rust hands over
  each chunk's span in all four coordinate systems (base, ours, theirs, result), so the padding
  each pane needs at each chunk boundary is arithmetic over three line-range lists — pure, and
  unit-testable the way `mergeChunks.ts` already is. The insertion itself is a block widget per
  pane, which `MergePanes` is already the right shape for. When it lands, `lib/paneScroll.ts` and
  its twelve tests go, along with the `syncing` flag and the per-scroller listeners.

  **Also worth folding in**, because it becomes meaningful only once the panes align: the change
  map. `editor/OverviewRuler` is already window-agnostic and takes measured geometry, so the merge
  window can hang one beside its panes — but a shared vertical scale says nothing until the three
  panes agree on one.

- [ ] auto update
- [ ] help menu with `check for update` and `about` pages
- [ ] view menu with theme selector and zoom
- [ ] have files opening in place of claude code instead of opening in a new window (it should be faster)
- [ ] more code-window view settings (the diff window has a Compact toggle; the registry is
      `src/editor/viewOptions.ts`, so each new setting is an entry there plus a handler)
- [ ] ctrl+arrows to move between spaces
- [ ] when a tool (terminal or git) is closed with a shortcut (eg. alt+1), move focus on claude
- [ ] allow doing ctrl+backspace to remove a word in terminal or claude

## Global decisions

- Shelling out to the system `git` rather than linking a library is what gives the app the user's SSH agent, credential helpers and hooks for free.
- PTYs live in the Rust backend keyed by id; the frontend attaches and re-attaches. PTY lifetime is never tied to a React component.
- Claude Code manages its own subscription auth; the app just gives it a PTY.

