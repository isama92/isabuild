//! The open project: which folder the workspace is looking at.
//!
//! Before Part 8 there was no such thing. The repo came from
//! `spawn::default_cwd()` (the app's launch directory), and the git panel and
//! the two PTYs agreed only because they both called that same function. The
//! project now lives in managed state and those two callers read it instead, so
//! the agreement survives the user changing their mind.
//!
//! A project must be inside a git repository: every panel in the workspace is
//! git, so a plain folder would open into a shell with nothing around it.
//! [`open`] therefore resolves the enclosing repo root, and **that** is the
//! project. Picking a subdirectory opens the repo it belongs to rather than
//! creating a second, near-identical entry in the recents list.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::git::{self, GitError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// `git rev-parse --show-toplevel`. What every git command in the app is
    /// rooted at, what both PTYs start in, and what is stored in the recents.
    pub repo_root: String,
    /// Display name: the last component of the repo root.
    pub name: String,
}

/// Whether a remembered project can still be opened, and if not, why.
///
/// Three states rather than a boolean because the two failures need different
/// words: a folder that has been deleted or unmounted is "missing", while one
/// that is still there but is no longer part of a repository (a `.git` removed,
/// a worktree pruned) is a different problem with a different fix. Both are
/// shown dimmed and marked rather than dropped, so a project on an unmounted
/// drive does not silently disappear from the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecentState {
    Ok,
    Missing,
    NotARepo,
}

/// A row on the welcome screen and in the Open Recent submenu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub state: RecentState,
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("'{0}' no longer exists")]
    Missing(String),
    #[error("'{0}' is not a folder")]
    NotADirectory(String),
    #[error("'{0}' is not inside a git repository. Open a folder that is part of one, or run 'git init' there first.")]
    NotARepo(String),
    #[error("{0}")]
    Git(#[source] GitError),
}

/// Last path component, for display. Falls back to the whole path for a
/// filesystem root, which has no component to show.
pub fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.to_string())
}

/// Validate `path` and resolve its repository.
///
/// The three failures are distinguished because the welcome screen says
/// something different for each: a deleted folder, a file dragged in by
/// mistake, and a folder that simply is not a repo.
pub fn open(path: &str) -> Result<Project, ProjectError> {
    let candidate = PathBuf::from(path);
    if !candidate.exists() {
        return Err(ProjectError::Missing(path.to_string()));
    }
    if !candidate.is_dir() {
        return Err(ProjectError::NotADirectory(path.to_string()));
    }
    let repo_root = git::resolve_repo_root(&candidate).map_err(|err| match err {
        GitError::NotARepo(_) => ProjectError::NotARepo(path.to_string()),
        other => ProjectError::Git(other),
    })?;
    let repo_root = repo_root.to_string_lossy().into_owned();
    Ok(Project {
        name: folder_name(&repo_root),
        repo_root,
    })
}

/// The repository `path` belongs to, if any, without making it the project.
///
/// Backs the welcome screen's "open the folder isabuild was launched from"
/// suggestion. It returns the *repo root* rather than the launch directory so
/// the suggestion is the same string a recents entry holds: launching from a
/// subdirectory would otherwise offer a row that duplicates one already in the
/// list, and on Windows git's forward slashes would never match either.
pub fn repo_root_of(path: &Path) -> Option<PathBuf> {
    if !path.is_dir() {
        return None;
    }
    git::resolve_repo_root(path).ok()
}

/// Turn stored paths into welcome-screen rows, checking whether each is still
/// openable.
///
/// Runs `git rev-parse` per surviving entry, so it is called on the paths the
/// user is about to look at, not on every settings save. See `MenuState`.
pub fn describe(paths: &[String]) -> Vec<RecentProject> {
    paths
        .iter()
        .map(|path| {
            let candidate = Path::new(path);
            let state = if !candidate.is_dir() {
                RecentState::Missing
            } else if git::resolve_repo_root(candidate).is_err() {
                RecentState::NotARepo
            } else {
                RecentState::Ok
            };
            RecentProject {
                name: folder_name(path),
                path: path.clone(),
                state,
            }
        })
        .collect()
}

/// Managed state holding the open project, or `None` on the welcome screen.
#[derive(Default)]
pub struct ActiveProject(Mutex<Option<Project>>);

impl ActiveProject {
    pub fn get(&self) -> Option<Project> {
        self.0
            .lock()
            .expect("active project mutex poisoned")
            .clone()
    }

    pub fn set(&self, project: Project) {
        *self.0.lock().expect("active project mutex poisoned") = Some(project);
    }

    pub fn clear(&self) {
        *self.0.lock().expect("active project mutex poisoned") = None;
    }

