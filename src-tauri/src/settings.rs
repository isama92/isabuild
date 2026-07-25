//! Persistent user settings: appearance, keybinding overrides, and which
//! project to reopen.
//!
//! Stored as `config.json` in Tauri's per-OS app config directory
//! (`~/.config/com.isabuild.desktop/` on Linux, `~/Library/Application
//! Support/com.isabuild.desktop/` on macOS, `%APPDATA%\com.isabuild.desktop\`
//! on Windows). A hand-rolled serde struct rather than a store plugin: the
//! shape is small, the whole thing is unit-testable without a Tauri app, and
//! the file stays something a person can read and edit.
//!
//! Two rules the rest of the app depends on:
//!
//! * **Every field is optional on read.** `#[serde(default)]` on the container
//!   means a file written by an older build, or hand-edited down to one key,
//!   still loads. Unknown keys are ignored rather than rejected.
//! * **A file we cannot parse is never overwritten in place.** [`load`] renames
//!   it to `config.json.bak` first, so a hand-edit that broke the JSON can be
//!   recovered.
//!
//! Like `watcher.rs` and `pty.rs`, this module has no Tauri dependency: paths
//! come in from the caller.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// How many projects the welcome screen and the Open Recent submenu remember.
pub const MAX_RECENT: usize = 5;
/// Id of the theme a fresh install starts on. Must exist in the frontend's
/// theme registry (`src/theme/themes.ts`).
pub const DEFAULT_THEME: &str = "vscode-dark";
pub const DEFAULT_FONT_SIZE: u16 = 14;
/// Font sizes outside this range make the app unusable, and a bad value in a
/// hand-edited file should not need a reinstall to escape.
pub const MIN_FONT_SIZE: u16 = 6;
pub const MAX_FONT_SIZE: u16 = 40;
/// Bumped only for a change old files cannot be read through. Nothing migrates
/// on version 1; the field exists so a future change has somewhere to look.
const SCHEMA_VERSION: u32 = 1;

pub const FILE_NAME: &str = "config.json";
const BACKUP_NAME: &str = "config.json.bak";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    /// Theme id from the frontend registry.
    pub theme: String,
    /// Monospace family for terminals and both editors. Empty means "the
    /// built-in stack", which is not a family name, so it cannot collide with
    /// a real one.
    pub font_family: String,
    pub font_size: u16,
    /// Keybinding **overrides** only, action id to accelerator. An action with
    /// no entry uses its default; an entry mapped to an empty string is unbound.
    pub keybindings: BTreeMap<String, String>,
    /// Project to reopen on launch. Cleared by Close Project.
    pub last_project: Option<String>,
    /// Most recently opened first, at most [`MAX_RECENT`].
    pub recent_projects: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            theme: DEFAULT_THEME.to_string(),
            font_family: String::new(),
            font_size: DEFAULT_FONT_SIZE,
            keybindings: BTreeMap::new(),
            last_project: None,
            recent_projects: Vec::new(),
        }
    }
}

/// A partial update from the settings window. Absent fields are left alone, so
/// two windows editing different fields cannot clobber each other, and the
/// frontend can never accidentally blank the project list by omitting it.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub font_family: Option<String>,
    pub font_size: Option<u16>,
    /// Replaces the whole override map: the keybindings tab always knows the
    /// full set, and a per-key patch could not express "back to default".
    pub keybindings: Option<BTreeMap<String, String>>,
}

impl Settings {
    /// Apply a patch, clamping anything that would make the app unusable.
    pub fn apply(&mut self, patch: SettingsPatch) {
        if let Some(theme) = patch.theme {
            self.theme = theme;
        }
        if let Some(family) = patch.font_family {
            self.font_family = family.trim().to_string();
        }
        if let Some(size) = patch.font_size {
            self.font_size = size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        }
        if let Some(bindings) = patch.keybindings {
            self.keybindings = bindings;
        }
    }

    /// Record `path` as the most recently opened project: moved to the front,
    /// never duplicated, list capped at [`MAX_RECENT`].
    pub fn push_recent(&mut self, path: &str) {
        self.recent_projects.retain(|p| !same_path(p, path));
        self.recent_projects.insert(0, path.to_string());
        self.recent_projects.truncate(MAX_RECENT);
    }

