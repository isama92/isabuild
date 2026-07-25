//! Merging, conflict detection and conflict resolution.
//!
//! Same shape as the rest of the crate: the decisions live in pure, unit-tested
//! functions ([`parse_conflicts`], [`resolved_text`], [`content_revision`]) and
//! the shell-out layer around them stays thin. Nothing here parses
//! human-readable git output — the conflicted state is read from plumbing and
//! from `<git-dir>`, and git's own text is only ever passed through for display.
//!
//! Three details that are not obvious:
//!
//! - **No editor may ever be launched.** `git merge` and `git merge --continue`
//!   open `$EDITOR` for the merge commit message, and [`crate::git::git_command`]
//!   gives its children a closed stdin — so a launched editor is a subprocess
//!   that can never finish. `--no-edit` plus `GIT_EDITOR=true` ([`no_editor`]) is
//!   a correctness requirement here, not a convenience.
//! - **A conflict is not a failure.** A conflicting merge exits non-zero, and so
//!   does a merge git refused outright (a dirty tree, an unknown ref). The two
//!   are told apart by *re-reading the state* rather than by grepping git's
//!   message for "CONFLICT", which is exactly the localized text CLAUDE.md
//!   forbids parsing.
//! - **Resolution is guarded by a content revision.** The working tree is
//!   watched and Claude Code is running in the terminal next to it, so "apply my
//!   choice to conflict 2" can arrive for a file that has since been rewritten.
//!   Without the guard that silently rewrites the wrong hunk; with it the caller
//!   is told to reload.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::diff::{self, DiffError};
use crate::git::{git_command, git_read_command, map_io_err, stderr_of, GitError};

/// Marker length git writes, and the minimum it accepts. Longer runs are treated
/// as markers too, so a repository that raised `conflict-marker-size` still
/// parses.
const MARKER_LEN: usize = 7;

/// What operation, if any, the repository is in the middle of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    /// Nothing in progress, no conflicted paths.
    None,
    /// `MERGE_HEAD` exists: a `git merge`, or a merge-style `git pull`.
    Merge,
    /// Conflicted paths with nothing in progress — what a `stash pop` that would
    /// not reapply leaves behind. There is nothing to continue: resolving and
    /// staging is the whole job.
    ConflictsOnly,
    /// Detected so it can be named, never driven from here: continuing or
    /// aborting one of these takes its own command family (Part 7/8).
    Rebase,
    CherryPick,
    Revert,
}

impl MergeKind {
    /// Whether `git merge --continue` / `--abort` are the right commands for
    /// this state.
    pub fn is_merge(self) -> bool {
        self == MergeKind::Merge
    }
}

/// The repository's in-progress state, for the banner above the file list.
///
/// The "into" side is deliberately absent: it is the current branch, which the
/// frontend already holds from `git_branch_state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeState {
    pub kind: MergeKind,
    /// What is being merged in — a branch name where one points at `MERGE_HEAD`,
    /// else its short sha. `None` for the states that have no such ref.
    pub merging_ref: Option<String>,
}

/// A half-open range of line indices into [`ConflictFile::lines`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

impl LineRange {
    fn new(start: usize, end: usize) -> Self {
        LineRange { start, end }
    }

    fn slice<'a>(&self, lines: &'a [String]) -> &'a [String] {
        &lines[self.start..self.end]
    }
}

/// One conflict in a file, as ranges into the file's lines. Ranges rather than
/// copies: the window renders context around each block from the same `lines`,
/// so duplicating the sections would mean two sources of truth for one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlock {
    /// The `<<<<<<<` line.
    pub start: usize,
    /// One past the `>>>>>>>` line, or the end of the file for an unterminated
    /// block.
    pub end: usize,
    pub ours: LineRange,
    /// The `|||||||` section, present only in the `diff3`/`zdiff3` styles.
    pub base: Option<LineRange>,
    pub theirs: LineRange,
    /// Text after `<<<<<<<`, e.g. `HEAD`. **Display only** — never used for
    /// logic, the same rule Part 5 applies to progress output.
    pub ours_label: String,
    /// Text after `>>>>>>>`, e.g. the merged branch name. Display only.
    pub theirs_label: String,
    /// True when the block has both its `=======` separator and its `>>>>>>>`
    /// terminator, which is what makes a side well defined enough to accept.
    ///
    /// False means someone (or something) edited the markers by hand and left the
    /// block half-finished. It is still shown — the user needs to see it — but the
    /// accept buttons are withheld rather than guessing which lines they meant.
    pub complete: bool,
}

/// A conflicted file as the merge window needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// Every line of the file, LF-normalised. A trailing newline shows up as a
    /// final empty line, so a join restores the file byte for byte.
    pub lines: Vec<String>,
    pub blocks: Vec<ConflictBlock>,
    /// Hash of the bytes these lines came from; hand it back with a resolution.
    pub revision: String,
    /// True when there is nothing textual to show. The window says so rather
    /// than rendering a lossy decode of a binary file.
    pub binary: bool,
}

/// Which side of one conflict to keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    Ours,
    Theirs,
    /// Ours then theirs, in that order, with any `diff3` base section dropped.
    Both,
}

