//! File contents for the diff window: the HEAD revision on one side, the
//! working-tree file on the other, plus the write-back used by its auto-save.
//!
//! Same shape as [`crate::git`]: the decisions live in pure, unit-tested
//! functions ([`looks_binary`], [`detect_eol`], [`apply_eol`], the path
//! resolvers) and the shell-out layer around them stays thin. Contents come
//! from plumbing (`git cat-file blob HEAD:<path>`), never from human-readable
//! `git diff` output — the diff itself is computed in Monaco, not here.
//!
//! Line endings are the one thing this module normalises. With `core.autocrlf`
//! on Windows the blob is stored LF while the checked-out file is CRLF, so
//! comparing them raw paints *every* line as changed. Both sides are handed to
//! the frontend as LF and the detected [`Eol`] travels with them, so a save
//! restores the file's original endings.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git::{git_command, head_short_sha, map_io_err, GitError};

/// Line ending of the working-tree file, so a save writes it back unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

/// The two sides of one file's diff. `left`/`right` are `None` when that side
/// does not exist (not in HEAD yet / deleted from the working tree) and when
/// the file is binary; the frontend renders those states rather than an editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Rename/copy origin — the path the HEAD side is read from.
    pub orig_path: Option<String>,
    /// Short HEAD sha for the left header; `None` on an unborn HEAD.
    pub head_sha: Option<String>,
    pub left: Option<String>,
    pub right: Option<String>,
    pub binary: bool,
    pub eol: Eol,
}

#[derive(Debug, thiserror::Error)]
pub enum DiffError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("'{0}' resolves outside the repository")]
    OutsideRepo(String),
    #[error("'{0}' is a symbolic link; editing symlinks is not supported")]
    Symlink(String),
    #[error("'{0}' is not a regular file")]
    NotAFile(String),
    #[error("'{0}' no longer exists in the working tree")]
    Missing(String),
    #[error("could not access '{0}': {1}")]
    Io(String, String),
}

/// Read both sides of `path` (repo-relative, forward slashes as git reports
/// them). `orig_path` is the rename/copy origin: the HEAD side comes from there.
pub fn file_diff(root: &Path, path: &str, orig_path: Option<&str>) -> Result<FileDiff, DiffError> {
    let root = canonical_root(root)?;
    let head_sha = head_short_sha(&root)?;
    // An unborn HEAD has no blobs at all, so don't even ask git.
    let left = match head_sha {
        Some(_) => blob_at_head(&root, orig_path.unwrap_or(path))?,
        None => None,
    };
    let right = read_worktree_file(&root, path)?;

    let binary =
        left.as_deref().is_some_and(looks_binary) || right.as_deref().is_some_and(looks_binary);
    // Prefer the working-tree file's endings; fall back to the blob's for a
    // deleted file so the header/round-trip still reports something truthful.
    let eol = right
        .as_deref()
        .or(left.as_deref())
        .map_or(Eol::Lf, detect_eol);

    Ok(FileDiff {
        path: path.to_string(),
        orig_path: orig_path.map(str::to_string),
        head_sha,
        left: if binary { None } else { left.map(to_lf_string) },
        right: if binary {
            None
        } else {
            right.map(to_lf_string)
        },
        binary,
        eol,
    })
}

/// Write `content` (LF-separated, as the editor holds it) back to the
/// working-tree file with `eol` restored. Only ever overwrites an existing
/// regular file inside the repo — see [`resolve_write`].
///
/// Written atomically: a sibling temp file, then a rename. The diff window
/// auto-saves while the user types, so a plain truncate-then-write would leave
/// a window on every keystroke where a crash truncates the user's source file
/// to nothing. The rename also means the file watcher sees one whole-file
/// change, never a half-written one. The original file's permissions are copied
/// onto the replacement so an executable or group-writable file stays that way.
pub fn write_worktree_file(
    root: &Path,
    path: &str,
    content: &str,
    eol: Eol,
) -> Result<(), DiffError> {
    let root = canonical_root(root)?;
    let target = resolve_write(&root, path)?;
    let io_err = |e: std::io::Error| DiffError::Io(path.to_string(), e.to_string());

    // Same directory as the target: a rename across filesystems would fail.
    let directory = target.parent().ok_or_else(|| {
        DiffError::Io(path.to_string(), "file has no parent directory".to_string())
    })?;
    let temp = tempfile::Builder::new()
        .prefix(crate::SAVE_TEMP_PREFIX)
        .tempfile_in(directory)
        .map_err(io_err)?;

    std::fs::write(temp.path(), apply_eol(content, eol)).map_err(io_err)?;
    let permissions = std::fs::metadata(&target).map_err(io_err)?.permissions();
    std::fs::set_permissions(temp.path(), permissions).map_err(io_err)?;
    // persist() renames onto the target, replacing it on every platform.
    temp.persist(&target)
        .map_err(|e| DiffError::Io(path.to_string(), e.error.to_string()))?;
    Ok(())
}