    /// Forget one entry. Returns whether anything was removed, so the caller
    /// can skip a save for a path that was not in the list.
    pub fn remove_recent(&mut self, path: &str) -> bool {
        let before = self.recent_projects.len();
        self.recent_projects.retain(|p| !same_path(p, path));
        self.recent_projects.len() != before
    }

    /// Whether `path` is the project that would reopen next launch.
    ///
    /// Uses the same comparison as the recents list, so a path removed from the
    /// list can never still be the one reopened.
    pub fn last_project_is(&self, path: &str) -> bool {
        self.last_project
            .as_deref()
            .is_some_and(|last| same_path(last, path))
    }

    /// Repair values a hand-edited file could hold. Applied on load so the rest
    /// of the app never sees a font size of 0 or a 200-entry recents list.
    fn normalise(&mut self) {
        self.font_family = self.font_family.trim().to_string();
        self.font_size = self.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        if self.theme.trim().is_empty() {
            self.theme = DEFAULT_THEME.to_string();
        }
        let mut unique: Vec<String> = Vec::new();
        for path in std::mem::take(&mut self.recent_projects) {
            if path.is_empty() || unique.iter().any(|kept| same_path(kept, &path)) {
                continue;
            }
            unique.push(path);
        }
        unique.truncate(MAX_RECENT);
        self.recent_projects = unique;
    }
}

/// Whether two stored paths name the same directory.
///
/// Canonicalising catches `~/Dev/app` against `~/Dev/./app` and, on Windows,
/// a case difference. It fails for a folder that has since been deleted, and a
/// missing recent entry must still be removable by its `×`, so the raw strings
/// are the fallback rather than the error.
fn same_path(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (
        std::fs::canonicalize(Path::new(a)),
        std::fs::canonicalize(Path::new(b)),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("could not create the settings directory '{0}': {1}")]
    Directory(String, String),
    #[error("could not write settings to '{0}': {1}")]
    Write(String, String),
    #[error("could not encode settings: {0}")]
    Encode(String),
}

/// Outcome of a load: always usable settings, plus a message when the file on
/// disk was not.
#[derive(Debug)]
pub struct Loaded {
    pub settings: Settings,
    /// User-facing explanation of why defaults are in use, or `None` on a clean
    /// load (including "no file yet", which is not a problem).
    pub warning: Option<String>,
}

/// Read `path`, falling back to defaults for anything that goes wrong.
///
/// Settings are never load-bearing enough to refuse to start over: a corrupt
/// file loses the user's theme, not their work. The broken file is preserved as
/// `config.json.bak` and the warning names it.
pub fn load(path: &Path) -> Loaded {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Loaded {
                settings: Settings::default(),
                warning: None,
            }
        }
        Err(err) => {
            return Loaded {
                settings: Settings::default(),
                warning: Some(format!(
                    "could not read settings from '{}': {err}. Using defaults.",
                    path.display()
                )),
            }
        }
    };

    match serde_json::from_str::<Settings>(&raw) {
        Ok(mut settings) => {
            settings.normalise();
            Loaded {
                settings,
                warning: None,
            }
        }
        Err(err) => {
            let backup = path.with_file_name(BACKUP_NAME);
            let kept = std::fs::rename(path, &backup).is_ok();
            let where_it_went = if kept {
                format!(" The previous file was kept as '{}'.", backup.display())
            } else {
                String::new()
            };
            Loaded {
                settings: Settings::default(),
                warning: Some(format!(
                    "settings at '{}' could not be read ({err}). Using defaults.{where_it_went}",
                    path.display()
                )),
            }
        }
    }
}

/// Write settings atomically: a sibling temp file, then a rename.
///
/// Same reasoning as `diff::write_worktree_file` — a truncate-then-write leaves
/// a window in which a crash produces a zero-length config, which on next
/// launch reads as "corrupt" and loses the project list.
pub fn save(path: &Path, settings: &Settings) -> Result<(), SettingsError> {
    let directory = path.parent().ok_or_else(|| {
        SettingsError::Directory(path.display().to_string(), "no parent directory".into())
    })?;
    std::fs::create_dir_all(directory)
        .map_err(|e| SettingsError::Directory(directory.display().to_string(), e.to_string()))?;

    let json =
        serde_json::to_string_pretty(settings).map_err(|e| SettingsError::Encode(e.to_string()))?;
    let write_err =
        |e: std::io::Error| SettingsError::Write(path.display().to_string(), e.to_string());

    let temp = tempfile::Builder::new()
        .prefix(".isabuild-config-")
        .tempfile_in(directory)
        .map_err(write_err)?;
    std::fs::write(temp.path(), json.as_bytes()).map_err(write_err)?;
    temp.persist(path)
        .map_err(|e| SettingsError::Write(path.display().to_string(), e.error.to_string()))?;
    Ok(())
}