/// A whole-file decision, for the conflicts that have no merged text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathResolution {
    KeepOurs,
    KeepTheirs,
    /// The deletion *is* the resolution (a delete/modify or both-deleted
    /// conflict): the path leaves the index and the working tree.
    AcceptDeletion,
    /// Stage the working-tree file exactly as it is.
    ///
    /// The escape hatch for a file resolved *outside* the app — in the diff
    /// window, in the terminal, by Claude Code. git goes on reporting such a path
    /// as unmerged until something stages it, so without this a hand-resolved
    /// conflict would sit in the Conflicts group forever with Continue disabled,
    /// and the only way on would be the shell.
    MarkResolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveOutcome {
    /// Conflicts still in the file after this resolution.
    pub remaining: usize,
    /// True when the file was staged, which happens exactly when `remaining` hit
    /// zero — git's own definition of resolved.
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// True when the merge stopped with conflicts rather than failing outright.
    pub conflicted: bool,
    /// Everything git said, verbatim, for the notice or the modal.
    pub output: String,
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/// Whether `line` is a conflict marker of `marker`, i.e. at least [`MARKER_LEN`]
/// of it followed by end of line or a space.
///
/// The trailing-space rule is what keeps `<<<<<<<` apart from a line of
/// `<<<<<<<<<<` in, say, a lexer fixture: git writes the marker with its label
/// separated by a single space, and never glues anything else to it.
fn marker_label(line: &str, marker: char) -> Option<&str> {
    let run = line.chars().take_while(|&c| c == marker).count();
    if run < MARKER_LEN {
        return None;
    }
    match line[run..].strip_prefix(' ') {
        Some(label) => Some(label.trim_end()),
        None if line.len() == run => Some(""),
        None => None,
    }
}

/// Find every conflict in `text` (LF-separated).
///
/// Line-based and single-pass. A block missing one of its markers is still
/// reported, flagged `complete: false`: the file genuinely has an unfinished
/// conflict in it, and showing it beats pretending the tail is ordinary content.
/// Such a block cannot be *resolved* — see [`resolve_conflict`] — because there is
/// no honest way to guess where the side the user wants begins and ends.
pub fn parse_conflicts(text: &str) -> Vec<ConflictBlock> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut blocks = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let Some(ours_label) = marker_label(lines[index], '<') else {
            index += 1;
            continue;
        };
        let start = index;
        let ours_start = index + 1;
        let mut base: Option<LineRange> = None;
        let mut ours_end = None;
        let mut theirs_start = None;
        let mut theirs_end = None;
        let mut theirs_label = String::new();
        let mut base_start = None;

        index += 1;
        while index < lines.len() {
            let line = lines[index];
            if base_start.is_none() && ours_end.is_none() && marker_label(line, '|').is_some() {
                // diff3/zdiff3: the merge base sits between ours and theirs.
                ours_end = Some(index);
                base_start = Some(index + 1);
            } else if theirs_start.is_none() && marker_label(line, '=').is_some() {
                if let Some(base_start) = base_start {
                    base = Some(LineRange::new(base_start, index));
                } else {
                    ours_end = Some(index);
                }
                theirs_start = Some(index + 1);
            } else if let Some(label) = marker_label(line, '>') {
                theirs_end = Some(index);
                theirs_label = label.to_string();
                index += 1;
                break;
            }
            index += 1;
        }

        // Both markers present is what makes a block resolvable: without the
        // separator there is no boundary between the sides, and without the
        // terminator no end to the block.
        let complete = theirs_start.is_some() && theirs_end.is_some();
        // Unterminated: everything to the end of the file belongs to the block.
        let end = theirs_end.map_or(lines.len(), |_| index);
        // `.or(theirs_end)` matters: with no `=======` the fallback would
        // otherwise reach past the `>>>>>>>` line and pull the marker itself into
        // `ours`, so displaying — or resolving — that side would show a marker as
        // if it were the user's code.
        let ours_end = ours_end.or(theirs_end).unwrap_or(end);
        let theirs_start = theirs_start.unwrap_or(end);
        let theirs_end = theirs_end.unwrap_or(lines.len());

        blocks.push(ConflictBlock {
            start,
            end,
            ours: LineRange::new(ours_start.min(ours_end), ours_end),
            base,
            theirs: LineRange::new(theirs_start.min(theirs_end), theirs_end),
            ours_label: ours_label.to_string(),
            theirs_label,
            complete,
        });
    }

    blocks
}

/// The file's text with `block` replaced by the chosen side.
///
/// Everything outside the block is untouched, including the other conflicts —
/// resolving one hunk must never reformat the rest of someone's file.
pub fn resolved_text(lines: &[String], block: &ConflictBlock, choice: ConflictChoice) -> String {
    let mut out: Vec<&str> = lines[..block.start].iter().map(String::as_str).collect();
    let keep: Vec<&String> = match choice {
        ConflictChoice::Ours => block.ours.slice(lines).iter().collect(),
        ConflictChoice::Theirs => block.theirs.slice(lines).iter().collect(),
        // The base section is dropped: it is context git added to explain the
        // conflict, not a third version of the code anyone wants to keep.
        ConflictChoice::Both => block
            .ours
            .slice(lines)
            .iter()
            .chain(block.theirs.slice(lines))
            .collect(),
    };
    out.extend(keep.into_iter().map(String::as_str));
    out.extend(lines[block.end..].iter().map(String::as_str));
    out.join("\n")
}

/// FNV-1a over the file's bytes, hex. Not a checksum anyone else consumes: it
/// exists only so a resolution can say which bytes it was computed against.
pub fn content_revision(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Split LF text into owned lines, keeping the trailing-newline marker.
///
/// `"a\nb\n"` becomes `["a", "b", ""]`, so `join("\n")` round-trips exactly and a
/// file with no final newline stays that way.
fn split_lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_string).collect()
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

/// What the repository is in the middle of, and what it is merging.
pub fn merge_state(root: &Path) -> Result<MergeState, GitError> {
    let git_dir = git_dir(root)?;

    // Ordered by specificity: a rebase with conflicts is a rebase, not a bare
    // pile of conflicted paths.
    if let Some(sha) = pseudo_ref(root, "MERGE_HEAD")? {
        return Ok(MergeState {
            kind: MergeKind::Merge,
            merging_ref: Some(name_for(root, &sha)),
        });
    }
    if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
        // An interactive rebase paused between steps has no REBASE_HEAD, so the
        // state directory is the reliable signal.
        return Ok(MergeState {
            kind: MergeKind::Rebase,
            merging_ref: None,
        });
    }
    for (pseudo, kind) in [
        ("CHERRY_PICK_HEAD", MergeKind::CherryPick),
        ("REVERT_HEAD", MergeKind::Revert),
    ] {
        if let Some(sha) = pseudo_ref(root, pseudo)? {
            return Ok(MergeState {
                kind,
                merging_ref: Some(name_for(root, &sha)),
            });
        }
    }
    if has_unmerged_paths(root)? {
        return Ok(MergeState {
            kind: MergeKind::ConflictsOnly,
            merging_ref: None,
        });
    }
    Ok(MergeState {
        kind: MergeKind::None,
        merging_ref: None,
    })
}

/// Read one conflicted file for the merge window.
pub fn conflict_file(root: &Path, path: &str) -> Result<ConflictFile, GitError> {
    let root = diff::canonical_root(root).map_err(to_git_error)?;
    let bytes = read_worktree_bytes(&root, path)?;
    let revision = content_revision(&bytes);

    if diff::looks_binary(&bytes) {
        return Ok(ConflictFile {
            path: path.to_string(),
            lines: Vec::new(),
            blocks: Vec::new(),
            revision,
            binary: true,
        });
    }

    let text = diff::normalize_to_lf(&String::from_utf8_lossy(&bytes));
    let lines = split_lines(&text);
    Ok(ConflictFile {
        blocks: parse_conflicts(&text),
        path: path.to_string(),
        lines,
        revision,
        binary: false,
    })
}

/// `<git-dir>` as an absolute path. Never assumed to be `<root>/.git`: in a
/// linked worktree or a submodule that is a *file* pointing elsewhere, and the
/// in-progress state we look for lives at the real one.
fn git_dir(root: &Path) -> Result<PathBuf, GitError> {
    let output = git_read_command(root)
        .args(["rev-parse", "--absolute-git-dir"])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim_end(),
    ))
}

/// Resolve a pseudo-ref like `MERGE_HEAD` to its sha. Absent is the normal case,
/// not an error.
fn pseudo_ref(root: &Path, name: &str) -> Result<Option<String>, GitError> {
    let output = git_read_command(root)
        .args(["rev-parse", "--verify", "--quiet", name])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    Ok((!sha.is_empty()).then_some(sha))
}

/// Name a sha for display: a branch or remote-tracking ref pointing at it, else
/// its short form.
///
/// Deliberately not read out of `.git/MERGE_MSG`. That file holds git's
/// human-readable message ("Merge branch 'feature'"), and parsing it is exactly
/// what CLAUDE.md rules out. A failure here costs a nice label, nothing more, so
/// it degrades to the sha instead of propagating.
fn name_for(root: &Path, sha: &str) -> String {
    let short = || sha.chars().take(8).collect::<String>();
    let output = git_read_command(root)
        .args([
            "for-each-ref",
            "--format=%(refname:short)",
            "--count=1",
            "--points-at",
            sha,
            "refs/heads",
            "refs/remotes",
        ])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if name.is_empty() {
                short()
            } else {
                name
            }
        }
        _ => short(),
    }
}

