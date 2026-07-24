//! Git status via the system `git` binary.
//!
//! Per CLAUDE.md: shell out to `git` with `cwd` at the repo root and parse only
//! machine-readable output (`--porcelain=v2 -z`), never localized text. The
//! `-z` variant is NUL-separated and never quotes paths, so we get raw bytes.
//!
//! The parser ([`parse_porcelain_v2`]) is pure and unit-tested against fixture
//! byte strings; the runners ([`resolve_repo_root`], [`run_status`]) are the
//! thin shell-out layer around it.
//!
//! Porcelain v2 record types we handle (run without `--branch`, so no headers):
//! - `1 <XY> …          <path>`            ordinary change
//! - `2 <XY> … <Xscore> <path>` + `<orig>` rename/copy (orig is the next token)
//! - `u <XY> …          <path>`            unmerged (conflict)
//! - `? <path>`                            untracked
//! - `! <path>`                            ignored (skipped; never requested)
//!
//! `<XY>` is two chars: `X` = staged/index status, `Y` = worktree/unstaged
//! status. A file mid-stage (e.g. `MM`) legitimately lands in both groups.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/// How a single path changed, in one group. Serialized `camelCase` for the
/// frontend (e.g. `typeChanged`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Unmerged,
}

/// One changed path within a group. `orig_path` is set only for renames/copies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    pub status: ChangeStatus,
}

/// The repo's working-tree status, split into staged (index) and unstaged
/// (worktree + untracked + conflicts) groups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub staged: Vec<FileEntry>,
    pub unstaged: Vec<FileEntry>,
}

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("'{0}' is not inside a git repository")]
    NotARepo(String),
    #[error("git executable not found; install Git and ensure it is on PATH")]
    GitNotFound,
    #[error("git exited with an error: {0}")]
    CommandFailed(String),
    #[error("failed to run git: {0}")]
    Io(String),
}

/// Resolve `start` to the enclosing repository root, then read its status.
pub fn status_from(start: &Path) -> Result<GitStatus, GitError> {
    let root = resolve_repo_root(start)?;
    run_status(&root)
}

/// `git -C <start> rev-parse --show-toplevel`. A non-zero exit means `start`
/// is not inside a repository (the common, non-exceptional case).
pub fn resolve_repo_root(start: &Path) -> Result<PathBuf, GitError> {
    let output = git_command(start)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::NotARepo(start.display().to_string()));
    }
    let root = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    Ok(PathBuf::from(root))
}

/// `git -C <root> status --porcelain=v2 -z`, parsed into groups.
pub fn run_status(root: &Path) -> Result<GitStatus, GitError> {
    let output = git_command(root)
        .args(["status", "--porcelain=v2", "-z"])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let (staged, unstaged) = parse_porcelain_v2(&output.stdout);
    Ok(GitStatus {
        repo_root: root.to_string_lossy().into_owned(),
        staged,
        unstaged,
    })
}

/// A `git` invocation rooted at `dir`, with stdin closed so it can never block
/// waiting for input. On Windows, `CREATE_NO_WINDOW` stops a console flashing.
fn git_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn map_io_err(e: std::io::Error) -> GitError {
    if e.kind() == std::io::ErrorKind::NotFound {
        GitError::GitNotFound
    } else {
        GitError::Io(e.to_string())
    }
}

/// Parse `git status --porcelain=v2 -z` output into (staged, unstaged) groups.
pub fn parse_porcelain_v2(bytes: &[u8]) -> (Vec<FileEntry>, Vec<FileEntry>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    // Tokens are NUL-terminated; `split` also yields a trailing empty slice.
    let mut tokens = bytes.split(|&b| b == 0).filter(|t| !t.is_empty());

    while let Some(token) = tokens.next() {
        match token.first() {
            Some(b'1') => {
                let line = String::from_utf8_lossy(token);
                if let Some((xy, path)) = fields(&line, 9) {
                    push_xy(xy, path, &None, &mut staged, &mut unstaged);
                }
            }
            Some(b'2') => {
                // Rename/copy: the original path is the following NUL token.
                let line = String::from_utf8_lossy(token).into_owned();
                let orig = tokens
                    .next()
                    .map(|t| String::from_utf8_lossy(t).into_owned());
                if let Some((xy, path)) = fields(&line, 10) {
                    push_xy(xy, path, &orig, &mut staged, &mut unstaged);
                }
            }
            Some(b'u') => {
                // Conflicts are surfaced once, in the Changes group. Real
                // conflict handling is Part 6.
                let line = String::from_utf8_lossy(token);
                if let Some((_, path)) = fields(&line, 11) {
                    unstaged.push(FileEntry {
                        path: path.to_string(),
                        orig_path: None,
                        status: ChangeStatus::Unmerged,
                    });
                }
            }
            Some(b'?') => {
                // `? <path>` — skip the two-byte "? " prefix.
                let line = String::from_utf8_lossy(token);
                if let Some(path) = line.get(2..) {
                    unstaged.push(FileEntry {
                        path: path.to_string(),
                        orig_path: None,
                        status: ChangeStatus::Untracked,
                    });
                }
            }
            // '!' ignored entries (never requested) and any unknown record.
            _ => {}
        }
    }

    (staged, unstaged)
}

