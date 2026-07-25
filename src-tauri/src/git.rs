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
//!
//! On a `u` record the same two letters mean something else entirely: which
//! *side* of the merge touched the path (see [`ConflictKind`]). Conflicts get
//! their own group for that reason — `UU` has markers in the file to accept while
//! `UD` has no text at all, and Part 6 cannot offer the right action without the
//! distinction.

use std::collections::HashSet;
use std::io::Write as _;
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

/// Which sides of a merge touched a conflicted path, from the `<XY>` of a
/// porcelain v2 `u` record. git's documented table (`git status` short format):
///
/// | XY | meaning        | XY | meaning       |
/// |----|----------------|----|---------------|
/// | `UU` | both modified  | `AA` | both added    |
/// | `DD` | both deleted   | `AU` | added by us   |
/// | `UA` | added by them  | `UD` | deleted by them |
/// | `DU` | deleted by us  |    |               |
///
/// The distinction is what decides how a conflict can be resolved at all: the
/// first two have conflict markers in the working-tree file, the rest have no
/// text to merge and only a whole-file choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    BothDeleted,
    AddedByUs,
    AddedByThem,
    DeletedByUs,
    DeletedByThem,
    /// An `<XY>` git has never documented. Rendered as a conflict with no
    /// assumed shape rather than dropped, so it cannot silently disappear from
    /// the panel and strand the merge.
    Unknown,
}

impl ConflictKind {
    /// Whether the working-tree file holds conflict markers to resolve. The
    /// other kinds have no merged text at all, so they only take a whole-file
    /// decision.
    pub fn has_markers(self) -> bool {
        matches!(self, ConflictKind::BothModified | ConflictKind::BothAdded)
    }
}

/// One conflicted path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub path: String,
    pub kind: ConflictKind,
}

/// The repo's working-tree status: staged (index), unstaged (worktree +
/// untracked) and conflicts.
///
/// Conflicts are their own group rather than unstaged rows, so a path is
/// reported exactly once and the UI can offer the actions its kind supports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub staged: Vec<FileEntry>,
    pub unstaged: Vec<FileEntry>,
    pub conflicts: Vec<ConflictEntry>,
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
    /// A request we reject before running git at all (an unusable branch name,
    /// no remote to sync with). The message is already user-facing, so it is
    /// rendered without a prefix.
    #[error("{0}")]
    Invalid(String),
}

/// Resolve `start` to the enclosing repository root, then read its status.
pub fn status_from(start: &Path) -> Result<GitStatus, GitError> {
    let root = resolve_repo_root(start)?;
    run_status(&root)
}

/// Read the status of an **already-resolved** repository root, skipping the
/// `rev-parse --show-toplevel` that [`status_from`] spends on discovery.
///
/// Worth the separate entry point because this is the most frequent read in the
/// app: the watcher drives it, and halving its subprocess count matters most on
/// Windows, where spawning is the expensive part.
///
/// Discovery is still paid on the failure path, and only there. `run_status` on a
/// directory that is not a repository fails with git's own stderr, which is a worse
/// message than [`GitError::NotARepo`], so the question is asked once its answer
/// matters rather than never.
pub fn status_at(root: &Path) -> Result<GitStatus, GitError> {
    match run_status(root) {
        Err(GitError::CommandFailed(stderr)) => match resolve_repo_root(root) {
            Err(not_a_repo @ GitError::NotARepo(_)) => Err(not_a_repo),
            _ => Err(GitError::CommandFailed(stderr)),
        },
        other => other,
    }
}

/// `git -C <start> rev-parse --show-toplevel`. A non-zero exit means `start`
/// is not inside a repository (the common, non-exceptional case).
pub fn resolve_repo_root(start: &Path) -> Result<PathBuf, GitError> {
    let output = git_read_command(start)
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
    let output = git_read_command(root)
        .args(["status", "--porcelain=v2", "-z"])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    let (staged, unstaged, conflicts) = parse_porcelain_v2(&output.stdout);
    Ok(GitStatus {
        repo_root: root.to_string_lossy().into_owned(),
        staged,
        unstaged,
        conflicts,
    })
}