/// Whether the index holds any unmerged entry. `ls-files --unmerged` is
/// plumbing: its presence, not its text, is the answer.
fn has_unmerged_paths(root: &Path) -> Result<bool, GitError> {
    let output = git_read_command(root)
        .args(["ls-files", "--unmerged", "-z"])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    Ok(!output.stdout.is_empty())
}

fn read_worktree_bytes(root: &Path, path: &str) -> Result<Vec<u8>, GitError> {
    let target = diff::resolve_read(root, path)
        .map_err(to_git_error)?
        .ok_or_else(|| GitError::Invalid(format!("'{path}' is no longer in the working tree")))?;
    std::fs::read(&target).map_err(|e| GitError::Io(format!("could not read '{path}': {e}")))
}

/// A path error from `diff` is already user-facing (a symlink, an escape), so it
/// travels as [`GitError::Invalid`] and renders without a prefix.
fn to_git_error(error: DiffError) -> GitError {
    GitError::Invalid(error.to_string())
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// Merge `reference` into the current branch.
///
/// A non-zero exit is not automatically a failure: the ordinary conflicting
/// merge exits non-zero having done exactly what it should. The two are told
/// apart by asking git what state the repository is now in.
pub fn merge(root: &Path, reference: &str) -> Result<MergeOutcome, GitError> {
    crate::branch::reject_unusable(reference)?;
    // Checked *before* running, and this is load-bearing for the conflict/failure
    // split below. git refuses a merge that starts mid-merge ("You have not
    // concluded your merge") without clearing MERGE_HEAD, so a state read
    // afterwards cannot tell that refusal from a fresh conflict — it would report
    // the refusal as a successful conflicted merge, under the *previous* merge's
    // name. Reachable whenever the state read is stale: a merge started in the
    // bottom terminal, inside the watcher's debounce.
    let before = merge_state(root)?;
    if before.kind != MergeKind::None {
        return Err(GitError::Invalid(format!(
            "{} already in progress; finish or abort it first",
            match before.kind {
                MergeKind::Merge => "a merge is",
                MergeKind::ConflictsOnly => "unresolved conflicts are",
                MergeKind::Rebase => "a rebase is",
                MergeKind::CherryPick => "a cherry-pick is",
                MergeKind::Revert => "a revert is",
                MergeKind::None => unreachable!("guarded above"),
            }
        )));
    }
    let mut cmd = git_command(root);
    // --no-edit: a real merge commit would otherwise open $EDITOR against a
    // closed stdin and hang forever.
    cmd.args(["merge", "--no-edit", reference]);
    no_editor(&mut cmd);
    let output = cmd.output().map_err(map_io_err)?;
    let text = stderr_of(&output);
    if output.status.success() {
        return Ok(MergeOutcome {
            conflicted: false,
            output: text,
        });
    }
    // Conflicted, or refused outright (dirty tree, unknown ref) — the state
    // says which, and git's own message is never parsed to find out.
    if merge_state(root)?.kind == MergeKind::Merge {
        return Ok(MergeOutcome {
            conflicted: true,
            output: text,
        });
    }
    Err(GitError::CommandFailed(text))
}

/// Conclude a conflicted merge, committing git's own generated message.
pub fn continue_merge(root: &Path) -> Result<(), GitError> {
    let mut cmd = git_command(root);
    cmd.args(["merge", "--continue"]);
    no_editor(&mut cmd);
    let output = cmd.output().map_err(map_io_err)?;
    if output.status.success() {
        return Ok(());
    }
    Err(GitError::CommandFailed(stderr_of(&output)))
}

/// Throw the merge away and restore the pre-merge working tree.
pub fn abort(root: &Path) -> Result<(), GitError> {
    let mut cmd = git_command(root);
    cmd.args(["merge", "--abort"]);
    let output = cmd.output().map_err(map_io_err)?;
    if output.status.success() {
        return Ok(());
    }
    Err(GitError::CommandFailed(stderr_of(&output)))
}

/// Apply `choice` to conflict `index` of `path`, staging the file once no
/// conflict is left in it.
///
/// `revision` is the hash of the bytes the caller's view was built from. A
/// mismatch is refused: the watcher, the terminal and Claude Code can all have
/// rewritten the file since, and block `index` of a stale parse is not
/// necessarily block `index` of what is on disk now.
pub fn resolve_conflict(
    root: &Path,
    path: &str,
    index: usize,
    choice: ConflictChoice,
    revision: &str,
) -> Result<ResolveOutcome, GitError> {
    let root = diff::canonical_root(root).map_err(to_git_error)?;
    let bytes = read_worktree_bytes(&root, path)?;
    if diff::looks_binary(&bytes) {
        return Err(GitError::Invalid(format!(
            "'{path}' is binary; choose one whole side instead"
        )));
    }
    if content_revision(&bytes) != revision {
        return Err(GitError::Invalid(format!(
            "'{path}' changed on disk since it was read; reload it and try again"
        )));
    }

    let eol = diff::detect_eol(&bytes);
    let text = diff::normalize_to_lf(&String::from_utf8_lossy(&bytes));
    let lines = split_lines(&text);
    let blocks = parse_conflicts(&text);
    let block = blocks.get(index).ok_or_else(|| {
        GitError::Invalid(format!(
            "that conflict is no longer in '{path}'; reload it and try again"
        ))
    })?;
    // A half-edited block has no defensible boundary between the sides, and
    // guessing one writes a marker line back into the file and then stages it —
    // which is how a `>>>>>>>` reaches a commit. Refuse and say what is wrong.
    if !block.complete {
        return Err(GitError::Invalid(format!(
            "that conflict in '{path}' is missing its ======= or >>>>>>> marker, \
             so there is no way to tell the two sides apart. Fix it by hand, then \
             mark the file resolved."
        )));
    }

    let updated = resolved_text(&lines, block, choice);
    diff::write_worktree_file(&root, path, &updated, eol).map_err(to_git_error)?;

    // Recounted from what was written rather than assumed to be one fewer: the
    // side we kept can itself contain marker-like lines, and the honest number
    // is the one the file now has.
    let remaining = parse_conflicts(&updated).len();
    let staged = remaining == 0;
    if staged {
        stage(&root, path)?;
    }
    Ok(ResolveOutcome { remaining, staged })
}

/// Resolve a whole path, for the conflicts with no merged text to edit.
pub fn resolve_path(root: &Path, path: &str, resolution: PathResolution) -> Result<(), GitError> {
    reject_unusable_path(path)?;
    match resolution {
        // `checkout --ours/--theirs` writes that stage into the working tree;
        // staging it is what marks the path resolved.
        PathResolution::KeepOurs => {
            run(git_command(root).args(["checkout", "--ours", "--", path]))?;
            stage(root, path)
        }
        PathResolution::KeepTheirs => {
            run(git_command(root).args(["checkout", "--theirs", "--", path]))?;
            stage(root, path)
        }
        // -f because the path is unmerged, which plain `git rm` refuses to touch:
        // it cannot tell a deliberate "the deletion is the resolution" from an
        // accident. The button that reaches here says it deletes the file.
        PathResolution::AcceptDeletion => run(git_command(root).args(["rm", "-f", "--", path])),
        // Whatever is in the working tree is what the user meant; nothing is
        // overwritten on the way.
        PathResolution::MarkResolved => stage(root, path),
    }
}

/// Reject a path git would read as a *pathspec* rather than a plain file.
///
/// `--` stops option parsing, not pathspec magic: `git rm -f -- ':(glob)**'`
/// still expands, and this is the one command here that deletes the user's files.
/// Every path reaching these functions comes from `git status` today, so this is
/// hardening — the kind worth having on the destructive path rather than
/// arguing about.
fn reject_unusable_path(path: &str) -> Result<(), GitError> {
    if path.is_empty() {
        return Err(GitError::Invalid("no file to resolve".to_string()));
    }
    // `:` introduces every form of pathspec magic (`:(glob)`, `:!`, `:/`).
    if path.starts_with(':') {
        return Err(GitError::Invalid(format!(
            "'{path}' is a pathspec, not a file"
        )));
    }
    // Absolute paths, drive prefixes and `..` traversal, as the diff module's
    // write path rejects them.
    for component in std::path::Path::new(path).components() {
        match component {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => {
                return Err(GitError::Invalid(format!(
                    "'{path}' resolves outside the repository"
                )))
            }
        }
    }
    Ok(())
}

/// `git add -- <path>`: what marks a conflicted path resolved.
fn stage(root: &Path, path: &str) -> Result<(), GitError> {
    run(git_command(root).args(["add", "--", path]))
}

/// Run a prepared command, mapping a non-zero exit to git's own output.
///
/// Unlike [`crate::git::run_checked`] this reports stdout when stderr is empty
/// (via [`stderr_of`]), which matters here: `git rm` and `git checkout` put some
/// of their most useful refusals on stdout.
fn run(cmd: &mut Command) -> Result<(), GitError> {
    let output = cmd.output().map_err(map_io_err)?;
    if output.status.success() {
        return Ok(());
    }
    Err(GitError::CommandFailed(stderr_of(&output)))
}

/// Make it impossible for git to open an editor.
///
/// `--no-edit` covers the documented paths; this covers the rest (a
/// `GIT_MERGE_AUTOEDIT` in the environment, a future subcommand that edits
/// anyway). `true` exits zero without reading anything, so git takes the
/// prepared message as-is.
fn no_editor(cmd: &mut Command) {
    cmd.env("GIT_EDITOR", "true");
    cmd.env("GIT_MERGE_AUTOEDIT", "no");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2-way conflict with context on both sides.
    const TWO_WAY: &str = "\
context above
<<<<<<< HEAD
ours line
=======
theirs line
>>>>>>> feature
context below
";

    /// The same conflict as git writes it with `merge.conflictStyle = diff3`.
    const DIFF3: &str = "\
context above
<<<<<<< HEAD
ours line
||||||| merged common ancestors
base line
=======
theirs line
>>>>>>> feature
context below
";

    fn lines_of(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_string).collect()
    }

    // --- marker_label ------------------------------------------------------

    #[test]
    fn a_marker_is_seven_or_more_characters_then_a_space_or_nothing() {
        assert_eq!(marker_label("<<<<<<< HEAD", '<'), Some("HEAD"));
        assert_eq!(marker_label("=======", '='), Some(""));
        // A repo that raised conflict-marker-size still parses.
        assert_eq!(marker_label("<<<<<<<<<< HEAD", '<'), Some("HEAD"));
        // Six is not a marker, whatever follows it.
        assert_eq!(marker_label("<<<<<< HEAD", '<'), None);
        assert_eq!(marker_label("", '<'), None);
    }

    #[test]
    fn marker_like_content_without_the_separating_space_is_not_a_marker() {
        // git always writes "<<<<<<< label", never glues the label on, so this
        // keeps a lexer fixture or a banner comment out of the parse.
        assert_eq!(marker_label("<<<<<<<HEAD", '<'), None);
        assert_eq!(marker_label("=======-", '='), None);
    }

    #[test]
    fn a_marker_is_only_recognised_for_its_own_character() {
        assert_eq!(marker_label("<<<<<<< HEAD", '='), None);
        assert_eq!(marker_label("=======", '>'), None);
    }

    // --- parse_conflicts ---------------------------------------------------

    #[test]
    fn a_file_with_no_markers_has_no_conflicts() {
        assert!(parse_conflicts("just\nsome\nlines\n").is_empty());
        assert!(parse_conflicts("").is_empty());
    }

    #[test]
    fn a_two_way_conflict_reports_both_sides_and_its_labels() {
        let blocks = parse_conflicts(TWO_WAY);
        assert_eq!(blocks.len(), 1);
        let block = &blocks[0];
        let lines = lines_of(TWO_WAY);

        assert_eq!(block.start, 1, "the <<<<<<< line");
        assert_eq!(block.end, 6, "one past the >>>>>>> line");
        assert_eq!(block.ours.slice(&lines), ["ours line".to_string()]);
        assert_eq!(block.theirs.slice(&lines), ["theirs line".to_string()]);
        assert_eq!(block.base, None);
        // Labels are display-only, but they still have to be the right text.
        assert_eq!(block.ours_label, "HEAD");
        assert_eq!(block.theirs_label, "feature");
    }

    #[test]
    fn a_diff3_conflict_reports_the_base_section_separately() {
        let blocks = parse_conflicts(DIFF3);
        let lines = lines_of(DIFF3);
        assert_eq!(blocks.len(), 1);
        let block = &blocks[0];
        assert_eq!(block.ours.slice(&lines), ["ours line".to_string()]);
        assert_eq!(
            block.base.expect("diff3 has a base").slice(&lines),
            ["base line".to_string()]
        );
        assert_eq!(block.theirs.slice(&lines), ["theirs line".to_string()]);
    }

    #[test]
    fn an_empty_side_is_an_empty_range_not_a_missing_one() {
        // Deleting a line on one side is an ordinary conflict, and its side has
        // no lines at all.
        let text = "<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> feature\n";
        let blocks = parse_conflicts(text);
        let lines = lines_of(text);
        assert!(blocks[0].ours.slice(&lines).is_empty());
        assert_eq!(blocks[0].theirs.slice(&lines), ["theirs".to_string()]);
    }

    #[test]
    fn several_conflicts_in_one_file_are_all_found_in_order() {
        let text = "\
<<<<<<< HEAD
first ours
=======
first theirs
>>>>>>> feature
middle
<<<<<<< HEAD
second ours
=======
second theirs
>>>>>>> feature
";
        let blocks = parse_conflicts(text);
        let lines = lines_of(text);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].ours.slice(&lines), ["first ours".to_string()]);
        assert_eq!(blocks[1].ours.slice(&lines), ["second ours".to_string()]);
        assert!(blocks[0].end <= blocks[1].start, "blocks must not overlap");
    }

    #[test]
    fn an_unterminated_conflict_is_still_reported_to_the_end_of_the_file() {
        // Half-hand-edited files exist. Showing the unfinished conflict beats
        // pretending the tail is ordinary content.
        let text = "<<<<<<< HEAD\nours\n=======\ntheirs\n";
        let blocks = parse_conflicts(text);
        let lines = lines_of(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].end, lines.len());
        assert_eq!(blocks[0].ours.slice(&lines), ["ours".to_string()]);
        assert!(
            !blocks[0].complete,
            "no >>>>>>> means it cannot be accepted"
        );
    }

    #[test]
    fn a_block_with_no_separator_keeps_the_terminator_out_of_ours() {
        // The regression this guards: with `=======` gone, `ours` used to run one
        // line past the terminator and swallow `>>>>>>> feature`, so accepting
        // that side wrote a conflict marker back into the file.
        let text = "top\n<<<<<<< HEAD\nours\n>>>>>>> feature\nbottom\n";
        let blocks = parse_conflicts(text);
        let lines = lines_of(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].ours.slice(&lines), ["ours".to_string()]);
        assert!(blocks[0].theirs.slice(&lines).is_empty());
        assert!(!blocks[0].complete);
        // Belt and braces: even if such a block were resolved, no marker survives.
        for choice in [
            ConflictChoice::Ours,
            ConflictChoice::Theirs,
            ConflictChoice::Both,
        ] {
            let resolved = resolved_text(&lines, &blocks[0], choice);
            assert!(
                !resolved.contains(">>>>>>>"),
                "a marker survived {choice:?}: {resolved}"
            );
        }
    }

    #[test]
    fn a_well_formed_block_is_complete_whatever_the_conflict_style() {
        assert!(parse_conflicts(TWO_WAY)[0].complete);
        assert!(parse_conflicts(DIFF3)[0].complete);
    }

    // --- resolved_text -----------------------------------------------------

    #[test]
    fn accepting_one_side_keeps_the_context_and_drops_the_markers() {
        let lines = lines_of(TWO_WAY);
        let block = &parse_conflicts(TWO_WAY)[0];
        assert_eq!(
            resolved_text(&lines, block, ConflictChoice::Ours),
            "context above\nours line\ncontext below\n"
        );
        assert_eq!(
            resolved_text(&lines, block, ConflictChoice::Theirs),
            "context above\ntheirs line\ncontext below\n"
        );
    }

    #[test]
    fn accepting_both_keeps_ours_then_theirs_and_drops_the_base() {
        let lines = lines_of(DIFF3);
        let block = &parse_conflicts(DIFF3)[0];
        let resolved = resolved_text(&lines, block, ConflictChoice::Both);
        assert_eq!(
            resolved,
            "context above\nours line\ntheirs line\ncontext below\n"
        );
        assert!(
            !resolved.contains("base line"),
            "the base section is git's explanation, not a third version to keep"
        );
    }

    #[test]
    fn resolving_one_conflict_leaves_the_others_untouched() {
        let text = "\
<<<<<<< HEAD
first ours
=======
first theirs
>>>>>>> feature
middle
<<<<<<< HEAD
second ours
=======
second theirs
>>>>>>> feature
";
        let lines = lines_of(text);
        let blocks = parse_conflicts(text);
        let resolved = resolved_text(&lines, &blocks[0], ConflictChoice::Ours);
        assert!(resolved.starts_with("first ours\nmiddle\n"));
        // The second conflict must still be there, markers and all.
        assert_eq!(parse_conflicts(&resolved).len(), 1);
    }

    #[test]
    fn a_file_with_no_trailing_newline_keeps_not_having_one() {
        let text = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature";
        let lines = lines_of(text);
        let block = &parse_conflicts(text)[0];
        assert_eq!(resolved_text(&lines, block, ConflictChoice::Ours), "ours");
    }

    // --- content_revision --------------------------------------------------

    // --- no_editor / path guard -------------------------------------------

    #[test]
    fn no_editor_pins_the_environment_that_stops_git_opening_one() {
        // Asserted on the command itself rather than through a merge, because a
        // behavioural test cannot fail here: git only opens an editor when stdin
        // and stdout are the same tty, and `git_command` closes stdin. That makes
        // a passing merge no evidence at all — while GIT_MERGE_AUTOEDIT=1 in the
        // user's environment *would* force an editor, and is exactly what
        // GIT_MERGE_AUTOEDIT=no here neutralises.
        let mut cmd = std::process::Command::new("git");
        no_editor(&mut cmd);
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(
            envs.contains(&("GIT_EDITOR".to_string(), Some("true".to_string()))),
            "GIT_EDITOR must be neutralised: {envs:?}"
        );
        assert!(
            envs.contains(&("GIT_MERGE_AUTOEDIT".to_string(), Some("no".to_string()))),
            "GIT_MERGE_AUTOEDIT must be neutralised: {envs:?}"
        );
    }

    #[test]
    fn a_pathspec_is_refused_before_a_destructive_command_runs() {
        // `--` stops option parsing, not pathspec magic, and `git rm -f` deletes
        // files: `:(glob)**` would reach every tracked path in the repo.
        assert!(reject_unusable_path("src/app.ts").is_ok());
        assert!(reject_unusable_path("./src/app.ts").is_ok());
        assert!(reject_unusable_path(":(glob)**").is_err());
        assert!(reject_unusable_path(":!src").is_err());
        assert!(reject_unusable_path("").is_err());
        assert!(reject_unusable_path("../outside.txt").is_err());
        #[cfg(unix)]
        assert!(reject_unusable_path("/etc/passwd").is_err());
        #[cfg(windows)]
        assert!(reject_unusable_path("C:\\Windows\\win.ini").is_err());
    }

    #[test]
    fn the_revision_is_stable_per_content_and_differs_between_files() {
        assert_eq!(content_revision(b"same"), content_revision(b"same"));
        assert_ne!(content_revision(b"one"), content_revision(b"two"));
        // A one-byte difference has to change it, or the guard lets a stale
        // parse through.
        assert_ne!(content_revision(b"ours\n"), content_revision(b"ours \n"));
    }
}

