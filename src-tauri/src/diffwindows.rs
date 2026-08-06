//! Which file each diff window is currently showing.
//!
//! A diff window's Tauri label is a hash of the path it was *opened* with
//! (`src/lib/fileWindow.ts`), which is what makes "one window per file" work:
//! clicking a file in the Status panel computes its label and focuses the window
//! that already has it. That stops being true the moment a window loads a sibling
//! file in place, and the failure is not cosmetic — without a record of where each
//! window actually is, clicking the sibling opens a *second* window onto a file
//! already on screen, and two editors auto-save the same path at a 400 ms debounce.
//!
//! In Rust rather than in the frontend for two reasons: the main window cannot see
//! into another webview's state, and only the backend can check its own record
//! against the windows that actually exist.
//!
//! The decision is [`decide`], factored out of both the locking and the Tauri
//! plumbing so the interesting cases are testable without a webview — the same
//! split `status_start` has beside `git_status`. (It is *called* with the guard
//! still held, which is fine because it only reads. What must not happen under the
//! lock is the re-entrant `app.emit_to` for a `Reuse`, and that is in
//! `commands.rs`, after `route` has returned.)

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The file a diff window currently shows.
///
/// `repo_root` is part of the identity for the same reason it is in the label
/// hash: every checkout has a `src/main.rs`, and focusing another repository's
/// window would show — and then write to — the wrong file.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShownFile {
    pub repo_root: String,
    pub path: String,
}

/// Where a request to show a file should go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// A live window already shows it. Focus it and do nothing else.
    Focus(String),
    /// Focus this window and ask it to load the file in place.
    Reuse(String),
    /// Nothing open can show it; the caller creates a window.
    Create,
}

/// Label to the file that window currently shows. Tauri managed state.
#[derive(Default)]
pub struct DiffWindows(Mutex<HashMap<String, ShownFile>>);

impl DiffWindows {
    /// Record that `label` now shows `file`, replacing whatever it showed before.
    pub fn set(&self, label: String, file: ShownFile) {
        self.lock().insert(label, file);
    }

    /// Forget `label`. Idempotent: a window is destroyed once but may be swept
    /// twice, by its own event and by a later prune.
    pub fn remove(&self, label: &str) {
        self.lock().remove(label);
    }