/// Which of `rel_slugs` git would ignore: `git check-ignore --stdin -z`.
///
/// Slugs are `/`-separated paths relative to `root`, and the returned set holds
/// exactly the subset git named, echoed back verbatim. Used by the watcher filter
/// to drop events for paths `status` would never report anyway.
///
/// Asking git rather than reading `.gitignore` ourselves is the rule this whole
/// module follows: the answer then always agrees with [`run_status`], nested,
/// global and `info/exclude` patterns included.
///
/// Note the deliberately absent `--no-index`. By default `check-ignore` consults
/// the index, so a *tracked* path matching an ignore pattern (`git add -f
/// node_modules/keep.js`) is reported as **not** ignored, which is exactly how
/// `status` treats it. `--no-index` answers the opposite question, and using it
/// here would hide real changes.
pub fn check_ignored(root: &Path, rel_slugs: &[String]) -> Result<HashSet<String>, GitError> {
    if rel_slugs.is_empty() {
        return Ok(HashSet::new());
    }

    let mut input = Vec::new();
    for slug in rel_slugs {
        input.extend_from_slice(slug.as_bytes());
        input.push(0);
    }

    let mut child = git_read_command(root)
        .args(["check-ignore", "--stdin", "-z"])
        // git_read_command closes stdin, and check-ignore has to read it. The
        // last call to Command::stdin wins.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(map_io_err)?;

    let mut sink = child.stdin.take().expect("stdin was piped");
    // Written from its own thread, and this is not a style choice: git answers as
    // it reads, so writing a batch larger than the pipe buffer (4 KB on Windows)
    // while nothing drains stdout deadlocks both sides. A write error only means
    // git exited first; the exit status below is what decides.
    let writer = std::thread::spawn(move || {
        let _ = sink.write_all(&input);
    });
    let output = child.wait_with_output().map_err(map_io_err)?;
    let _ = writer.join();

    match output.status.code() {
        // 0 = at least one path is ignored, 1 = none of them are. Both are
        // answers; only 1 has an empty stdout.
        Some(0 | 1) => Ok(output
            .stdout
            .split(|&b| b == 0)
            .filter(|slug| !slug.is_empty())
            .map(|slug| String::from_utf8_lossy(slug).into_owned())
            .collect()),
        // 128 is fatal (not a repository, a path outside it); None is a signal.
        _ => Err(GitError::CommandFailed(stderr_of(&output))),
    }
}

/// A `git` invocation rooted at `dir`, with stdin closed so it can never block
/// waiting for input. On Windows, `CREATE_NO_WINDOW` stops a console flashing.
pub(crate) fn git_command(dir: &Path) -> Command {
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

/// [`git_command`] for read-only queries. `--no-optional-locks` stops git from
/// taking `index.lock` just to refresh the index, so a watcher-driven read
/// (which fires *during* a checkout or a pull — see Part 5's op lock) can never
/// contend with the operation that triggered it.
pub(crate) fn git_read_command(dir: &Path) -> Command {
    let mut cmd = git_command(dir);
    cmd.arg("--no-optional-locks");
    cmd
}

/// `git rev-parse --short HEAD`. A non-zero exit means an unborn HEAD (a repo
/// with no commits yet), which is a normal state, not an error.
pub fn head_short_sha(root: &Path) -> Result<Option<String>, GitError> {
    let output = git_read_command(root)
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string(),
    ))
}

/// The `stderr` of a finished git process, falling back to `stdout` when git
/// reported the failure there instead. Trimmed, and never parsed — it is
/// localized text, only ever shown to the user verbatim.
pub(crate) fn stderr_of(output: &std::process::Output) -> String {
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if err.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        err
    }
}

/// Run a git command that produces no output of interest, mapping a non-zero
/// exit to [`GitError::CommandFailed`] carrying git's own stderr.
pub(crate) fn run_checked(mut cmd: Command) -> Result<(), GitError> {
    let output = cmd.output().map_err(map_io_err)?;
    if output.status.success() {
        return Ok(());
    }
    Err(GitError::CommandFailed(stderr_of(&output)))
}

pub(crate) fn map_io_err(e: std::io::Error) -> GitError {
    if e.kind() == std::io::ErrorKind::NotFound {
        GitError::GitNotFound
    } else {
        GitError::Io(e.to_string())
    }
}