/// End to end against real repositories: no network, no fixtures pretending to
/// be git.
#[cfg(test)]
mod repo_tests {
    use super::*;
    use crate::git::{self, ConflictKind};
    use crate::testrepo::{
        commit_all, current_branch, git_in, git_raw, porcelain, read,
        repo_with_conflicting_branches, repo_with_delete_modify_branches, write,
    };

    /// Conflict the fixture's two branches and return the repo, mid-merge.
    fn conflicted() -> tempfile::TempDir {
        let dir = repo_with_conflicting_branches();
        let outcome = merge(dir.path(), "feature").expect("a conflicting merge is not an error");
        assert!(outcome.conflicted, "output was: {}", outcome.output);
        dir
    }

    fn conflicts_of(dir: &Path) -> Vec<crate::git::ConflictEntry> {
        git::status_from(dir).expect("status").conflicts
    }

    // --- merge -------------------------------------------------------------

    #[test]
    fn a_clean_merge_succeeds_and_leaves_no_merge_in_progress() {
        let dir = repo_with_conflicting_branches();
        // Move the feature edit somewhere that cannot clash.
        git_in(dir.path(), &["switch", "--quiet", "feature"]);
        write(dir.path(), "other.txt", "from feature\n");
        commit_all(dir.path(), "feature adds a second file");
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        git_in(dir.path(), &["reset", "--hard", "--quiet", "HEAD~1"]);

        let outcome = merge(dir.path(), "feature").expect("merge");
        assert!(!outcome.conflicted);
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        assert_eq!(read(dir.path(), "other.txt"), "from feature\n");
    }

