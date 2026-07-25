# Plan 8: Polish and packaging

## Goal
Make the app configurable and make it a program rather than a thing you run from the
right directory: a File menu, a project you choose and it remembers, light and dark
themes, a font that renders your shell prompt, rebindable shortcuts, and installers
that carry proper metadata.

Out of scope: code signing and notarisation, which need certificates that are not in
this repository. The bundles are unsigned and the README says what that costs.

## The problem this part is really solving

**There was no project.** The repo root came from `spawn::default_cwd()` (`INIT_CWD`,
then the process cwd, then `$HOME`), and the git panel and the two PTYs agreed only
because both called that same function. You could not change it without relaunching
the app from somewhere else. Everything else in this part is downstream of introducing
one: the menu needs something to open, the welcome screen needs something to list, and
the settings file needs something to remember.

**And there was one look.** Every colour was a hex literal, in four stylesheets plus
three separate JavaScript theme objects that had been kept in step by hand.

## Decisions

| Decision | Choice |
|---|---|
| Menu | **Native** (`tauri::menu`), so it cannot follow the theme, and on macOS it is in the system menu bar. Off macOS it is set on the **main window only**: `AppHandle::set_menu` walks every menu-less window and would put a File menubar on each `diff-*`, `merge-*` and `settings` window. |
| macOS menu | Settings and Quit in the app submenu, plus a standard **Edit** submenu — a custom macOS menu replaces AppKit's, taking the Cmd+C/V/A responders with it, and copy-paste stops working in the webview. |
| Project | **Must be inside a git repository, and *is* the repo root.** Picking a subdirectory opens the repo it belongs to, so the recents list never holds two near-identical entries for one checkout. |
| Who owns it | **Rust**, as `ActiveProject` managed state. `git_status(path: None)` and `pty_spawn(cwd: None)` read it and **refuse to guess** when nothing is open, which keeps the panel and the terminals agreeing by construction rather than by coincidence. |
| Config | Hand-rolled serde struct at `app_config_dir()/config.json`, written atomically. Every field optional on read; a file that will not parse is renamed to `.bak` rather than overwritten. No store plugin: the shape is small and this is unit-testable without a Tauri app. |
| PTYs on a project change | **Killed**, in the Rust command, before it resolves. A documented exception to CLAUDE.md's "unmount never kills a PTY": it is an explicit user action, never a React cleanup, and it completes before the frontend swaps anything. |
| Order of operations | `project_open` / `project_close` **persist first, tear down second**. The write can fail, and failing after the teardown leaves a mounted workspace whose PTYs are dead and whose git reads answer for another repo. |
| Themes | A **registry** of `Theme` objects, ~70 role tokens each. Every CSS colour is `var(--ib-…)`, and xterm, Monaco and CodeMirror derive theirs from the same tokens. Adding a third theme is one more object. |
| Token names | **Roles, not colours.** `--ib-danger` is what a destructive action looks like. |
| First paint | Each entry point *publishes* a theme synchronously at module load: an unset custom property paints as unstyled, and the editors seed from `currentAppearance()`. Secondary windows are told the theme in their URL by the opener. |
| Font | One monospace family and size for both terminals and both editors. A change refits the terminals and resizes their PTYs, because the cell size moved. |
| Keybinding matching | On `KeyboardEvent.code` (layout-independent); stored and displayed as readable text, because `Digit1` is not hand-editable. |
| Workspace defaults | All **Alt+<digit>**. The handler is capture-phase and swallows what it binds, so bare Alt+<letter> would eat readline's `M-f` / `M-b` word motion in an app that is mostly a terminal. |
| Git actions from the keyboard | A keystroke sets `pendingGitAction`; **BranchStatus** runs it, because only it knows whether the operation is possible. The eligibility lives once, in `syncAvailability`. |
| Signing | **Not done.** Bundle metadata and per-OS installer options only. |

## What was built

### Rust
- **`settings.rs`** — `Settings`, `SettingsPatch`, atomic `save`, `load` with the `.bak`
  rescue, `SettingsStore` managed state. Pure: `push_recent`, `remove_recent`,
  `normalise`, `same_path`.
- **`project.rs`** — `ActiveProject`, `Project`, `RecentProject` with a three-state
  `RecentState` (`ok` / `missing` / `notARepo`), `open`, `describe`, `repo_root_of`.
- **`menu.rs`** — the native menu, `MenuAction`, and `MenuState`, which caches what the
  installed menu was built from so a font-size keystroke does not replace the menubar
  (and so `describe`'s per-entry `git rev-parse` does not run on every settings save).
- **`fonts.rs`** — installed families via `fontdb` (pure Rust; no `libfontconfig` on CI),
  with the monospaced flag the picker filters on.
- **`commands.rs`** — `bootstrap` (settings, recents, reopened project, warnings, and the
  launch folder, in one round trip), plus settings, project, font and picker commands.
- **`pty.rs`** — the reader thread checks `killed` per read, not only at EOF: ids are
  reused across projects, so a killed shell's buffered output would otherwise paint into
  the next project's terminal.
- **`watcher.rs`** — `stop()`, for a project with nothing left to watch.

### Frontend
- **`store/projectStore.ts`**, **`store/settingsStore.ts`**, **`components/WelcomeScreen.tsx`**,
  **`hooks/useMenuEvents.ts`** — the project lifecycle and the screen that starts it.
- **`theme/themes.ts`**, **`theme/initialTheme.ts`**, **`lib/appearance.ts`** — the palette,
  the first paint, and the bridge to the three editors.
- **`lib/keybindings.ts`**, **`hooks/useGlobalKeybindings.ts`**, **`hooks/useWindowKeybindings.ts`** —
  the accelerator model and the two listeners.
- **`settings/`** — the fourth window: Appearance and Keybindings.

## Known limits
- The **main window** starts on the default theme for one IPC round trip. It has nothing
  better to go on; the secondary windows are told in their URL and do not flash.
- **Ctrl/Cmd+W and Ctrl/Cmd+S** are not rebindable, and neither are the menu
  accelerators. Conventions, not preferences, and rebinding Ctrl+W away would strand a
  window that has no menu.
- A **hand-edited config** can bind a bare key that makes a character untypable. The
  settings window refuses it; the file is trusted, as it is everywhere else.
- The **native menu does not follow the theme**. Inherent to the choice.

## Acceptance criteria
1. First launch with no config shows the welcome screen; no PTY spawns and no git read
   happens until a project is open.
2. Opening a repo starts Claude Code and the shell in it. A non-repo folder is refused
   with a clear message.
3. Relaunching reopens the same project. A folder that has gone puts you on the welcome
   screen with the reason, and the entry stays in the list marked "missing".
4. Recents hold at most 5, most recent first, no duplicates. `×` removes one without
   touching disk. File > Open Recent lists the same five.
5. Close Project warns, then kills both PTYs, closes any diff and merge windows, stops
   the watcher, and returns to the welcome screen.
6. Switching to Light retints the workspace, the terminals and every open diff and merge
   window, live. Dark is the default.
7. A Nerd Font makes shell glyphs render in both terminals; the size reaches both editors.
8. A rebind takes effect immediately and after a restart; a conflict is reported.
9. A corrupted `config.json` leaves a `.bak` and starts from defaults with a notice.
10. `npm run tauri build` produces installers on all three OSes.
