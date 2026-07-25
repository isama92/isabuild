//! The application menu.
//!
//! A **native** menu (`tauri::menu`), not an HTML bar: it is the OS widget, so
//! it cannot follow the app theme, and on macOS it lives in the system menu bar
//! rather than the window's top left. That is the trade accepted for Part 8.
//!
//! ## Where the menu is attached
//!
//! Never `AppHandle::set_menu` off macOS. On Windows and Linux that call walks
//! every window without a menu of its own and gives it this one, which would put
//! a File menubar on top of each `diff-*`, `merge-*` and `settings` window. The
//! menu belongs to the workspace, so off macOS it is set on the **main window
//! only**; on macOS the menu is app-wide by definition and `set_menu` is right.
//!
//! ## Platform layout
//!
//! Windows and Linux get the literal File menu: Open Folder, Open Recent, Close
//! Project, Settings, Exit. On macOS, Settings and Quit move to the application
//! submenu where macOS users look for them, and a standard Edit submenu is
//! included: a custom macOS menu **replaces** the default one, and without Edit
//! the system loses the Cmd+C / Cmd+V / Cmd+A responders and copy-paste stops
//! working inside the webview.
//!
//! ## Accelerators are fixed
//!
//! The rebindable actions (Part 8's keybindings tab) are all webview-level. Menu
//! accelerators stay constant, so a keybinding change never has to rebuild the
//! menu, and the menu never shadows a key the webview wanted.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager as _, Runtime};

use crate::project::{RecentProject, RecentState};

pub const OPEN_FOLDER: &str = "file.open-folder";
pub const CLOSE_PROJECT: &str = "file.close-project";
pub const SETTINGS: &str = "file.settings";
pub const QUIT: &str = "file.quit";
/// Recent entries are `file.recent.<index>` into the list the menu was built
/// from. An index rather than the path: a path can contain any character, and a
/// menu id has to survive being compared as a plain string.
pub const RECENT_PREFIX: &str = "file.recent.";

/// What a menu id means. The event handler matches on this rather than on
/// strings, so an id typo is a compile error at the call site instead of a menu
/// item that silently does nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuAction {
    OpenFolder,
    OpenRecent(usize),
    CloseProject,
    Settings,
    Quit,
}

pub fn recent_id(index: usize) -> String {
    format!("{RECENT_PREFIX}{index}")
}

/// Map a menu id back to its action, or `None` for an id we did not create
/// (the predefined macOS items report their own).
pub fn action_for(id: &str) -> Option<MenuAction> {
    match id {
        OPEN_FOLDER => Some(MenuAction::OpenFolder),
        CLOSE_PROJECT => Some(MenuAction::CloseProject),
        SETTINGS => Some(MenuAction::Settings),
        QUIT => Some(MenuAction::Quit),
        other => other
            .strip_prefix(RECENT_PREFIX)
            .and_then(|index| index.parse().ok())
            .map(MenuAction::OpenRecent),
    }
}

/// Compare paths with the separators normalised.
///
/// Recent paths come from `git rev-parse --show-toplevel`, which reports
/// `C:/Users/dev/repos/app` on Windows, while `home_dir()` reports
/// `C:\Users\dev`. Without this the home shortening below would simply never
/// fire there.
fn with_forward_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

/// Label for a recent entry: the path with the home directory shortened to `~`,
/// and a note when it cannot be opened.
///
/// The full path, not just the folder name, because two projects called `api`
/// under different parents are otherwise indistinguishable in the menu.
pub fn recent_label(recent: &RecentProject, home: Option<&str>) -> String {
    let path = with_forward_slashes(&recent.path);
    let shortened = match home.map(with_forward_slashes).filter(|h| !h.is_empty()) {
        Some(home) if path == home => "~".to_string(),
        Some(home) => match path.strip_prefix(&home) {
            // Only when a separator follows, or `/home/dev-old` would shorten
            // against `/home/dev`.
            Some(rest) if rest.starts_with('/') => format!("~{rest}"),
            _ => path,
        },
        None => path,
    };
    match recent.state {
        RecentState::Ok => shortened,
        RecentState::Missing => format!("{shortened} (missing)"),
        RecentState::NotARepo => format!("{shortened} (not a repository)"),
    }
}