    #[test]
    fn a_conflicting_merge_reports_a_conflict_rather_than_an_error() {
        let dir = conflicted();
        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::Merge);
        assert_eq!(
            state.merging_ref.as_deref(),
            Some("feature"),
            "the banner names what is being merged"
        );
        assert_eq!(
            conflicts_of(dir.path()),
            vec![crate::git::ConflictEntry {
                path: "file.txt".into(),
                kind: ConflictKind::BothModified,
            }]
        );
    }

    #[test]
    fn a_merge_git_refuses_outright_is_an_error_not_a_conflict() {
        // The distinction the whole non-zero-exit dance exists for: an unknown
        // ref must not be reported as "you now have conflicts".
        let dir = repo_with_conflicting_branches();
        let error = merge(dir.path(), "no-such-branch").expect_err("git must refuse");
        assert!(!error.to_string().is_empty());
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
    }

    #[test]
    fn a_dirty_tree_blocks_the_merge_and_says_so() {
        let dir = repo_with_conflicting_branches();
        write(
            dir.path(),
            "file.txt",
            "one\nlocal work in progress\nthree\n",
        );
        let error = merge(dir.path(), "feature").expect_err("git refuses to clobber local work");
        assert!(!error.to_string().is_empty(), "git's reason must survive");
        // And the local edit is still there, which is the point of not merging.
        assert_eq!(
            read(dir.path(), "file.txt"),
            "one\nlocal work in progress\nthree\n"
        );
    }

    #[test]
    fn a_merge_started_mid_merge_is_refused_and_not_reported_as_a_conflict() {
        // git refuses this without clearing MERGE_HEAD, so a state read afterwards
        // cannot tell the refusal from a fresh conflict: it would report "stopped
        // on conflicts" for a merge that never ran, naming the *previous* merge's
        // branch. Hence the pre-flight check.
        let dir = conflicted();
        let before = merge_state(dir.path()).expect("state");

        let error = merge(dir.path(), "feature").expect_err("a second merge must be refused");
        assert!(error.to_string().contains("already in progress"), "{error}");
        // And the first merge is untouched.
        assert_eq!(merge_state(dir.path()).expect("state"), before);
    }

    #[test]
    fn a_merge_is_refused_while_conflicts_are_outstanding_with_nothing_in_progress() {
        // The stash-restore state: git refuses a merge with unmerged files, and
        // the refusal must not read as a conflict either.
        let dir = repo_with_conflicting_branches();
        write(dir.path(), "file.txt", "one\nstashed\nthree\n");
        git_in(dir.path(), &["stash", "push", "--quiet"]);
        write(dir.path(), "file.txt", "one\nmoved on\nthree\n");
        commit_all(dir.path(), "moved on");
        assert!(!git_raw(dir.path(), &["stash", "pop"]).status.success());
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::ConflictsOnly
        );

        let error = merge(dir.path(), "feature").expect_err("refused");
        assert!(error.to_string().contains("already in progress"), "{error}");
    }

    #[test]
    fn a_real_merge_commit_is_made_without_an_editor() {
        // The non-fast-forward path: both sides moved, on files that do not clash,
        // so git writes a merge commit — the case that opens $EDITOR without
        // --no-edit. core.editor fails if it is ever run.
        let dir = repo_with_conflicting_branches();
        git_in(dir.path(), &["config", "core.editor", "exit 1"]);
        git_in(dir.path(), &["switch", "--quiet", "feature"]);
        write(dir.path(), "theirs-only.txt", "from feature\n");
        commit_all(dir.path(), "feature adds its own file");
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        // Undo main's clashing edit so the merge succeeds, then move it on again.
        git_in(dir.path(), &["reset", "--hard", "--quiet", "HEAD~1"]);
        write(dir.path(), "ours-only.txt", "from main\n");
        commit_all(dir.path(), "main adds its own file");

        let outcome = merge(dir.path(), "feature").expect("merge");
        assert!(!outcome.conflicted, "output was: {}", outcome.output);
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        let parents = git_raw(dir.path(), &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(
            String::from_utf8_lossy(&parents.stdout)
                .split_whitespace()
                .count(),
            3,
            "a merge commit has two parents"
        );
    }

    #[test]
    fn an_option_like_merge_target_is_refused_before_git_runs() {
        let dir = repo_with_conflicting_branches();
        assert!(merge(dir.path(), "--help").is_err());
        assert!(merge(dir.path(), "").is_err());
        // check-ref-format would *expand* this rather than reject it.
        assert!(merge(dir.path(), "@{-1}").is_err());
    }

    // --- resolve_conflict --------------------------------------------------

    #[test]
    fn accepting_ours_rewrites_the_file_and_stages_it() {
        let dir = conflicted();
        let file = conflict_file(dir.path(), "file.txt").expect("read");
        assert_eq!(file.blocks.len(), 1);
        assert!(!file.binary);

        let outcome = resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect("resolve");

        assert_eq!(outcome.remaining, 0);
        assert!(outcome.staged, "the last marker going stages the file");
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo from main\nthree\n");
        assert!(
            conflicts_of(dir.path()).is_empty(),
            "the path is no longer unmerged"
        );
        // No porcelain row to assert on here, and that is correct: keeping *our*
        // side puts the index back to exactly HEAD's content, so there is nothing
        // to show as staged. `conflicts_of` above is what proves the unmerged
        // entry is gone; the visible staged row is asserted in the theirs case.
    }

    #[test]
    fn accepting_theirs_keeps_the_other_side_and_shows_as_staged() {
        let dir = conflicted();
        let file = conflict_file(dir.path(), "file.txt").expect("read");
        resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Theirs,
            &file.revision,
        )
        .expect("resolve");
        assert_eq!(
            read(dir.path(), "file.txt"),
            "one\ntwo from feature\nthree\n"
        );
        assert!(
            porcelain(dir.path())
                .iter()
                .any(|line| line.starts_with('M') && line.ends_with("file.txt")),
            "the resolved file moves to Staged Changes: {:?}",
            porcelain(dir.path())
        );
    }

    #[test]
    fn accepting_both_keeps_ours_first() {
        let dir = conflicted();
        let file = conflict_file(dir.path(), "file.txt").expect("read");
        resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Both,
            &file.revision,
        )
        .expect("resolve");
        assert_eq!(
            read(dir.path(), "file.txt"),
            "one\ntwo from main\ntwo from feature\nthree\n"
        );
    }

    #[test]
    fn a_stale_revision_is_refused_instead_of_rewriting_the_wrong_hunk() {
        let dir = conflicted();
        let file = conflict_file(dir.path(), "file.txt").expect("read");
        // Someone else — the terminal, Claude Code, an editor — rewrites the file
        // between the read and the click.
        write(dir.path(), "file.txt", "rewritten by someone else\n");

        let error = resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect_err("a stale revision must be refused");
        assert!(error.to_string().contains("changed on disk"), "{error}");
        assert_eq!(
            read(dir.path(), "file.txt"),
            "rewritten by someone else\n",
            "the other writer's content must survive untouched"
        );
    }

    #[test]
    fn resolving_a_conflict_that_is_no_longer_there_is_refused() {
        let dir = conflicted();
        let file = conflict_file(dir.path(), "file.txt").expect("read");
        let error = resolve_conflict(
            dir.path(),
            "file.txt",
            7,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect_err("index out of range");
        assert!(error.to_string().contains("no longer"), "{error}");
    }

    #[test]
    fn one_conflict_at_a_time_leaves_the_rest_of_the_file_conflicted() {
        // Two conflicts in one file: resolving the first must not stage it.
        //
        // Two things this fixture has to get right. The file must exist in the
        // *base* commit — a path added on both branches has no merge base, so git
        // reports the whole file as one conflict rather than two. And the edits
        // must be far apart: git folds conflicting regions a line or two apart
        // into a single hunk.
        let base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
        let dir = crate::testrepo::repo_with_commit("two.txt", base);
        git_in(dir.path(), &["switch", "--quiet", "-c", "feature"]);
        write(
            dir.path(),
            "two.txt",
            &base.replace("b\n", "feature\n").replace("k\n", "feature\n"),
        );
        commit_all(dir.path(), "feature edits both ends");
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        write(
            dir.path(),
            "two.txt",
            &base.replace("b\n", "main\n").replace("k\n", "main\n"),
        );
        commit_all(dir.path(), "main edits both ends");
        let outcome = merge(dir.path(), "feature").expect("merge");
        assert!(outcome.conflicted);

        let file = conflict_file(dir.path(), "two.txt").expect("read");
        assert_eq!(file.blocks.len(), 2, "two separate hunks");
        let result = resolve_conflict(
            dir.path(),
            "two.txt",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect("resolve");
        assert_eq!(result.remaining, 1);
        assert!(
            !result.staged,
            "a file with a conflict left is not resolved"
        );
        assert!(
            conflicts_of(dir.path()).iter().any(|c| c.path == "two.txt"),
            "still unmerged"
        );
    }

    #[test]
    fn a_half_edited_conflict_is_refused_rather_than_guessed_at() {
        // Someone deletes the ======= line by hand (in the diff window, in the
        // terminal) and then clicks Accept ours. Guessing wrote `>>>>>>> feature`
        // back into the file and staged it, which is how a marker reaches a commit.
        let dir = conflicted();
        let path = dir.path().join("file.txt");
        let mangled: String = std::fs::read_to_string(&path)
            .expect("read")
            .lines()
            .filter(|line| !line.starts_with("======="))
            .map(|line| format!("{line}\n"))
            .collect();
        std::fs::write(&path, &mangled).expect("write");

        let file = conflict_file(dir.path(), "file.txt").expect("read");
        assert_eq!(file.blocks.len(), 1);
        assert!(
            !file.blocks[0].complete,
            "the window must know it is malformed"
        );

        let error = resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect_err("a malformed block must not be resolved");
        assert!(error.to_string().contains("missing its"), "{error}");
        // Nothing was written, and nothing was staged.
        assert_eq!(std::fs::read_to_string(&path).expect("read"), mangled);
        assert!(!conflicts_of(dir.path()).is_empty(), "still unmerged");
    }

    #[test]
    fn a_file_resolved_by_hand_can_be_marked_resolved() {
        // The escape hatch. git reports a path as unmerged until something stages
        // it, so without this a conflict resolved in the diff window or the
        // terminal would sit in the Conflicts group forever with Continue disabled.
        let dir = conflicted();
        std::fs::write(
            dir.path().join("file.txt"),
            "one\nresolved by hand\nthree\n",
        )
        .expect("write");

        resolve_path(dir.path(), "file.txt", PathResolution::MarkResolved).expect("mark resolved");

        assert!(conflicts_of(dir.path()).is_empty());
        // The hand-written content is what got staged: nothing was overwritten.
        assert_eq!(
            read(dir.path(), "file.txt"),
            "one\nresolved by hand\nthree\n"
        );
        continue_merge(dir.path()).expect("continue");
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
    }

    #[test]
    fn keeping_theirs_on_a_deleted_by_us_conflict_restores_their_file() {
        // The mirror of the delete/modify test: we deleted it, they changed it, so
        // their content is the only content there is.
        let dir = repo_with_delete_modify_branches();
        // Swap the roles by merging the other way round.
        git_in(dir.path(), &["switch", "--quiet", "feature"]);
        let outcome = merge(dir.path(), "main").expect("merge");
        assert!(outcome.conflicted, "output was: {}", outcome.output);
        assert_eq!(
            conflicts_of(dir.path())
                .iter()
                .map(|c| c.kind)
                .collect::<Vec<_>>(),
            vec![ConflictKind::DeletedByUs]
        );

        resolve_path(dir.path(), "file.txt", PathResolution::KeepTheirs).expect("keep theirs");
        assert!(conflicts_of(dir.path()).is_empty());
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo edited\n");
        continue_merge(dir.path()).expect("continue");
    }

    #[test]
    fn a_pathspec_never_reaches_git_rm() {
        let dir = conflicted();
        let error = resolve_path(dir.path(), ":(glob)**", PathResolution::AcceptDeletion)
            .expect_err("a pathspec is not a file");
        assert!(error.to_string().contains("pathspec"), "{error}");
        // The conflicted file is still there, which is the point.
        assert!(dir.path().join("file.txt").exists());
    }

    #[test]
    fn resolving_preserves_crlf_line_endings() {
        // The Windows case: rewriting one hunk must not convert the whole file.
        let dir = conflicted();
        let path = dir.path().join("file.txt");
        let lf = std::fs::read_to_string(&path).expect("read");
        std::fs::write(&path, lf.replace('\n', "\r\n")).expect("rewrite as CRLF");

        let file = conflict_file(dir.path(), "file.txt").expect("read");
        resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect("resolve");

        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"one\r\ntwo from main\r\nthree\r\n");
    }

    #[test]
    fn a_binary_conflict_is_reported_as_binary_and_not_marker_resolved() {
        let dir = repo_with_conflicting_branches();
        std::fs::write(dir.path().join("blob.bin"), [0x00, 0x01, 0x02]).expect("write");
        let file = conflict_file(dir.path(), "blob.bin").expect("read");
        assert!(file.binary);
        assert!(file.blocks.is_empty());
        assert!(file.lines.is_empty(), "no lossy decode of binary content");

        let error = resolve_conflict(
            dir.path(),
            "blob.bin",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect_err("binary content has no hunks to accept");
        assert!(error.to_string().contains("binary"), "{error}");
    }

    #[test]
    fn reading_a_path_outside_the_repository_is_refused() {
        let dir = conflicted();
        let error = conflict_file(dir.path(), "../escaped.txt").expect_err("traversal refused");
        assert!(!error.to_string().is_empty());
    }

    // --- continue / abort --------------------------------------------------

    #[test]
    fn continuing_commits_the_merge_without_ever_opening_an_editor() {
        let dir = conflicted();
        // A core.editor that fails if it is ever run. GIT_EDITOR (which
        // `no_editor` sets) overrides it, so a passing test proves no editor was
        // launched — and a regression here would hang or fail, not merely warn.
        git_in(dir.path(), &["config", "core.editor", "exit 1"]);

        let file = conflict_file(dir.path(), "file.txt").expect("read");
        resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect("resolve");
        continue_merge(dir.path()).expect("continue");

        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        assert!(porcelain(dir.path()).is_empty(), "the tree is clean again");
        // A merge commit with two parents, carrying git's own message.
        let parents = git_raw(dir.path(), &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(
            String::from_utf8_lossy(&parents.stdout)
                .split_whitespace()
                .count(),
            3,
            "commit plus two parents"
        );
    }

    #[test]
    fn continuing_with_conflicts_left_is_refused_by_git() {
        let dir = conflicted();
        let error = continue_merge(dir.path()).expect_err("git refuses an unresolved merge");
        assert!(!error.to_string().is_empty());
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::Merge,
            "still mid-merge"
        );
    }

    #[test]
    fn aborting_restores_the_pre_merge_working_tree() {
        let dir = conflicted();
        abort(dir.path()).expect("abort");

        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        assert!(conflicts_of(dir.path()).is_empty());
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo from main\nthree\n");
        assert_eq!(current_branch(dir.path()), "main");
        assert!(porcelain(dir.path()).is_empty());
    }

    // --- whole-file resolution --------------------------------------------

    #[test]
    fn a_delete_modify_conflict_reports_deleted_by_them_and_keeps_ours() {
        let dir = repo_with_delete_modify_branches();
        let outcome = merge(dir.path(), "feature").expect("merge");
        assert!(outcome.conflicted, "output was: {}", outcome.output);
        assert_eq!(
            conflicts_of(dir.path()),
            vec![crate::git::ConflictEntry {
                path: "file.txt".into(),
                kind: ConflictKind::DeletedByThem,
            }],
            "there are no markers here to accept"
        );

        resolve_path(dir.path(), "file.txt", PathResolution::KeepOurs).expect("keep ours");
        assert!(conflicts_of(dir.path()).is_empty());
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo edited\n");
        continue_merge(dir.path()).expect("continue");
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
    }

    #[test]
    fn accepting_the_deletion_removes_the_file_and_resolves_the_path() {
        let dir = repo_with_delete_modify_branches();
        merge(dir.path(), "feature").expect("merge");

        resolve_path(dir.path(), "file.txt", PathResolution::AcceptDeletion)
            .expect("accept the deletion");
        assert!(conflicts_of(dir.path()).is_empty());
        assert!(
            !dir.path().join("file.txt").exists(),
            "the deletion is the resolution"
        );
        continue_merge(dir.path()).expect("continue");
    }

    #[test]
    fn keeping_theirs_on_a_both_added_conflict_writes_their_version() {
        // Both branches added the same path with different content (AA).
        let dir = repo_with_conflicting_branches();
        git_in(dir.path(), &["switch", "--quiet", "feature"]);
        write(dir.path(), "new.txt", "from feature\n");
        commit_all(dir.path(), "feature adds new.txt");
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        write(dir.path(), "new.txt", "from main\n");
        commit_all(dir.path(), "main adds new.txt");
        merge(dir.path(), "feature").expect("merge");

        assert!(conflicts_of(dir.path())
            .iter()
            .any(|c| c.path == "new.txt" && c.kind == ConflictKind::BothAdded));
        resolve_path(dir.path(), "new.txt", PathResolution::KeepTheirs).expect("keep theirs");
        assert_eq!(read(dir.path(), "new.txt"), "from feature\n");
    }

    #[test]
    fn a_rename_rename_conflict_offers_the_deletion_of_the_original_path() {
        // How a both-deleted (DD) conflict actually arises: each side renamed the
        // same file somewhere else, so the original path is deleted on both and
        // git leaves all three paths unmerged. Agreeing to the deletion of the
        // original is the only resolution it has.
        let dir = crate::testrepo::repo_with_commit("old.txt", "kept\n");
        git_in(dir.path(), &["switch", "--quiet", "-c", "feature"]);
        git_in(dir.path(), &["mv", "old.txt", "theirs.txt"]);
        commit_all(dir.path(), "feature renames it");
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        git_in(dir.path(), &["mv", "old.txt", "ours.txt"]);
        commit_all(dir.path(), "main renames it");

        let outcome = merge(dir.path(), "feature").expect("merge");
        assert!(outcome.conflicted, "output was: {}", outcome.output);

        let conflicts = conflicts_of(dir.path());
        let original = conflicts
            .iter()
            .find(|c| c.path == "old.txt")
            .expect("the original path is unmerged, got: {conflicts:?}");
        assert_eq!(original.kind, ConflictKind::BothDeleted);

        // `git rm` on an unmerged path needs -f; without it this button could
        // only ever fail, which is why resolve_path passes it.
        for conflict in &conflicts {
            resolve_path(dir.path(), &conflict.path, PathResolution::AcceptDeletion)
                .unwrap_or_else(|e| panic!("resolve {}: {e}", conflict.path));
        }
        assert!(conflicts_of(dir.path()).is_empty());
        continue_merge(dir.path()).expect("continue");
    }

    // --- state detection ---------------------------------------------------

    #[test]
    fn a_conflicted_stash_pop_is_conflicts_only_with_nothing_to_continue() {
        // Part 5's "leave my changes" round trip, when the branch has moved on.
        let dir = repo_with_conflicting_branches();
        write(dir.path(), "file.txt", "one\nstashed work\nthree\n");
        git_in(dir.path(), &["stash", "push", "--quiet"]);
        write(dir.path(), "file.txt", "one\nsomething else\nthree\n");
        commit_all(dir.path(), "moved on");
        let popped = git_raw(dir.path(), &["stash", "pop"]);
        assert!(!popped.status.success(), "the pop must conflict");

        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::ConflictsOnly);
        assert!(!state.kind.is_merge(), "there is no merge to continue");
        assert!(!conflicts_of(dir.path()).is_empty());

        // And the same resolution path finishes it — no continue needed.
        let file = conflict_file(dir.path(), "file.txt").expect("read");
        let outcome = resolve_conflict(
            dir.path(),
            "file.txt",
            0,
            ConflictChoice::Ours,
            &file.revision,
        )
        .expect("resolve");
        assert!(outcome.staged);
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
    }

    #[test]
    fn a_conflicted_rebase_is_named_and_not_mistaken_for_a_merge() {
        // Reachable today: Part 5's bare `pull` honours pull.rebase.
        let dir = repo_with_conflicting_branches();
        let rebase = git_raw(dir.path(), &["rebase", "feature"]);
        assert!(
            !rebase.status.success(),
            "the rebase must stop on a conflict"
        );

        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::Rebase);
        assert!(
            !state.kind.is_merge(),
            "merge --continue/--abort are the wrong commands here"
        );
        // Leave the fixture in a state its TempDir can clean up.
        git_in(dir.path(), &["rebase", "--abort"]);
    }

    #[test]
    fn a_clean_repository_reports_no_operation_in_progress() {
        let dir = repo_with_conflicting_branches();
        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::None);
        assert_eq!(state.merging_ref, None);
    }

    #[test]
    fn the_merged_ref_falls_back_to_a_sha_when_no_branch_points_at_it() {
        let dir = repo_with_conflicting_branches();
        let sha = git_raw(dir.path(), &["rev-parse", "feature"]);
        let sha = String::from_utf8_lossy(&sha.stdout).trim().to_string();
        // Merge the commit directly, then delete the branch that named it.
        let outcome = merge(dir.path(), &sha).expect("merge by sha");
        assert!(outcome.conflicted);
        git_in(dir.path(), &["branch", "-D", "feature"]);

        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::Merge);
        let name = state.merging_ref.expect("something to show");
        assert!(sha.starts_with(&name), "{name} should be a prefix of {sha}");
    }
}