/// `git cat-file blob HEAD:<path>` — the blob exactly as stored (no smudge
/// filters, so no CRLF translation).
///
/// A non-zero exit is read as "not in HEAD", i.e. a new file. That covers other
/// failures too (an unreadable object, a path that is a tree at HEAD), which
/// then render as a new file rather than an error. Acceptable because the caller
/// only gets here once `head_short_sha` has succeeded — so the repo and HEAD are
/// readable — and `git_status` only ever reports files.
pub fn blob_at_head(root: &Path, path: &str) -> Result<Option<Vec<u8>>, DiffError> {
    let output = git_command(root)
        .args(["cat-file", "blob", &format!("HEAD:{path}")])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(output.stdout))
}

/// Read the working-tree file. `None` means it is not there (a deletion).
fn read_worktree_file(root: &Path, path: &str) -> Result<Option<Vec<u8>>, DiffError> {
    let Some(target) = resolve_read(root, path)? else {
        return Ok(None);
    };
    match std::fs::read(&target) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(DiffError::Io(path.to_string(), e.to_string())),
    }
}

pub(crate) fn canonical_root(root: &Path) -> Result<PathBuf, DiffError> {
    root.canonicalize()
        .map_err(|e| DiffError::Io(root.display().to_string(), e.to_string()))
}

/// Reject anything that is not a plain relative path before it touches the
/// filesystem: absolute paths, drive prefixes and `..` traversal.
fn check_relative(rel: &str) -> Result<(), DiffError> {
    if rel.is_empty() {
        return Err(DiffError::OutsideRepo(rel.to_string()));
    }
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(DiffError::OutsideRepo(rel.to_string())),
        }
    }
    Ok(())
}

/// Resolve `rel` for reading. `Ok(None)` means "not present" (deleted file).
/// Canonicalising resolves symlinks, so a link pointing out of the repo is
/// rejected while one staying inside it still reads.
pub(crate) fn resolve_read(root: &Path, rel: &str) -> Result<Option<PathBuf>, DiffError> {
    check_relative(rel)?;
    let target = root.join(rel);
    match target.canonicalize() {
        Ok(resolved) if resolved.starts_with(root) => Ok(Some(resolved)),
        Ok(_) => Err(DiffError::OutsideRepo(rel.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(DiffError::Io(rel.to_string(), e.to_string())),
    }
}

/// Resolve `rel` for writing: it must already exist as a regular file inside
/// the repo. Symlinks are refused outright rather than followed — the editor
/// would otherwise write through a link, and the deleted-file pane is read-only
/// precisely so a save can never create a file.
fn resolve_write(root: &Path, rel: &str) -> Result<PathBuf, DiffError> {
    check_relative(rel)?;
    let target = root.join(rel);
    let meta = match target.symlink_metadata() {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(DiffError::Missing(rel.to_string()))
        }
        Err(e) => return Err(DiffError::Io(rel.to_string(), e.to_string())),
    };
    if meta.file_type().is_symlink() {
        return Err(DiffError::Symlink(rel.to_string()));
    }
    if !meta.is_file() {
        return Err(DiffError::NotAFile(rel.to_string()));
    }
    let resolved = target
        .canonicalize()
        .map_err(|e| DiffError::Io(rel.to_string(), e.to_string()))?;
    if !resolved.starts_with(root) {
        return Err(DiffError::OutsideRepo(rel.to_string()));
    }
    Ok(resolved)
}

/// git's own heuristic: a NUL byte early in the file. Content we cannot decode
/// as UTF-8 counts too — a `String` round-trip would corrupt it on save.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0) || std::str::from_utf8(bytes).is_err()
}