    /// Repo root of the open project. The fallback for `git_status(None)` and
    /// `pty_spawn(cwd: None)`, both of which error when it is `None` rather
    /// than guessing a directory the user never chose.
    pub fn repo_root(&self) -> Option<PathBuf> {
        self.get().map(|p| PathBuf::from(p.repo_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo;

    #[test]
    fn folder_name_is_the_last_component() {
        assert_eq!(folder_name("/home/dev/isabuild"), "isabuild");
        assert_eq!(folder_name("/home/dev/isabuild/"), "isabuild");
    }

    #[test]
    fn folder_name_falls_back_to_the_whole_path_for_a_root() {
        assert_eq!(folder_name("/"), "/");
    }

    #[test]
    fn opening_a_repo_resolves_its_toplevel() {
        let repo = testrepo::repo_with_commit("file.txt", "one\n");
        let path = repo.path().to_string_lossy().into_owned();

        let project = open(&path).expect("a repo opens");
        // Canonicalised by git (macOS resolves /var to /private/var), so compare
        // the resolved forms rather than the strings.
        assert_eq!(
            std::fs::canonicalize(&project.repo_root).expect("canonical repo root"),
            std::fs::canonicalize(&path).expect("canonical path")
        );
        assert!(!project.name.is_empty());
    }

    #[test]
    fn opening_a_subdirectory_resolves_up_to_the_repo_root() {
        let repo = testrepo::repo_with_commit("file.txt", "one\n");
        let nested = repo.path().join("nested");
        std::fs::create_dir(&nested).expect("create nested dir");

        let project = open(&nested.to_string_lossy()).expect("a subdirectory opens");
        assert_eq!(
            std::fs::canonicalize(&project.repo_root).expect("canonical repo root"),
            std::fs::canonicalize(repo.path()).expect("canonical repo path"),
            "the project is rooted at the repo, not the folder that was picked"
        );
    }

    #[test]
    fn a_plain_folder_is_refused_as_not_a_repo() {
        let dir = tempfile::tempdir().expect("temp dir");
        // A temp dir could sit inside someone's repo checkout; only assert the
        // variant when git agrees it is not in one.
        match open(&dir.path().to_string_lossy()) {
            Err(ProjectError::NotARepo(_)) => {}
            Ok(_) => { /* the temp dir happened to be inside a repo */ }
            Err(other) => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn a_missing_folder_is_distinguished_from_a_non_repo() {
        let err = open("/no/such/isabuild/project").expect_err("missing folder");
        assert!(matches!(err, ProjectError::Missing(_)), "got {err}");
    }

    #[test]
    fn a_file_is_refused_as_not_a_folder() {
        let file = tempfile::NamedTempFile::new().expect("temp file");
        let err = open(&file.path().to_string_lossy()).expect_err("a file is not a project");
        assert!(matches!(err, ProjectError::NotADirectory(_)), "got {err}");
    }

    #[test]
    fn describe_marks_a_missing_entry_without_dropping_it() {
        let repo = testrepo::repo_with_commit("file.txt", "one\n");
        let present = repo.path().to_string_lossy().into_owned();
        let rows = describe(&[present.clone(), "/no/such/isabuild/project".to_string()]);

        assert_eq!(rows.len(), 2, "a missing project stays in the list");
        assert_eq!(rows[0].state, RecentState::Ok);
        assert_eq!(rows[0].path, present);
        assert_eq!(rows[1].state, RecentState::Missing);
        assert_eq!(rows[1].name, "project");
    }

    #[test]
    fn describe_distinguishes_a_folder_that_is_no_longer_a_repo() {
        // A `.git` deleted, or a worktree pruned: the folder is right there,
        // but clicking it would fail every time. "Missing" would be a lie.
        let repo = testrepo::repo_with_commit("file.txt", "one\n");
        let path = repo.path().to_string_lossy().into_owned();
        assert_eq!(
            describe(std::slice::from_ref(&path))[0].state,
            RecentState::Ok
        );

        std::fs::remove_dir_all(repo.path().join(".git")).expect("remove .git");

        let rows = describe(&[path]);
        // Skipped when the temp dir itself sits inside someone's checkout, in
        // which case rev-parse still succeeds and the state is legitimately Ok.
        if rows[0].state != RecentState::Ok {
            assert_eq!(rows[0].state, RecentState::NotARepo);
        }
    }

    #[test]
    fn repo_root_of_resolves_a_subdirectory_up_to_the_repo() {
        let repo = testrepo::repo_with_commit("file.txt", "one\n");
        let nested = repo.path().join("nested");
        std::fs::create_dir(&nested).expect("create nested dir");

        let resolved = repo_root_of(&nested).expect("a subdirectory of a repo resolves");
        assert_eq!(
            std::fs::canonicalize(&resolved).expect("canonical resolved"),
            std::fs::canonicalize(repo.path()).expect("canonical repo"),
            "the suggestion must be the same string a recents entry holds"
        );
    }

    #[test]
    fn repo_root_of_declines_a_path_that_is_not_a_folder() {
        assert!(repo_root_of(Path::new("/no/such/isabuild/project")).is_none());
    }

    #[test]
    fn the_active_project_starts_empty_and_clears_again() {
        let active = ActiveProject::default();
        assert!(active.get().is_none());
        assert!(active.repo_root().is_none());

        active.set(Project {
            repo_root: "/repos/one".into(),
            name: "one".into(),
        });
        assert_eq!(active.repo_root(), Some(PathBuf::from("/repos/one")));

        active.clear();
        assert!(active.get().is_none());
    }
}