/// Build the menu for the current state. Rebuilt (not mutated) whenever the
/// recents list or the open/closed state changes: rebuilding is cheap, and
/// patching a live menu in place is where stale-item bugs live.
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    recents: &[RecentProject],
    project_open: bool,
) -> tauri::Result<Menu<R>> {
    let home = std::env::home_dir().map(|h| h.to_string_lossy().into_owned());

    let mut recent_menu = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        let empty = MenuItemBuilder::with_id("file.recent.none", "No recent projects")
            .enabled(false)
            .build(app)?;
        recent_menu = recent_menu.item(&empty);
    } else {
        for (index, recent) in recents.iter().enumerate() {
            let item =
                MenuItemBuilder::with_id(recent_id(index), recent_label(recent, home.as_deref()))
                    .build(app)?;
            recent_menu = recent_menu.item(&item);
        }
    }
    let recent_menu = recent_menu.build()?;

    let open_folder = MenuItemBuilder::with_id(OPEN_FOLDER, "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    // Nothing to close on the welcome screen. Disabled rather than hidden, so
    // the menu does not change shape as projects open and close.
    let close_project = MenuItemBuilder::with_id(CLOSE_PROJECT, "Close Project")
        .enabled(project_open)
        .build(app)?;
    let settings = MenuItemBuilder::with_id(SETTINGS, "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // Shadowed rather than `mut`-reassigned inside the cfg block: on macOS that
    // block is stripped, and a `mut` binding nothing reassigns is an
    // `unused_mut` warning, which `-D warnings` turns into a macOS-only build
    // failure nobody sees on Linux.
    let file = SubmenuBuilder::new(app, "File")
        .item(&open_folder)
        .item(&recent_menu)
        .item(&close_project);

    #[cfg(not(target_os = "macos"))]
    let quit = MenuItemBuilder::with_id(QUIT, "Exit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().item(&settings).separator().item(&quit);
    let file = file.build()?;

    let menu = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        // The application submenu takes its name from the first submenu's title.
        let app_menu = SubmenuBuilder::new(app, "isabuild")
            .about(None)
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        // Without Edit, Cmd+C/V/X/A stop working in the webview: a custom menu
        // replaces AppKit's default one, taking those responders with it.
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .close_window()
            .build()?;
        let menu = menu.item(&app_menu).item(&file).item(&edit).item(&window);
        return menu.build();
    }
    #[cfg(not(target_os = "macos"))]
    menu.item(&file).build()
}

/// Attach `menu` where the platform expects it. See the module note on why the
/// non-macOS branch must not use the app-wide setter.
///
/// Returns whether it actually attached: off macOS there is nothing to attach
/// it to before the main window exists, and a caller that cached that as
/// "installed" would skip every later identical attempt and leave the window
/// with no menu at all.
pub fn install<R: Runtime>(app: &AppHandle<R>, menu: Menu<R>) -> tauri::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        app.set_menu(menu)?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
            return Ok(false);
        };
        window.set_menu(menu)?;
        Ok(true)
    }
}

/// Everything the menu renders from, as stored rather than as inspected: the
/// recent paths in order, and whether a project is open.
///
/// Deliberately *not* derived from `RecentProject`, which knows whether each
/// folder is still usable. Working that out costs a `git rev-parse` per entry,
/// and the signature is checked on every settings save — including each
/// keystroke in the font-size field. So a folder deleted while the app is
/// running is reflected in the menu at the next real change (an open, a close,
/// a removal) rather than immediately; the welcome screen, which re-inspects
/// every time it renders, is the authority on that.
type Signature = (Vec<String>, bool);

fn signature_of(recent_paths: &[String], project_open: bool) -> Signature {
    (recent_paths.to_vec(), project_open)
}

/// Managed state: what the installed menu was built from.
///
/// Every settings change broadcasts, and most of them (a font size, a theme)
/// change nothing the menu shows. Rebuilding regardless would replace the GTK
/// menubar on each keystroke in the font-size field, which drops and re-adds
/// its accelerators every time.
#[derive(Default)]
pub struct MenuState(Mutex<Option<Signature>>);

