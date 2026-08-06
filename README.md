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

## Todo

Each part is an independent piece of work, executed in order, and its entry below *is* its plan — rationale, scope and acceptance criteria. A part is done only when those pass on macOS, Linux and Windows, and it is then **removed** from this list rather than ticked, with the rest renumbered. A number is therefore a position in the queue and not a stable id: what shipped and why is in `CHANGELOG.md` and the git history, and code comments name the number a part had at the time.

- [ ] word and line editing in both terminals. The editing keys every other text field on the
      machine has do not work at the Claude Code prompt: Ctrl+Backspace deletes a single
      character rather than a word, and Ctrl+Arrow moves nothing. They are not swallowed by the
      app, they are mistranslated — xterm encodes them as `CSI 1;5D`, `CSI 1;5C` and a bare
      `^H`, and `^H` *is* `backward-delete-char`, in every line editor, which is why
      Ctrl+Backspace was broken at the shell prompt too. Ctrl+Arrow is the uneven one: readline's
      default emacs keymap binds both CSI forms to word motion, so it already worked at a bash
      prompt with no inputrc at all, while zsh binds neither and Claude Code is not readline and
      reads no inputrc. The meta forms are the one spelling all three accept, so one pure table,
      `src/lib/terminalKeys.ts`, maps to those (`\x1bb`, `\x1bf`, `\x1b\x7f`, `\x1bd`) and writes
      them through the same custom key handler and `pty_write` that Shift+Enter already used;
      `SHIFT_ENTER` moves into that table so there is only one. No backend change:
      `pty_write` is byte-transparent. Alt+Arrow, Alt+Backspace and Alt+Delete are in the table
      as well as the Ctrl spellings, and are what make the feature work on macOS at all, where
      Ctrl+Arrow is Mission Control's "move a space" and never reaches the webview. Cmd+Arrow
      and Cmd+Backspace map to line motion (`\x01`, `\x05`, `\x15`) on macOS only, because Meta
      is Super on Linux and Windows, where `\x15` would silently discard a typed line if a
      window manager ever let it through. Modifiers match exactly, so Ctrl+Shift+Arrow stays
      with xterm (a terminal has no input selection to extend), and a keystroke inside an IME
      composition is left alone. Cmd+Delete stays mis-encoded on purpose (xterm sends
      `CSI 3;9~`): macOS has no Cmd+Delete text gesture to honour, so a row for it would mean
      inventing the gesture. The translation also **stands down while the alternate screen
      buffer is active**, because `vim`, `less` and `htop` parse `CSI 1;5D` and read `\x1bb` as
      Escape-then-`b`, which in vim's insert mode leaves insert mode. That guard is per session
      rather than global: Claude Code occupies the alternate buffer from startup to exit
      (verified — it emits `ESC [?1049h` 13 bytes into its output and never leaves), so the
      obvious global form of the check would disable the whole feature exactly where it is
      aimed. `MainPanel` passes `respectAlternateScreen={false}`, safe only because it is the one
      session whose program is known; the shell terminal keeps the default.
      The guard is all-or-nothing across the table, and that has one accepted cost: a `claude`
      launched by hand in the bottom terminal loses Shift+Enter, because it sits in the alternate
      buffer too, so the prompt submits instead of extending. It worked there before this part,
      and the path is not hypothetical — "Retry in terminal" writes into that region
      (`TerminalPanel`, session `shell-main`). Deliberately not coded around: exempting
      Shift+Enter would re-break the vim case the guard exists for, since in insert mode a bare
      CR inserts a newline while `\x1b\r` leaves insert mode, and nothing a terminal exposes
      separates a TUI that parses CSI from a TUI that is itself a line editor. If it ever needs
      solving, the answer is a per-session opt-out on that region and not a special case in the
      table. All eleven
      combinations, plus the numpad spellings of the arrows, go into `RESERVED` in
      `src/lib/keybindings.ts` for the workspace scope, so the settings window refuses to bind
      an app action over one and break editing silently.
      Acceptance: at both prompts, Ctrl+Arrow (Linux, Windows) and Option+Arrow (macOS) move by
      word with no escape sequence printed; Ctrl+Backspace and Ctrl+Delete kill the word either
      side of the cursor; Cmd+Arrow and Cmd+Backspace do line motion on macOS and nothing
      changes elsewhere; plain arrows, plain Backspace and Alt+digit are unchanged; Shift+Enter
      still inserts a newline in Claude Code; Alt+ArrowLeft does not navigate the webview back;
      the settings window refuses Ctrl+ArrowLeft with a reason; and in the shell terminal
      `vim` in insert mode still moves a word on Ctrl+ArrowLeft rather than leaving insert mode,
      which is the alternate-screen guard doing its job.
      Outstanding: **the interactive pass in the running app is not done on any platform.** What
      is verified is the automated half — both suites green — plus every byte in the table
      checked against `bind -p` and `bindkey` on Linux, which is what makes the sequences right
      but says nothing about whether the keystroke reaches the handler. Still to confirm, in the
      app: all three platforms for the rows themselves; Windows and Linux for Alt+ArrowLeft not
      navigating the webview back; macOS for the whole Ctrl tier being unreachable (Mission
      Control) and the Cmd tier working; and everywhere whether Claude Code's own input
      implements `M-d` (forward kill-word), the one row with real uncertainty — it is correct at
      a shell prompt either way. The pass should also walk the accepted cost above, so it is
      recognised on sight rather than filed as a regression: run `claude` in the bottom terminal
      and confirm Shift+Enter submits there while the main pane still extends the prompt, and
      that Ctrl+Backspace is likewise inert in that hand-launched session.