/// Parse `git status --porcelain=v2 -z` output into (staged, unstaged, conflicts).
pub fn parse_porcelain_v2(bytes: &[u8]) -> (Vec<FileEntry>, Vec<FileEntry>, Vec<ConflictEntry>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut conflicts = Vec::new();

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
                // Its own group, keeping the XY: which side of the merge touched
                // the path decides what resolving it can even mean.
                let line = String::from_utf8_lossy(token);
                if let Some((xy, path)) = fields(&line, 11) {
                    conflicts.push(ConflictEntry {
                        path: path.to_string(),
                        kind: conflict_kind(xy),
                    });
                }
            }
            Some(b'?') => {
                // `? <path>` — skip the two-byte "? " prefix.
                let line = String::from_utf8_lossy(token);
                if let Some(path) = line.get(2..) {
                    if is_save_temp(path) {
                        continue;
                    }
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

    (staged, unstaged, conflicts)
}

/// Whether an untracked path is the diff window's own atomic-save temp file,
/// caught mid-write.
///
/// `write_worktree_file` creates it in the target's directory, writes, chmods and
/// renames onto the target, so for about a millisecond it exists as an untracked
/// file. A status read that lands in that window reports it, and a row appears in
/// the sidebar and vanishes. The watcher drops its *events*, but that cannot help
/// here: the read this arrives on was triggered by something else entirely.
///
/// Untracked records only. A tracked file with this name is the user's, and a real
/// change to it must still be shown. Porcelain v2 always uses forward slashes,
/// Windows included, so the basename split is platform-independent.
fn is_save_temp(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .starts_with(crate::SAVE_TEMP_PREFIX)
}

/// Map a `u` record's `<XY>` to a [`ConflictKind`].
fn conflict_kind(xy: &str) -> ConflictKind {
    match xy {
        "UU" => ConflictKind::BothModified,
        "AA" => ConflictKind::BothAdded,
        "DD" => ConflictKind::BothDeleted,
        "AU" => ConflictKind::AddedByUs,
        "UA" => ConflictKind::AddedByThem,
        "UD" => ConflictKind::DeletedByThem,
        "DU" => ConflictKind::DeletedByUs,
        _ => ConflictKind::Unknown,
    }
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
        assert_eq!(parse_porcelain_v2(&[]), (vec![], vec![], vec![]));
        assert_eq!(parse_porcelain_v2(&z(&[])), (vec![], vec![], vec![]));
    }

    #[test]
    fn unstaged_modification_goes_to_unstaged_only() {
        let (staged, unstaged, _) =
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
        let (staged, unstaged, _) =
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
        let (staged, unstaged, _) =
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
        let (staged, _, _) =
            parse_porcelain_v2(&z(&["1 D. N... 100644 000000 000000 h h gone.txt"]));
        assert_eq!(staged[0].status, ChangeStatus::Deleted);
        let (_, unstaged, _) =
            parse_porcelain_v2(&z(&["1 .D N... 100644 100644 000000 h h vanished.txt"]));
        assert_eq!(unstaged[0].status, ChangeStatus::Deleted);
    }

    #[test]
    fn rename_carries_orig_path_and_consumes_the_extra_token() {
        let (staged, unstaged, _) = parse_porcelain_v2(&z(&[
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
        let (staged, unstaged, _) = parse_porcelain_v2(&z(&["? brand-new.txt"]));
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
    fn unmerged_file_is_a_conflict_and_nothing_else() {
        // The group split matters: a conflicted path used to land in `unstaged`
        // too, which showed it twice and lost the XY the resolution needs.
        let (staged, unstaged, conflicts) = parse_porcelain_v2(&z(&[
            "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
        ]));
        assert!(staged.is_empty());
        assert!(unstaged.is_empty(), "a conflict is not an unstaged change");
        assert_eq!(
            conflicts,
            vec![ConflictEntry {
                path: "conflict.txt".into(),
                kind: ConflictKind::BothModified,
            }]
        );
    }

    #[test]
    fn every_documented_xy_maps_to_its_conflict_kind() {
        // git's own table. Getting UD and DU the wrong way round would offer
        // "keep my version" for a file the *other* side kept.
        for (xy, expected) in [
            ("UU", ConflictKind::BothModified),
            ("AA", ConflictKind::BothAdded),
            ("DD", ConflictKind::BothDeleted),
            ("AU", ConflictKind::AddedByUs),
            ("UA", ConflictKind::AddedByThem),
            ("UD", ConflictKind::DeletedByThem),
            ("DU", ConflictKind::DeletedByUs),
        ] {
            let record = format!("u {xy} N... 100644 100644 100644 100644 h1 h2 h3 path.txt");
            let (_, _, conflicts) = parse_porcelain_v2(&z(&[&record]));
            assert_eq!(conflicts[0].kind, expected, "XY {xy}");
        }
    }

    #[test]
    fn an_undocumented_xy_is_kept_as_an_unknown_conflict() {
        // Dropping it would strand the merge: the file would be missing from the
        // panel while git still refuses to continue until it is resolved.
        let (_, _, conflicts) = parse_porcelain_v2(&z(&[
            "u XY N... 100644 100644 100644 100644 h1 h2 h3 odd.txt",
        ]));
        assert_eq!(
            conflicts,
            vec![ConflictEntry {
                path: "odd.txt".into(),
                kind: ConflictKind::Unknown,
            }]
        );
    }

    #[test]
    fn only_marker_bearing_kinds_report_markers() {
        // What decides whether the merge window has anything to show.
        assert!(ConflictKind::BothModified.has_markers());
        assert!(ConflictKind::BothAdded.has_markers());
        for kind in [
            ConflictKind::BothDeleted,
            ConflictKind::AddedByUs,
            ConflictKind::AddedByThem,
            ConflictKind::DeletedByUs,
            ConflictKind::DeletedByThem,
            ConflictKind::Unknown,
        ] {
            assert!(!kind.has_markers(), "{kind:?} has no merged text");
        }
    }

    #[test]
    fn non_utf8_path_degrades_lossily_without_panicking() {
        // -z emits raw bytes and never quotes, so a path can be invalid UTF-8.
        let mut bytes = b"1 .M N... 100644 100644 100644 h h caf".to_vec();
        bytes.push(0xFF); // invalid UTF-8 byte inside the path
        bytes.extend_from_slice(b".txt");
        bytes.push(0);

        let (_, unstaged, _) = parse_porcelain_v2(&bytes);
        assert_eq!(unstaged.len(), 1);
        assert_eq!(unstaged[0].status, ChangeStatus::Modified);
        // The bad byte becomes U+FFFD; parsing must not panic.
        assert!(unstaged[0].path.starts_with("caf"));
        assert!(unstaged[0].path.contains('\u{FFFD}'));
    }

    #[test]
    fn path_with_spaces_is_preserved() {
        let (_, unstaged, _) =
            parse_porcelain_v2(&z(&["1 .M N... 100644 100644 100644 h h my notes.txt"]));
        assert_eq!(unstaged[0].path, "my notes.txt");
    }

    #[test]
    fn mixed_batch_parses_every_record_in_order() {
        let (staged, unstaged, conflicts) = parse_porcelain_v2(&z(&[
            "1 A. N... 000000 100644 100644 h h added.txt",
            "1 .M N... 100644 100644 100644 h h edited.txt",
            "2 R. N... 100644 100644 100644 h h R100 new-name.txt",
            "old-name.txt",
            "u UU N... 100644 100644 100644 100644 h1 h2 h3 clashed.txt",
            "? untracked.txt",
        ]));
        assert_eq!(
            conflicts,
            vec![ConflictEntry {
                path: "clashed.txt".into(),
                kind: ConflictKind::BothModified,
            }]
        );
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

    /// A repo with `ignored/` in a committed `.gitignore`, the directory present on
    /// disk (a `dir/` pattern only matches something git can see is a directory).
    fn repo_ignoring_a_directory() -> tempfile::TempDir {
        let dir = crate::testrepo::repo_with_commit("file.txt", "one\n");
        crate::testrepo::write(dir.path(), ".gitignore", "ignored/\n");
        crate::testrepo::git_in(dir.path(), &["add", ".gitignore"]);
        crate::testrepo::commit(dir.path(), "ignore rules");
        std::fs::create_dir(dir.path().join("ignored")).expect("create dir");
        dir
    }

    fn slugs(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn check_ignored_reports_only_the_ignored_subset() {
        let dir = repo_ignoring_a_directory();
        let ignored = check_ignored(
            dir.path(),
            &slugs(&["file.txt", "ignored/a", "src/main.rs", "ignored"]),
        )
        .expect("check-ignore answers");

        let mut listed: Vec<&str> = ignored.iter().map(String::as_str).collect();
        listed.sort_unstable();
        assert_eq!(listed, vec!["ignored", "ignored/a"]);
    }

    #[test]
    fn check_ignored_treats_nothing_ignored_as_an_answer() {
        // Exit 1 with empty stdout is git saying "none of these", not a failure.
        let dir = repo_ignoring_a_directory();
        let ignored = check_ignored(dir.path(), &slugs(&["file.txt", "src/main.rs"]))
            .expect("exit 1 is fine");
        assert!(ignored.is_empty());
    }

    #[test]
    fn check_ignored_asked_nothing_spawns_nothing() {
        let dir = repo_ignoring_a_directory();
        assert!(check_ignored(dir.path(), &[]).expect("no batch").is_empty());
    }

    #[test]
    fn check_ignored_handles_a_batch_larger_than_a_pipe_buffer() {
        // The deadlock regression test. git answers as it reads, so writing a batch
        // this size from the calling thread while nothing drains stdout wedges both
        // processes: the failure shows up as a hung test, i.e. a CI timeout, not an
        // assertion. 5000 paths is far past every platform's pipe buffer.
        let dir = repo_ignoring_a_directory();
        let names: Vec<String> = (0..5000).map(|index| format!("ignored/f{index}")).collect();

        let ignored = check_ignored(dir.path(), &names).expect("check-ignore answers");

        assert_eq!(ignored.len(), 5000);
    }

    #[test]
    fn check_ignored_does_not_report_a_tracked_file_that_matches_a_pattern() {
        // Why `--no-index` is deliberately absent: `status` reports changes to a
        // force-added file, so the watcher has to refresh for it. Passing
        // `--no-index` would answer the opposite question and hide real changes.
        let dir = repo_ignoring_a_directory();
        crate::testrepo::write(dir.path(), "ignored/keep.txt", "one\n");
        crate::testrepo::git_in(dir.path(), &["add", "-f", "ignored/keep.txt"]);
        crate::testrepo::commit(dir.path(), "force add");

        let ignored = check_ignored(
            dir.path(),
            &slugs(&["ignored/keep.txt", "ignored/other.txt"]),
        )
        .expect("check-ignore answers");

        assert!(!ignored.contains("ignored/keep.txt"));
        assert!(ignored.contains("ignored/other.txt"));
    }

    #[test]
    fn check_ignored_errors_outside_a_repository() {
        // 128, which the caller turns into "refresh, we do not know".
        let dir = tempfile::tempdir().expect("temp dir");
        let error = check_ignored(dir.path(), &slugs(&["anything.txt"]))
            .expect_err("not a repository must fail");
        assert!(matches!(error, GitError::CommandFailed(_)));
    }

    #[test]
    fn status_at_reads_an_already_resolved_root() {
        let dir = repo_ignoring_a_directory();
        let status = status_at(dir.path()).expect("status reads");
        // The root comes back exactly as handed in, which is what lets the frontend
        // keep echoing it back.
        assert_eq!(status.repo_root, dir.path().to_string_lossy());
    }

    #[test]
    fn status_at_still_reports_a_non_repo_as_not_a_repo() {
        // The message must not degrade to git's raw stderr just because discovery
        // was skipped on the happy path.
        let dir = tempfile::tempdir().expect("temp dir");
        // A temp dir can sit inside someone's checkout; only assert the variant when
        // git agrees it is not in one (the project.rs pattern).
        match status_at(dir.path()) {
            Err(GitError::NotARepo(_)) => {}
            Ok(_) => { /* the temp dir happened to be inside a repo */ }
            Err(other) => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn an_untracked_save_temp_file_is_not_reported() {
        // The phantom row: a status read that lands in the ~1 ms window while the
        // diff window's atomic save has its temp file on disk.
        let (_, unstaged, _) = parse_porcelain_v2(&z(&[
            "? .isabuild-save-Ab12cd",
            "? src/deep/.isabuild-save-Ab12cd",
            "? keep.txt",
        ]));
        assert_eq!(
            unstaged.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["keep.txt"]
        );
    }

    #[test]
    fn a_tracked_save_temp_file_is_still_reported() {
        // Untracked records only: a tracked file with that name is the user's.
        let (staged, _, _) = parse_porcelain_v2(&z(&[
            "1 M. N... 100644 100644 100644 h h .isabuild-save-Ab12cd",
        ]));
        assert_eq!(staged.len(), 1);
    }

    #[test]
    fn a_similarly_named_untracked_file_is_still_reported() {
        let (_, unstaged, _) =
            parse_porcelain_v2(&z(&["? src/isabuild-save-x", "? src/.isabuild-saved.txt"]));
        assert_eq!(unstaged.len(), 2);
    }
}