impl MenuState {
    /// Rebuild and reinstall, but only when what the menu displays has changed.
    ///
    /// `describe` is called *inside* the changed branch, so the per-entry
    /// filesystem and git checks it performs never run for a save that only
    /// touched the font or the theme.
    pub fn refresh<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        recent_paths: &[String],
        project_open: bool,
    ) -> tauri::Result<()> {
        let signature = signature_of(recent_paths, project_open);
        let mut installed = self.0.lock().expect("menu state mutex poisoned");
        if installed.as_ref() == Some(&signature) {
            return Ok(());
        }
        let recents = crate::project::describe(recent_paths);
        if install(app, build(app, &recents, project_open)?)? {
            *installed = Some(signature);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recent(path: &str, state: RecentState) -> RecentProject {
        RecentProject {
            name: crate::project::folder_name(path),
            path: path.to_string(),
            state,
        }
    }

    fn ok(path: &str) -> RecentProject {
        recent(path, RecentState::Ok)
    }

    #[test]
    fn every_id_we_build_maps_back_to_its_action() {
        assert_eq!(action_for(OPEN_FOLDER), Some(MenuAction::OpenFolder));
        assert_eq!(action_for(CLOSE_PROJECT), Some(MenuAction::CloseProject));
        assert_eq!(action_for(SETTINGS), Some(MenuAction::Settings));
        assert_eq!(action_for(QUIT), Some(MenuAction::Quit));
        assert_eq!(action_for(&recent_id(3)), Some(MenuAction::OpenRecent(3)));
    }

    #[test]
    fn an_unknown_id_has_no_action() {
        assert_eq!(action_for("edit.copy"), None);
        // The placeholder shown when there are no recents is disabled, but it
        // must not decode as a recent either.
        assert_eq!(action_for("file.recent.none"), None);
        assert_eq!(action_for("file.recent."), None);
        assert_eq!(action_for("file.recent.-1"), None);
    }

    #[test]
    fn a_recent_label_shortens_the_home_directory() {
        assert_eq!(
            recent_label(&ok("/home/dev/isabuild"), Some("/home/dev")),
            "~/isabuild"
        );
        assert_eq!(recent_label(&ok("/home/dev"), Some("/home/dev")), "~");
    }

    #[test]
    fn shortening_survives_windows_mixing_both_separators() {
        // git reports forward slashes, home_dir reports backslashes; compared
        // literally the two would never match and Windows users would always
        // see the full path.
        assert_eq!(
            recent_label(&ok("C:/Users/dev/repos/app"), Some(r"C:\Users\dev")),
            "~/repos/app"
        );
    }

    #[test]
    fn shortening_only_applies_at_a_path_boundary() {
        assert_eq!(
            recent_label(&ok("/home/dev-old/isabuild"), Some("/home/dev")),
            "/home/dev-old/isabuild",
            "a sibling directory that merely starts with the home path is not under it"
        );
    }

    #[test]
    fn a_label_without_a_home_directory_keeps_the_full_path() {
        assert_eq!(recent_label(&ok("/srv/isabuild"), None), "/srv/isabuild");
    }

    #[test]
    fn an_unopenable_project_says_which_way_it_is_broken() {
        assert_eq!(
            recent_label(&recent("/srv/gone", RecentState::Missing), None),
            "/srv/gone (missing)"
        );
        assert_eq!(
            recent_label(&recent("/srv/plain", RecentState::NotARepo), None),
            "/srv/plain (not a repository)"
        );
    }

    #[test]
    fn the_signature_ignores_everything_the_menu_does_not_show() {
        // A font or theme change broadcasts too; neither should replace the
        // menubar, and neither should cost a `git rev-parse` per recent.
        let paths = ["/a".to_string()];
        assert_eq!(signature_of(&paths, true), signature_of(&paths, true));
    }

    #[test]
    fn the_signature_changes_with_the_things_the_menu_does_show() {
        let one = ["/a".to_string()];
        let two = ["/a".to_string(), "/b".to_string()];

        assert_ne!(signature_of(&one, true), signature_of(&two, true));
        assert_ne!(signature_of(&one, true), signature_of(&one, false));
        // Order is the recency order, and the menu shows it.
        assert_ne!(
            signature_of(&two, true),
            signature_of(&["/b".to_string(), "/a".to_string()], true)
        );
    }
}