- [ ] diff window toolbar, file navigation and unified view. The toolbar is text buttons
      (`◂ Previous`, `Next ▸`, `Compact`) with the change count stranded in the middle, and it
      offers only two of the four things a diff toolbar is for. This part makes it a row of icon
      buttons — previous/next change, previous/next **file** with a `10 / 26 files` counter,
      Compact — with the count and a Split/Unified pair pushed right. Three of those are new
      capability, not restyling, and each one runs into something structural.
      **File navigation** is the largest. A diff window knows exactly one file for its whole life:
      `useEditorWindow` parses the URL once in a `useState` initialiser, and the window's Tauri
      label is a hash of that path, which is what stops a second window opening for the same file.
      So the hook gains an opt-in `navigable` (an overload, so the merge window cannot have it —
      its result buffer lives in memory until every conflict is decided, and "load something else
      in place" has no safe meaning there), and a navigated window's label stops describing its
      content. That is closed by a registry in Rust, `src-tauri/src/diffwindows.rs`, recording what
      each window currently shows: its `decide()` is a pure function returning Focus, Reuse or
      Create, and **Reuse is the case that matters** — without it, clicking `b.ts` in the Status
      panel focuses the window that was opened for `b.ts` and has since navigated to `a.ts`, which
      is a wrong-file bug rather than a duplicate-window one. The list itself is
      `src/lib/changedFiles.ts`, staged then unstaged in git's own order, deduped by path (a file
      staged and then changed again is two rows in the panel deliberately, but one diff), conflicts
      excluded because they open the merge window. The window fetches it itself on every
      `repo://changed`; `StatusPanel` adopts only the shared predicate, not the list, because its
      two groups render a shared path as two rows on purpose.
      The one thing here that is not obvious and would be a silent data loss: `writeBuffer` reads
      the buffer when it *runs*, not when it was asked, which is right while a window stays on one
      file and catastrophic the moment it does not — a write queued behind a slow one would read
      the **new** file's buffer and write it into the **old** file. Hence `generationRef`, captured
      at request time; a superseded write returns success rather than failure, because it has
      nothing left to do and must not raise a save error or block a close. `DiffPane` is remounted
      on `key={path}`, because otherwise the undo history survives across files and Ctrl+Z in the
      new file would undo into the previous one's text and auto-save it, and language extensions,
      appended with `StateEffect.appendConfig` and never removed, would stack forever. The file
      controls render from `DiffWindow` through a new `toolbar` slot on `EditorWindow`, not from
      the pane: the pane is unmounted during every load and for a binary file, so a counter there
      would vanish exactly when it is being used.
      **The unified view** is a different CodeMirror object — `unifiedMergeView` is an extension on
      a single `EditorView`, not a `MergeView` — so `DiffPane` becomes a shell over `SplitPanes`
      and `UnifiedPane` sharing `diff/diffView.ts`, and `onSplitAt` becomes `onLayout`, since a
      one-document view has no divider for the header to track. Four things about the package had
      to be checked rather than assumed, and all four bite: a compartment reconfigure
      **re-initialises `originalDoc`**, so every Compact toggle must pass the current HEAD or it
      rewrites what HEAD said; `rejectChunk` dispatches straight past `EditorState.readOnly`, so a
      deleted file gets no control at all; `mergeControls: true` renders an Accept face that edits
      the in-memory HEAD, which is a lie against a git blob, so only the reject face is rendered;
      and a new commit must arrive as `originalDocChangeEffect`, which fires no `docChanged` and
      therefore cannot be mistaken for an edit. What did *not* need changing is the change map:
      a deletion widget is a zero-length block widget at `fromB` and CodeMirror joins it into that
      line's block, so `lineBlockAt(chunk.fromB).top` already lands on the deleted lines and
      `lib/diffStripes` works unaltered in both modes.
      **The revert arrows.** The diff window's `»` becomes a chevron icon. The merge window's `»`
      and `«` become icons too, and move: both are CodeMirror gutters, and a gutter defaults to its
      own pane's *left* edge, so the ours `»` sits at the far left of the whole window pointing
      right at a pane three columns away, and the theirs `«` sits behind its own line numbers.
      `gutter({ side: "after" })` puts the ours arrow on the ours/result seam and raising the
      theirs gutter above `lineNumbers()` puts its arrow on the result/theirs seam. `lib/mergeAlign`
      is purely vertical, so the alignment cannot be affected.
      Icons are `lucide-react`, the app's first UI dependency. `ToolbarButton.label` stays the
      accessible name when an `icon` is given, so every existing `getByRole("button", { name })`
      keeps working. `renderRevertControl` and `GutterMarker.toDOM()` need real DOM nodes rather
      than React, so `editor/iconElement.ts` builds those two chevrons with `createElementNS`, with
      a test pinning its path data against the real lucide component so the two cannot drift.
      Acceptance: the toolbar reads as the mockup and every icon button has a tooltip; ↑/↓ and
      Alt+↑/Alt+↓ walk changes, ←/→ and Alt+←/Alt+→ walk files with the counter tracking and both
      disabling at the ends; typing in a file and pressing Next File writes the edit to the file
      being *left*; navigating away from a file and then clicking it in the Status panel returns
      the *same* window to it rather than opening a second; switching Split/Unified keeps an
      unsaved edit and the cursor, and the choice survives a restart; the unified view's chevron
      restores a block from HEAD and Compact works there; in the merge window each chevron sits on
      the seam between the pane it takes from and the result, and the three panes stay aligned when
      scrolled; and the native window title follows the file in the taskbar.
      **Outstanding, and a decision rather than a bug to fix:** stepping between files does not
      consult the registry, only opening from the Status panel does. So with two diff windows
      open, Alt+Right in one of them can land it on the file the other is showing — the two-editors
      -on-one-path state the registry exists to prevent, reached by the front door. It is not
      destructive (they converge through `shouldAdoptDiskContent` unless both are being typed in at
      once) and it takes two open windows to reach, but closing it means picking between skipping
      that file, focusing the other window, and allowing it, and those are three different products.
      Accepted costs, none of which are worth coding around: Ctrl+F cannot reach the HEAD side in
      unified mode, because there is no second editor to focus — Split stays the default; the undo
      history and the find query are lost when the view mode changes, because the editor is rebuilt;
      one extra `git status` runs per open diff window per debounced watcher event; and reloading a
      diff window returns it to the file it was opened with, because `history.replaceState` throws
      `SecurityError` on the `tauri://` scheme on Linux and macOS while working in dev and in
      vitest, which is the worst failure shape available and not worth having.