/// Split a space-delimited record into exactly `count` fields (the last field
/// keeps any embedded spaces, e.g. paths). Returns `(xy, last_field)`.
fn fields(line: &str, count: usize) -> Option<(&str, &str)> {
    let parts: Vec<&str> = line.splitn(count, ' ').collect();
    if parts.len() < count {
        return None;
    }
    Some((parts[1], parts[count - 1]))
}

/// Emit staged/unstaged entries for one `<XY>` code. `X` drives the staged
/// group, `Y` the unstaged group; `.` (unmodified) yields nothing on that side.
fn push_xy(
    xy: &str,
    path: &str,
    orig: &Option<String>,
    staged: &mut Vec<FileEntry>,
    unstaged: &mut Vec<FileEntry>,
) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if let Some(status) = char_to_status(x) {
        staged.push(FileEntry {
            path: path.to_string(),
            orig_path: orig.clone(),
            status,
        });
    }
    if let Some(status) = char_to_status(y) {
        unstaged.push(FileEntry {
            path: path.to_string(),
            orig_path: orig.clone(),
            status,
        });
    }
}

fn char_to_status(c: char) -> Option<ChangeStatus> {
    match c {
        'A' => Some(ChangeStatus::Added),
        'M' => Some(ChangeStatus::Modified),
        'D' => Some(ChangeStatus::Deleted),
        'R' => Some(ChangeStatus::Renamed),
        'C' => Some(ChangeStatus::Copied),
        'T' => Some(ChangeStatus::TypeChanged),
        // '.' unmodified, ' ' padding, anything else: nothing on this side.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build NUL-terminated porcelain output from record strings. Rename
    /// records pass their original path as a separate element (its own token).
    fn z(records: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for r in records {
            v.extend_from_slice(r.as_bytes());
            v.push(0);
        }
        v
    }

    #[test]
    fn empty_input_yields_no_entries() {
        assert_eq!(parse_porcelain_v2(&[]), (vec![], vec![]));
        assert_eq!(parse_porcelain_v2(&z(&[])), (vec![], vec![]));
    }

    #[test]
    fn unstaged_modification_goes_to_unstaged_only() {
        let (staged, unstaged) =
            parse_porcelain_v2(&z(&["1 .M N... 100644 100644 100644 h h file.txt"]));
        assert!(staged.is_empty());
        assert_eq!(
            unstaged,
            vec![FileEntry {
                path: "file.txt".into(),
                orig_path: None,
                status: ChangeStatus::Modified,
            }]
        );
    }

    #[test]
    fn staged_addition_goes_to_staged_only() {
        let (staged, unstaged) =
            parse_porcelain_v2(&z(&["1 A. N... 000000 100644 100644 h h new.txt"]));
        assert_eq!(
            staged,
            vec![FileEntry {
                path: "new.txt".into(),
                orig_path: None,
                status: ChangeStatus::Added,
            }]
        );
        assert!(unstaged.is_empty());
    }

    #[test]
    fn staged_and_unstaged_same_file_appears_in_both_groups() {
        let (staged, unstaged) =
            parse_porcelain_v2(&z(&["1 MM N... 100644 100644 100644 h h both.txt"]));
        assert_eq!(staged.len(), 1);
        assert_eq!(unstaged.len(), 1);
        assert_eq!(staged[0].path, "both.txt");
        assert_eq!(staged[0].status, ChangeStatus::Modified);
        assert_eq!(unstaged[0].path, "both.txt");
        assert_eq!(unstaged[0].status, ChangeStatus::Modified);
    }

    #[test]
    fn staged_and_unstaged_deletions_map_to_the_right_group() {
        let (staged, _) = parse_porcelain_v2(&z(&["1 D. N... 100644 000000 000000 h h gone.txt"]));
        assert_eq!(staged[0].status, ChangeStatus::Deleted);
        let (_, unstaged) =
            parse_porcelain_v2(&z(&["1 .D N... 100644 100644 000000 h h vanished.txt"]));
        assert_eq!(unstaged[0].status, ChangeStatus::Deleted);
    }

    #[test]
    fn rename_carries_orig_path_and_consumes_the_extra_token() {
        let (staged, unstaged) = parse_porcelain_v2(&z(&[
            "2 R. N... 100644 100644 100644 h h R100 renamed.txt",
            "original.txt",
        ]));
        // The trailing "original.txt" token must be consumed as orig_path, not
        // parsed as a separate (untracked) entry.
        assert!(unstaged.is_empty());
        assert_eq!(
            staged,
            vec![FileEntry {
                path: "renamed.txt".into(),
                orig_path: Some("original.txt".into()),
                status: ChangeStatus::Renamed,
            }]
        );
    }

    #[test]
    fn untracked_file_goes_to_unstaged() {
        let (staged, unstaged) = parse_porcelain_v2(&z(&["? brand-new.txt"]));
        assert!(staged.is_empty());
        assert_eq!(
            unstaged,
            vec![FileEntry {
                path: "brand-new.txt".into(),
                orig_path: None,
                status: ChangeStatus::Untracked,
            }]
        );
    }

    #[test]
    fn unmerged_file_is_a_single_conflict_in_unstaged() {
        let (staged, unstaged) = parse_porcelain_v2(&z(&[
            "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
        ]));
        assert!(staged.is_empty());
        assert_eq!(
            unstaged,
            vec![FileEntry {
                path: "conflict.txt".into(),
                orig_path: None,
                status: ChangeStatus::Unmerged,
            }]
        );
    }

    #[test]
    fn non_utf8_path_degrades_lossily_without_panicking() {
        // -z emits raw bytes and never quotes, so a path can be invalid UTF-8.
        let mut bytes = b"1 .M N... 100644 100644 100644 h h caf".to_vec();
        bytes.push(0xFF); // invalid UTF-8 byte inside the path
        bytes.extend_from_slice(b".txt");
        bytes.push(0);

        let (_, unstaged) = parse_porcelain_v2(&bytes);
        assert_eq!(unstaged.len(), 1);
        assert_eq!(unstaged[0].status, ChangeStatus::Modified);
        // The bad byte becomes U+FFFD; parsing must not panic.
        assert!(unstaged[0].path.starts_with("caf"));
        assert!(unstaged[0].path.contains('\u{FFFD}'));
    }

    #[test]
    fn path_with_spaces_is_preserved() {
        let (_, unstaged) =
            parse_porcelain_v2(&z(&["1 .M N... 100644 100644 100644 h h my notes.txt"]));
        assert_eq!(unstaged[0].path, "my notes.txt");
    }

    #[test]
    fn mixed_batch_parses_every_record_in_order() {
        let (staged, unstaged) = parse_porcelain_v2(&z(&[
            "1 A. N... 000000 100644 100644 h h added.txt",
            "1 .M N... 100644 100644 100644 h h edited.txt",
            "2 R. N... 100644 100644 100644 h h R100 new-name.txt",
            "old-name.txt",
            "? untracked.txt",
        ]));
        assert_eq!(
            staged
                .iter()
                .map(|e| (e.path.as_str(), e.status))
                .collect::<Vec<_>>(),
            vec![
                ("added.txt", ChangeStatus::Added),
                ("new-name.txt", ChangeStatus::Renamed),
            ]
        );
        assert_eq!(
            unstaged
                .iter()
                .map(|e| (e.path.as_str(), e.status))
                .collect::<Vec<_>>(),
            vec![
                ("edited.txt", ChangeStatus::Modified),
                ("untracked.txt", ChangeStatus::Untracked),
            ]
        );
    }
}