/// Managed state: the settings and where they came from.
///
/// Every mutation goes through [`SettingsStore::update`], which writes the file
/// before returning, so a crash cannot lose a setting the user has already seen
/// take effect.
pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
    /// Why the file on disk was not usable, kept from load so the frontend can
    /// show it once the UI exists. Startup is too early to tell anyone.
    warning: Option<String>,
}

impl SettingsStore {
    /// Load from `path`, keeping the load warning for the frontend to surface.
    pub fn load_from(path: PathBuf) -> Self {
        let Loaded { settings, warning } = load(&path);
        Self {
            path,
            inner: Mutex::new(settings),
            warning,
        }
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().expect("settings mutex poisoned").clone()
    }

    pub fn warning(&self) -> Option<&str> {
        self.warning.as_deref()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Mutate and persist. The lock is released before the write returns to the
    /// caller, but is held across the write itself so two concurrent updates
    /// cannot interleave into a file that matches neither.
    pub fn update<F>(&self, change: F) -> Result<Settings, SettingsError>
    where
        F: FnOnce(&mut Settings),
    {
        let mut guard = self.inner.lock().expect("settings mutex poisoned");
        change(&mut guard);
        save(&self.path, &guard)?;
        Ok(guard.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_recents(paths: &[&str]) -> Settings {
        Settings {
            recent_projects: paths.iter().map(|p| p.to_string()).collect(),
            ..Settings::default()
        }
    }

    #[test]
    fn defaults_are_dark_theme_and_the_builtin_font_stack() {
        let settings = Settings::default();
        assert_eq!(settings.theme, DEFAULT_THEME);
        assert_eq!(settings.font_size, DEFAULT_FONT_SIZE);
        assert!(settings.font_family.is_empty());
        assert!(settings.recent_projects.is_empty());
        assert_eq!(settings.last_project, None);
    }

    #[test]
    fn a_partial_file_fills_the_rest_from_defaults() {
        let settings: Settings =
            serde_json::from_str(r#"{"theme":"vscode-light"}"#).expect("parse");
        assert_eq!(settings.theme, "vscode-light");
        assert_eq!(settings.font_size, DEFAULT_FONT_SIZE);
        assert_eq!(settings.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn an_unknown_key_is_ignored_rather_than_rejected() {
        let settings: Settings =
            serde_json::from_str(r#"{"theme":"vscode-light","somethingNew":42}"#).expect("parse");
        assert_eq!(settings.theme, "vscode-light");
    }

    #[test]
    fn settings_round_trip_through_json() {
        let mut original = Settings {
            font_family: "Fira Code Nerd Font".into(),
            last_project: Some("/repos/one".into()),
            ..Settings::default()
        };
        original
            .keybindings
            .insert("toggle-terminal".into(), "Alt+T".into());
        original.push_recent("/repos/one");

        let encoded = serde_json::to_string(&original).expect("encode");
        let decoded: Settings = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn push_recent_moves_an_existing_entry_to_the_front() {
        let mut settings = with_recents(&["/a", "/b", "/c"]);
        settings.push_recent("/c");
        assert_eq!(settings.recent_projects, vec!["/c", "/a", "/b"]);
    }

    #[test]
    fn push_recent_caps_the_list_at_five() {
        let mut settings = with_recents(&["/a", "/b", "/c", "/d", "/e"]);
        settings.push_recent("/f");
        assert_eq!(settings.recent_projects, vec!["/f", "/a", "/b", "/c", "/d"]);
        assert_eq!(settings.recent_projects.len(), MAX_RECENT);
    }

    #[test]
    fn remove_recent_reports_whether_it_removed_anything() {
        let mut settings = with_recents(&["/a", "/b"]);
        assert!(settings.remove_recent("/a"));
        assert_eq!(settings.recent_projects, vec!["/b"]);
        assert!(!settings.remove_recent("/a"));
    }

    #[test]
    fn a_deleted_folder_can_still_be_removed_from_recents() {
        // canonicalize() fails for both sides here, so the raw-string fallback
        // is what makes the welcome screen's × work on a missing project.
        let mut settings = with_recents(&["/no/such/isabuild/project"]);
        assert!(settings.remove_recent("/no/such/isabuild/project"));
        assert!(settings.recent_projects.is_empty());
    }

    #[test]
    fn apply_only_touches_the_fields_the_patch_carries() {
        let mut settings = Settings::default();
        settings.push_recent("/a");
        settings.apply(SettingsPatch {
            theme: Some("vscode-light".into()),
            ..SettingsPatch::default()
        });
        assert_eq!(settings.theme, "vscode-light");
        assert_eq!(settings.font_size, DEFAULT_FONT_SIZE);
        assert_eq!(settings.recent_projects, vec!["/a"]);
    }

    #[test]
    fn apply_clamps_an_unusable_font_size() {
        let mut settings = Settings::default();
        settings.apply(SettingsPatch {
            font_size: Some(0),
            ..SettingsPatch::default()
        });
        assert_eq!(settings.font_size, MIN_FONT_SIZE);
        settings.apply(SettingsPatch {
            font_size: Some(900),
            ..SettingsPatch::default()
        });
        assert_eq!(settings.font_size, MAX_FONT_SIZE);
    }

    #[test]
    fn apply_trims_the_font_family_so_a_stray_space_is_not_a_family() {
        let mut settings = Settings::default();
        settings.apply(SettingsPatch {
            font_family: Some("  ".into()),
            ..SettingsPatch::default()
        });
        assert!(
            settings.font_family.is_empty(),
            "blank means the built-in stack"
        );
    }

    #[test]
    fn normalise_repairs_a_hand_edited_file() {
        let raw = r#"{
            "theme": "  ",
            "fontSize": 0,
            "recentProjects": ["/a", "/a", "/b", "/c", "/d", "/e", "/f"]
        }"#;
        let mut settings: Settings = serde_json::from_str(raw).expect("parse");
        settings.normalise();
        assert_eq!(settings.theme, DEFAULT_THEME);
        assert_eq!(settings.font_size, MIN_FONT_SIZE);
        assert_eq!(settings.recent_projects, vec!["/a", "/b", "/c", "/d", "/e"]);
    }

    #[test]
    fn a_missing_file_loads_defaults_without_a_warning() {
        let dir = tempfile::tempdir().expect("temp dir");
        let loaded = load(&dir.path().join(FILE_NAME));
        assert_eq!(loaded.settings, Settings::default());
        assert!(loaded.warning.is_none(), "no file yet is not a problem");
    }

    #[test]
    fn a_corrupt_file_is_kept_as_a_backup_and_never_overwritten_in_place() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, b"{ this is not json").expect("write");

        let loaded = load(&path);
        assert_eq!(loaded.settings, Settings::default());
        let warning = loaded.warning.expect("a corrupt file must be reported");
        assert!(
            warning.contains("config.json.bak"),
            "warning names the backup: {warning}"
        );
        assert!(
            !path.exists(),
            "the corrupt file is moved, not left in place"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(BACKUP_NAME)).expect("backup"),
            "{ this is not json"
        );
    }

    #[test]
    fn save_then_load_round_trips_through_a_real_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(FILE_NAME);
        let mut settings = Settings {
            theme: "vscode-light".into(),
            ..Settings::default()
        };
        settings.push_recent("/repos/one");

        save(&path, &settings).expect("save");
        assert_eq!(load(&path).settings, settings);
    }

    #[test]
    fn save_creates_the_config_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("nested").join("deeper").join(FILE_NAME);
        save(&path, &Settings::default()).expect("save creates parents");
        assert!(path.exists());
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().expect("temp dir");
        save(&dir.path().join(FILE_NAME), &Settings::default()).expect("save");
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(entries, vec![FILE_NAME.to_string()]);
    }

    #[test]
    fn the_store_persists_every_update() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join(FILE_NAME);
        let store = SettingsStore::load_from(path.clone());
        assert!(store.warning().is_none());

        store
            .update(|s| s.push_recent("/repos/one"))
            .expect("update saves");

        // A second store reading the same file sees it, i.e. the write happened
        // during update(), not at some later shutdown.
        let reloaded = SettingsStore::load_from(path);
        assert_eq!(reloaded.get().recent_projects, vec!["/repos/one"]);
    }
}