/// Whether the file is predominantly CRLF-terminated. A file with no newline
/// at all, or a tie, counts as LF.
pub fn detect_eol(bytes: &[u8]) -> Eol {
    let lf = bytes.iter().filter(|&&b| b == b'\n').count();
    let crlf = bytes
        .windows(2)
        .filter(|w| w[0] == b'\r' && w[1] == b'\n')
        .count();
    if crlf > lf - crlf {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

/// Decode to text with every line ending flattened to LF, which is what both
/// editor panes are fed. Only called for non-binary content, so the lossy decode
/// is a no-op.
fn to_lf_string(bytes: Vec<u8>) -> String {
    normalize_to_lf(&String::from_utf8_lossy(&bytes))
}

/// Flatten CRLF *and* a lone CR to LF.
///
/// The lone CR matters: an editor text model only knows LF and CRLF line
/// endings, so a stray `\r` mid-line becomes a line break there whether we
/// normalise it or not. Doing it here makes that conversion explicit and
/// symmetric with [`apply_eol`], instead of a `\r` silently turning into a
/// `\r\n` on the next save.
pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Re-apply `eol` to LF-separated editor text. Normalises first, so running
/// this on already-CRLF text cannot produce `\r\r\n`.
///
/// Note this writes one ending throughout: saving a file that mixed CRLF and LF
/// normalises it to whichever [`detect_eol`] found in the majority (the same
/// thing VS Code does). Mixed-ending files are rare and a git-visible whole-file
/// change is easier to understand than an editor that silently keeps two.
pub fn apply_eol(text: &str, eol: Eol) -> String {
    let lf = normalize_to_lf(text);
    match eol {
        Eol::Lf => lf,
        Eol::Crlf => lf.replace('\n', "\r\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::{git_in, repo_with_commit};

    #[test]
    fn detects_lf_and_crlf_and_defaults_to_lf() {
        assert_eq!(detect_eol(b"a\nb\nc"), Eol::Lf);
        assert_eq!(detect_eol(b"a\r\nb\r\nc"), Eol::Crlf);
        // No newline at all, and empty input: nothing to go on, so LF.
        assert_eq!(detect_eol(b"single line"), Eol::Lf);
        assert_eq!(detect_eol(b""), Eol::Lf);
        // Mixed: the majority wins, a tie stays LF.
        assert_eq!(detect_eol(b"a\r\nb\r\nc\nd"), Eol::Crlf);
        assert_eq!(detect_eol(b"a\r\nb\n"), Eol::Lf);
    }

    #[test]
    fn eol_round_trips_through_normalise_and_apply() {
        let crlf = "one\r\ntwo\r\n";
        let lf = normalize_to_lf(crlf);
        assert_eq!(lf, "one\ntwo\n");
        assert_eq!(apply_eol(&lf, Eol::Crlf), crlf);
        assert_eq!(apply_eol(&lf, Eol::Lf), lf);
        // Idempotent: applying CRLF to CRLF text must not double the \r.
        assert_eq!(apply_eol(crlf, Eol::Crlf), crlf);
    }

    #[test]
    fn a_lone_cr_becomes_a_line_break_rather_than_a_stray_byte() {
        // An editor model cannot hold a mid-line CR, so it is normalised to a
        // line break on the way in and written back as a real ending — never
        // left to turn into a surprise \r\n.
        assert_eq!(normalize_to_lf("one\rtwo\r\nthree"), "one\ntwo\nthree");
        assert_eq!(apply_eol("one\rtwo", Eol::Crlf), "one\r\ntwo");
        assert_eq!(apply_eol("one\rtwo", Eol::Lf), "one\ntwo");
    }

    #[test]
    fn saving_a_mixed_ending_file_normalises_it_to_the_majority() {
        // Documented trade-off (see `apply_eol`): one ending throughout, like
        // VS Code, rather than trying to preserve a per-line mixture.
        let mixed = b"a\r\nb\r\nc\nd";
        assert_eq!(detect_eol(mixed), Eol::Crlf);
        let shown = normalize_to_lf(&String::from_utf8_lossy(mixed));
        assert_eq!(shown, "a\nb\nc\nd");
        assert_eq!(apply_eol(&shown, Eol::Crlf), "a\r\nb\r\nc\r\nd");
    }

    #[test]
    fn binary_detection_catches_nul_bytes_and_undecodable_content() {
        assert!(!looks_binary(b"plain text\nwith lines\n"));
        assert!(looks_binary(b"png\0\x01\x02"));
        assert!(looks_binary(&[0xFF, 0xFE, 0x41])); // invalid UTF-8
        assert!(!looks_binary("caf\u{e9} \u{1f600}".as_bytes())); // multi-byte UTF-8 is text
                                                                  // A NUL past the sampled prefix is not inspected, like git.
        let mut late = vec![b'a'; 9000];
        late.push(0);
        assert!(!looks_binary(&late));
    }

    #[test]
    fn relative_path_check_rejects_escapes_and_absolutes() {
        assert!(check_relative("src/lib.rs").is_ok());
        assert!(check_relative("./src/lib.rs").is_ok());
        assert!(check_relative("").is_err());
        assert!(check_relative("../outside.txt").is_err());
        assert!(check_relative("src/../../outside.txt").is_err());
        #[cfg(unix)]
        assert!(check_relative("/etc/passwd").is_err());
        #[cfg(windows)]
        assert!(check_relative("C:\\Windows\\win.ini").is_err());
    }

    #[test]
    fn modified_file_returns_head_and_worktree_sides() {
        let dir = repo_with_commit("file.txt", "one\ntwo\n");
        std::fs::write(dir.path().join("file.txt"), "one\ntwo changed\n").expect("edit");

        let diff = file_diff(dir.path(), "file.txt", None).expect("diff");
        assert_eq!(diff.left.as_deref(), Some("one\ntwo\n"));
        assert_eq!(diff.right.as_deref(), Some("one\ntwo changed\n"));
        assert!(diff.head_sha.is_some(), "committed repo has a HEAD sha");
        assert!(!diff.binary);
        assert_eq!(diff.eol, Eol::Lf);
    }

    #[test]
    fn untracked_file_has_no_left_side() {
        let dir = repo_with_commit("file.txt", "one\n");
        std::fs::write(dir.path().join("new.txt"), "fresh\n").expect("write");

        let diff = file_diff(dir.path(), "new.txt", None).expect("diff");
        assert_eq!(diff.left, None);
        assert_eq!(diff.right.as_deref(), Some("fresh\n"));
    }

    #[test]
    fn deleted_file_has_no_right_side() {
        let dir = repo_with_commit("file.txt", "one\n");
        std::fs::remove_file(dir.path().join("file.txt")).expect("delete");

        let diff = file_diff(dir.path(), "file.txt", None).expect("diff");
        assert_eq!(diff.left.as_deref(), Some("one\n"));
        assert_eq!(diff.right, None);
    }

    #[test]
    fn rename_reads_the_left_side_from_the_origin_path() {
        let dir = repo_with_commit("old.txt", "kept\n");
        std::fs::rename(dir.path().join("old.txt"), dir.path().join("new.txt")).expect("rename");

        let diff = file_diff(dir.path(), "new.txt", Some("old.txt")).expect("diff");
        assert_eq!(diff.left.as_deref(), Some("kept\n"));
        assert_eq!(diff.right.as_deref(), Some("kept\n"));
        assert_eq!(diff.orig_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn unborn_head_yields_no_sha_and_no_left_side() {
        let dir = tempfile::tempdir().expect("temp dir");
        git_in(dir.path(), &["init", "--quiet"]);
        std::fs::write(dir.path().join("first.txt"), "hello\n").expect("write");

        let diff = file_diff(dir.path(), "first.txt", None).expect("diff");
        assert_eq!(diff.head_sha, None);
        assert_eq!(diff.left, None);
        assert_eq!(diff.right.as_deref(), Some("hello\n"));
    }

    #[test]
    fn binary_file_reports_the_flag_and_withholds_both_sides() {
        let dir = tempfile::tempdir().expect("temp dir");
        git_in(dir.path(), &["init", "--quiet"]);
        std::fs::write(dir.path().join("blob.bin"), [0x89, 0x50, 0x00, 0x01]).expect("write");

        let diff = file_diff(dir.path(), "blob.bin", None).expect("diff");
        assert!(diff.binary);
        assert_eq!(diff.left, None);
        assert_eq!(diff.right, None);
    }

    #[test]
    fn crlf_worktree_against_an_lf_blob_is_not_a_whole_file_change() {
        // The Windows `core.autocrlf` case: identical content, different
        // endings. Both sides must arrive as LF so Monaco sees no diff at all.
        let dir = repo_with_commit("file.txt", "one\ntwo\n");
        std::fs::write(dir.path().join("file.txt"), "one\r\ntwo\r\n").expect("edit");

        let diff = file_diff(dir.path(), "file.txt", None).expect("diff");
        assert_eq!(diff.left, diff.right);
        assert_eq!(diff.eol, Eol::Crlf);
    }

    #[test]
    fn writing_restores_the_files_original_line_endings() {
        let dir = repo_with_commit("file.txt", "one\ntwo\n");
        let path = dir.path().join("file.txt");
        std::fs::write(&path, "one\r\ntwo\r\n").expect("edit");

        write_worktree_file(dir.path(), "file.txt", "one\nedited\n", Eol::Crlf).expect("write");
        assert_eq!(std::fs::read(&path).expect("read"), b"one\r\nedited\r\n");

        write_worktree_file(dir.path(), "file.txt", "one\nedited\n", Eol::Lf).expect("write");
        assert_eq!(std::fs::read(&path).expect("read"), b"one\nedited\n");
    }

    #[test]
    fn writing_outside_the_repo_is_refused() {
        let dir = repo_with_commit("file.txt", "one\n");
        let outside = dir.path().parent().expect("parent").join("escaped.txt");
        std::fs::write(&outside, "untouched\n").expect("seed");

        let target = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        let error = write_worktree_file(dir.path(), &target, "clobbered\n", Eol::Lf)
            .expect_err("traversal must be refused");
        assert!(matches!(error, DiffError::OutsideRepo(_)));
        assert_eq!(
            std::fs::read_to_string(&outside).expect("read"),
            "untouched\n"
        );
        std::fs::remove_file(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn writing_keeps_the_files_permissions() {
        // The save is a temp-file-and-rename, so the replacement must inherit
        // the original's mode — an executable script has to stay executable.
        use std::os::unix::fs::PermissionsExt as _;
        let dir = repo_with_commit("script.sh", "#!/bin/sh\necho one\n");
        let path = dir.path().join("script.sh");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        write_worktree_file(dir.path(), "script.sh", "#!/bin/sh\necho two\n", Eol::Lf)
            .expect("write");

        let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "#!/bin/sh\necho two\n"
        );
    }

    #[test]
    fn writing_leaves_no_temp_files_behind() {
        let dir = repo_with_commit("file.txt", "one\n");
        write_worktree_file(dir.path(), "file.txt", "two\n", Eol::Lf).expect("write");

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(crate::SAVE_TEMP_PREFIX))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[test]
    fn writing_a_file_that_does_not_exist_is_refused() {
        let dir = repo_with_commit("file.txt", "one\n");
        let error = write_worktree_file(dir.path(), "ghost.txt", "created\n", Eol::Lf)
            .expect_err("must not create files");
        assert!(matches!(error, DiffError::Missing(_)));
        assert!(!dir.path().join("ghost.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_escaping_the_repo_is_refused_for_read_and_write() {
        let dir = repo_with_commit("file.txt", "one\n");
        let outside = dir.path().parent().expect("parent").join("secret.txt");
        std::fs::write(&outside, "secret\n").expect("seed");
        std::os::unix::fs::symlink(&outside, dir.path().join("link.txt")).expect("symlink");

        let read = file_diff(dir.path(), "link.txt", None).expect_err("read must be refused");
        assert!(matches!(read, DiffError::OutsideRepo(_)));
        let write = write_worktree_file(dir.path(), "link.txt", "clobbered\n", Eol::Lf)
            .expect_err("write must be refused");
        assert!(matches!(write, DiffError::Symlink(_)));
        assert_eq!(std::fs::read_to_string(&outside).expect("read"), "secret\n");
        std::fs::remove_file(&outside).ok();
    }
}