    /// Decide where `wanted` goes, dropping every record whose window has gone.
    ///
    /// The prune is not housekeeping: it is what makes a stale record unable to
    /// produce a wrong answer. A webview that died without firing `Destroyed`
    /// would otherwise hand back a label that resolves to nothing, and the file
    /// would appear not to open at all.
    pub fn route(&self, alive: &HashSet<String>, wanted: &ShownFile, preferred: &str) -> Route {
        let mut shown = self.lock();
        shown.retain(|label, _| alive.contains(label));
        decide(&shown, alive, wanted, preferred)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ShownFile>> {
        // A poisoned lock here means a panic while holding it, and the map is
        // plain data: recovering is strictly better than taking the app down with
        // it, since the worst case is one duplicate window.
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// How many windows are on record. Tests only.
    ///
    /// Not `len`: clippy asks any public `len` for an `is_empty` beside it, and a
    /// registry has no use for one — nothing branches on "no diff windows open".
    #[cfg(test)]
    pub fn recorded(&self) -> usize {
        self.lock().len()
    }
}

/// Where a request to show `wanted` should go, given what is on screen.
///
/// `preferred` is the label the frontend derived from the path — the window this
/// file "belongs" to, whether or not it is open or still showing it.
pub fn decide(
    shown: &HashMap<String, ShownFile>,
    alive: &HashSet<String>,
    wanted: &ShownFile,
    preferred: &str,
) -> Route {
    if let Some(label) = shown
        .iter()
        .find(|(label, file)| *file == wanted && alive.contains(label.as_str()))
        .map(|(label, _)| label.clone())
    {
        return Route::Focus(label);
    }
    match (alive.contains(preferred), shown.contains_key(preferred)) {
        // A window sits at this file's own label showing something else, because
        // it was opened for this file and has since navigated away. It is the
        // window the user associates with the file, so send it back rather than
        // stacking a second one beside it. Without this branch the label would be
        // focused as-is and the user would be shown a different file than the one
        // they clicked — a wrong-file bug, not just a duplicate-window one.
        (true, true) => Route::Reuse(preferred.to_string()),
        // Alive but unregistered. The only way that happens is that a window was
        // just created for this very path and has not booted far enough to
        // register itself, so focusing it is right — and is what closes the
        // double-click race that would otherwise open the duplicate.
        (true, false) => Route::Focus(preferred.to_string()),
        (false, _) => Route::Create,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(repo: &str, path: &str) -> ShownFile {
        ShownFile {
            repo_root: repo.to_string(),
            path: path.to_string(),
        }
    }

    fn alive(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|label| (*label).to_string()).collect()
    }

    fn shown(pairs: &[(&str, ShownFile)]) -> HashMap<String, ShownFile> {
        pairs
            .iter()
            .map(|(label, file)| ((*label).to_string(), file.clone()))
            .collect()
    }

    #[test]
    fn focuses_the_window_already_showing_the_file_whatever_its_label() {
        // The point of the registry: `diff-a` navigated to b.ts, so b.ts is on
        // screen under a label that says nothing about it.
        let map = shown(&[("diff-a", file("/r", "b.ts"))]);
        assert_eq!(
            decide(&map, &alive(&["diff-a"]), &file("/r", "b.ts"), "diff-b"),
            Route::Focus("diff-a".into())
        );
    }

    #[test]
    fn reuses_the_window_opened_for_this_file_that_has_navigated_away() {
        // Without this the caller would focus `diff-b`, which is showing a.ts, and
        // the user would be looking at a different file than the one they clicked.
        let map = shown(&[("diff-b", file("/r", "a.ts"))]);
        assert_eq!(
            decide(&map, &alive(&["diff-b"]), &file("/r", "b.ts"), "diff-b"),
            Route::Reuse("diff-b".into())
        );
    }

    #[test]
    fn focuses_a_live_label_that_has_not_registered_yet() {
        // A second click landing while the first window is still booting. Creating
        // here would open the duplicate the registry exists to prevent.
        assert_eq!(
            decide(&HashMap::new(), &alive(&["diff-b"]), &file("/r", "b.ts"), "diff-b"),
            Route::Focus("diff-b".into())
        );
    }

    #[test]
    fn creates_when_nothing_is_open_for_the_file() {
        assert_eq!(
            decide(&HashMap::new(), &alive(&[]), &file("/r", "b.ts"), "diff-b"),
            Route::Create
        );
    }

    #[test]
    fn ignores_a_record_whose_window_is_gone() {
        // The window that showed b.ts has been closed, so its record must not
        // resolve to a label that no longer exists.
        let map = shown(&[("diff-a", file("/r", "b.ts"))]);
        assert_eq!(
            decide(&map, &alive(&[]), &file("/r", "b.ts"), "diff-b"),
            Route::Create
        );
    }

    #[test]
    fn distinguishes_the_same_path_in_two_repositories() {
        // Every checkout has a src/main.rs. Focusing the other one would show, and
        // then write to, the wrong file.
        let map = shown(&[("diff-a", file("/other", "src/main.rs"))]);
        assert_eq!(
            decide(&map, &alive(&["diff-a"]), &file("/r", "src/main.rs"), "diff-b"),
            Route::Create
        );
    }

    #[test]
    fn records_the_file_a_window_shows() {
        let registry = DiffWindows::default();
        registry.set("diff-a".into(), file("/r", "a.ts"));
        assert_eq!(
            registry.route(&alive(&["diff-a"]), &file("/r", "a.ts"), "diff-a"),
            Route::Focus("diff-a".into())
        );
    }

    #[test]
    fn re_registering_replaces_rather_than_adds() {
        let registry = DiffWindows::default();
        registry.set("diff-a".into(), file("/r", "a.ts"));
        registry.set("diff-a".into(), file("/r", "b.ts"));
        assert_eq!(registry.recorded(), 1);
        assert_eq!(
            registry.route(&alive(&["diff-a"]), &file("/r", "b.ts"), "diff-b"),
            Route::Focus("diff-a".into())
        );
    }

    #[test]
    fn two_windows_showing_two_files_do_not_collide() {
        let registry = DiffWindows::default();
        registry.set("diff-a".into(), file("/r", "a.ts"));
        registry.set("diff-b".into(), file("/r", "b.ts"));
        assert_eq!(
            registry.route(&alive(&["diff-a", "diff-b"]), &file("/r", "b.ts"), "diff-a"),
            Route::Focus("diff-b".into())
        );
    }

    #[test]
    fn removing_a_label_that_was_never_there_is_a_no_op() {
        let registry = DiffWindows::default();
        registry.remove("diff-never");
        assert_eq!(registry.recorded(), 0);
    }

    #[test]
    fn a_lookup_drops_the_records_whose_windows_have_gone() {
        // The backstop for anything `WindowEvent::Destroyed` misses — a crashed
        // webview, a teardown ordering surprise — and what keeps the map bounded.
        let registry = DiffWindows::default();
        registry.set("diff-a".into(), file("/r", "a.ts"));
        registry.set("diff-b".into(), file("/r", "b.ts"));

        registry.route(&alive(&["diff-b"]), &file("/r", "b.ts"), "diff-b");

        assert_eq!(registry.recorded(), 1);
    }
}