- [ ] auto update
- [ ] help menu with `check for update` and `about` pages
- [ ] view menu with theme selector and zoom
- [ ] have files opening in place of claude code instead of opening in a new window (it should be faster)
- [ ] more code-window view settings (the diff window has Compact and a Split/Unified pair; the
      registry is `src/editor/viewOptions.ts`, so each new setting is an entry there plus a
      handler in the pane. An entry can pick which toolbar cluster it joins and whether it renders
      as one toggle or as a mutually exclusive pair)
- [ ] a shortcut to move focus between the regions (Claude Code, the bottom terminal, the Status
      panel). **Not** Ctrl+Arrow, which this list used to say: that is now word motion in the
      terminals, and it could never have worked on all three platforms anyway, since macOS gives
      Ctrl+Arrow to Mission Control before the app sees it. The accelerator is undecided and has
      to be picked before this is built — anything the terminals translate is out
      (`src/lib/terminalKeys.ts`), because `useGlobalKeybindings` swallows a bound key in the
      capture phase and it would never reach xterm. Consider folding in the entry below it:
      both are focus management.
- [ ] when a tool (terminal or git) is closed with a shortcut (eg. alt+1), move focus on claude

## Global decisions

- Shelling out to the system `git` rather than linking a library is what gives the app the user's SSH agent, credential helpers and hooks for free.
- PTYs live in the Rust backend keyed by id; the frontend attaches and re-attaches. PTY lifetime is never tied to a React component.
- Claude Code manages its own subscription auth; the app just gives it a PTY.

