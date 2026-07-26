//! Merging, conflict detection and conflict resolution.
//!
//! Same shape as the rest of the crate: the decisions live in pure, unit-tested
//! functions ([`parse_conflicts`], [`parse_unmerged`], [`content_revision`]) and
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
use crate::git::{
    git_command, git_literal_command, git_read_command, map_io_err, reject_unusable_path,
    stderr_of, GitError,
};
use crate::mergechunks::{
    chunks, equivalent_ignoring_marker_labels, serialize_result, Labels, PlacedChunk,
};

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
    /// Each of these replays commits, so each has its own command family — see
    /// [`MergeKind::argv_family`].
    Rebase,
    CherryPick,
    Revert,
}

impl MergeKind {
    /// The git subcommand whose `--continue` / `--skip` / `--abort` conclude this
    /// state, or `None` when there is nothing to conclude.
    ///
    /// This is the single place the four families are mapped, and [`run_op`]
    /// reads it from a *freshly read* state rather than from anything the caller
    /// supplied — sending `rebase --abort` at a merge would be a very expensive
    /// way to act on a stale frontend.
    pub fn argv_family(self) -> Option<&'static str> {
        match self {
            MergeKind::Merge => Some("merge"),
            MergeKind::Rebase => Some("rebase"),
            MergeKind::CherryPick => Some("cherry-pick"),
            MergeKind::Revert => Some("revert"),
            // Nothing is in progress in either: a bare pile of conflicted paths
            // has no operation to conclude.
            MergeKind::None | MergeKind::ConflictsOnly => None,
        }
    }

    /// Whether this operation has a `--skip`, i.e. whether it replays a *series*
    /// of commits any one of which can be dropped. A merge does not.
    pub fn can_skip(self) -> bool {
        matches!(
            self,
            MergeKind::Rebase | MergeKind::CherryPick | MergeKind::Revert
        )
    }
}

/// How far through a multi-commit operation the repository is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpProgress {
    /// 1-based position of the commit being applied.
    pub current: u32,
    pub total: u32,
}

/// The repository's in-progress state, for the banner above the file list.
///
/// The "into" side is deliberately absent for a merge: it is the current branch,
/// which the frontend already holds from `git_branch_state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeState {
    pub kind: MergeKind,
    /// What is being applied — the merged ref for a merge, the branch being
    /// replayed for a rebase, else a short sha. `None` where there is no such ref.
    pub merging_ref: Option<String>,
    /// What a rebase is replaying *onto*. `None` for every other kind.
    pub onto: Option<String>,
    /// Subject of the commit being applied, for a cherry-pick or revert — a bare
    /// sha names nothing a person recognises in a banner.
    pub subject: Option<String>,
    /// Position in the series, where the operation has one.
    pub progress: Option<OpProgress>,
    /// Mirrors [`MergeKind::can_skip`], so the frontend hides the button rather
    /// than duplicating the knowledge of which families have a `--skip`.
    pub can_skip: bool,
}

impl MergeState {
    /// A state with nothing in progress and no names to show.
    fn bare(kind: MergeKind) -> Self {
        MergeState {
            kind,
            merging_ref: None,
            onto: None,
            subject: None,
            progress: None,
            can_skip: kind.can_skip(),
        }
    }
}

/// A half-open range of line indices into [`ConflictFile::lines`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

impl LineRange {
    pub(crate) fn new(start: usize, end: usize) -> Self {
        LineRange { start, end }
    }

    /// Clamped, because a range built from one text is sometimes sliced against
    /// another that a watcher-driven reload has since shortened. A short slice
    /// renders wrong; an out-of-bounds one panics inside a Tauri command.
    pub(crate) fn slice<'a>(&self, lines: &'a [String]) -> &'a [String] {
        let end = self.end.min(lines.len());
        &lines[self.start.min(end)..end]
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

/// One index stage of an unmerged path, from `git ls-files --unmerged`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmergedStage {
    /// 1 = merge base, 2 = ours, 3 = theirs. git defines no others.
    pub stage: u8,
    pub sha: String,
    pub path: String,
}

/// A conflicted file as the three-pane editor needs it: the index stages, the
/// chunks between them, and the buffer to start from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStages {
    pub path: String,
    /// Stage 1, the merge base. A path with **no** stage 1 — a both-added one —
    /// gets the *empty file* here rather than nothing, which is what makes every
    /// line of both sides an insertion. Note that the empty file is `[""]` under
    /// `split_lines`' convention, not an empty vector: the final empty line is the
    /// trailing-newline sentinel, and dropping it would push the other two sides'
    /// sentinels inside the conflict block.
    pub base: Vec<String>,
    /// Stage 2, our side. Empty (a zero-length vector) when there is no stage 2,
    /// in which case `stages` says so and there is nothing to merge.
    pub ours: Vec<String>,
    /// Stage 3, their side.
    pub theirs: Vec<String>,
    /// Which stages the index actually holds. **Empty means the path is no longer
    /// unmerged** — something staged it, in this app or outside it — which the
    /// window renders as resolved rather than as an empty editor. Fewer than both
    /// 2 and 3 means there is no text to merge line by line, only a whole-file
    /// decision.
    pub stages: Vec<u8>,
    /// Empty unless both content stages are present.
    pub chunks: Vec<PlacedChunk>,
    /// The initial result buffer: every chunk resolved the way git resolved it,
    /// conflicts left as markers.
    pub result: String,
    /// The working-tree file, LF-normalised. What "use the file on disk" loads,
    /// and what `diverged` was decided against.
    pub disk: String,
    /// Follows `<<<<<<<` in the buffer. Display only.
    pub ours_label: String,
    /// Follows `>>>>>>>`. Display only.
    pub theirs_label: String,
    /// Hash of the working-tree bytes; hand it back when writing.
    pub revision: String,
    /// True when the file on disk is neither git's own merge of these stages nor
    /// our rebuild of it — so someone has edited it, and loading the rebuild
    /// would take their work off the screen without saying so.
    pub diverged: bool,
    /// True when there is nothing textual to merge.
    pub binary: bool,
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
pub(crate) fn marker_label(line: &str, marker: char) -> Option<&str> {
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

/// The marker character when `line` is a conflict marker of any kind.
///
/// Used to compare two rendered merges structurally — see
/// [`crate::mergechunks::equivalent_ignoring_marker_labels`] — where two marker
/// lines of the same character are the same line whatever label follows.
pub(crate) fn marker_char(line: &str) -> Option<char> {
    ['<', '=', '>', '|']
        .into_iter()
        .find(|&marker| marker_label(line, marker).is_some())
}

/// Find every conflict in `text` (LF-separated).
///
/// Line-based and single-pass. A block missing one of its markers is still
/// reported, flagged `complete: false`: the file genuinely has an unfinished
/// conflict in it, and showing it beats pretending the tail is ordinary content.
/// A file still holding one cannot be *written* — see [`write_resolved`] — because
/// an unfinished conflict is not a resolved file, whatever the buffer's own count
/// of it says.
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

/// Parse `git ls-files --unmerged -z`: `<mode> SP <sha> SP <stage> TAB <path>`,
/// one NUL-terminated record per stage.
///
/// **The record separator is a NUL**, not a newline: a path can contain a newline
/// and `-z` is the only form that survives one. Part 6's review caught a NUL
/// being silently replaced by a space during a refactor — it renders invisibly in
/// most tooling — so the tests for this spell the bytes out literally.
///
/// A record that does not parse is skipped rather than failing the read: a
/// missing stage degrades to a whole-file decision, which the window can still
/// offer, whereas an error leaves it with nothing at all.
pub fn parse_unmerged(bytes: &[u8]) -> Vec<UnmergedStage> {
    bytes
        .split(|&byte| byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let text = String::from_utf8_lossy(record);
            // The path can contain spaces, so split on the tab first — the three
            // metadata fields are before it and never contain one.
            let (meta, path) = text.split_once('\t')?;
            let mut fields = meta.split(' ');
            let _mode = fields.next()?;
            let sha = fields.next()?;
            let stage = fields.next()?.parse::<u8>().ok()?;
            (1..=3).contains(&stage).then(|| UnmergedStage {
                stage,
                sha: sha.to_string(),
                path: path.to_string(),
            })
        })
        .collect()
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
            merging_ref: Some(name_for(root, &sha)),
            ..MergeState::bare(MergeKind::Merge)
        });
    }
    if let Some(dir) = rebase_dir(&git_dir) {
        // An interactive rebase paused between steps has no REBASE_HEAD, so the
        // state directory is the reliable signal.
        return Ok(MergeState {
            // The branch being replayed, and where onto. Both come from git's own
            // state files rather than from a ref, because mid-rebase HEAD is
            // detached at the commit being applied.
            merging_ref: state_file(&dir, "head-name").map(short_ref),
            onto: state_file(&dir, "onto").map(|sha| name_for(root, &sha)),
            progress: rebase_progress(&dir),
            ..MergeState::bare(MergeKind::Rebase)
        });
    }
    for (pseudo, kind) in [
        ("CHERRY_PICK_HEAD", MergeKind::CherryPick),
        ("REVERT_HEAD", MergeKind::Revert),
    ] {
        if let Some(sha) = pseudo_ref(root, pseudo)? {
            return Ok(MergeState {
                merging_ref: Some(name_for(root, &sha)),
                subject: subject_of(root, &sha),
                // No progress counter for these, deliberately. The sequencer keeps
                // only a `todo` of the picks *still to do*, including the one it is
                // stuck on, and writes no `done` file — so "N of M" cannot be
                // derived from it without counting commits since
                // `sequencer/head`, which is more machinery than a counter is
                // worth. The banner reads fine without one.
                ..MergeState::bare(kind)
            });
        }
    }
    if has_unmerged_paths(root)? {
        return Ok(MergeState::bare(MergeKind::ConflictsOnly));
    }
    Ok(MergeState::bare(MergeKind::None))
}

/// Whichever rebase state directory exists: `rebase-merge` for the merge/
/// interactive backend, `rebase-apply` for the older `am` one.
fn rebase_dir(git_dir: &Path) -> Option<PathBuf> {
    ["rebase-merge", "rebase-apply"]
        .into_iter()
        .map(|name| git_dir.join(name))
        .find(|dir| dir.is_dir())
}

/// Read one of git's small state files — a bare integer, a ref name.
///
/// These are machine-readable state, not the prose in `MERGE_MSG` that CLAUDE.md
/// rules out parsing. Every failure degrades to `None`: a banner missing its
/// counter is far better than a banner that fails to render mid-rebase.
fn state_file(dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(name))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// `refs/heads/feature` → `feature`. A rebase started on a detached HEAD writes
/// the literal `detached HEAD`, which passes through unchanged.
fn short_ref(reference: String) -> String {
    match reference.strip_prefix("refs/heads/") {
        Some(short) => short.to_string(),
        None => reference,
    }
}

/// Position in a rebase. The two backends count in differently named files.
fn rebase_progress(dir: &Path) -> Option<OpProgress> {
    let pair = |current: &str, total: &str| -> Option<OpProgress> {
        Some(OpProgress {
            current: state_file(dir, current)?.parse().ok()?,
            total: state_file(dir, total)?.parse().ok()?,
        })
    };
    pair("msgnum", "end").or_else(|| pair("next", "last"))
}

/// Subject line of `sha`. `%s` is a documented pretty-format placeholder, not
/// localized prose — and a bare sha names nothing a person recognises.
fn subject_of(root: &Path, sha: &str) -> Option<String> {
    let output = git_read_command(root)
        .args(["log", "-1", "--format=%s", sha])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|subject| !subject.is_empty())
}

/// Read one conflicted file for the three-pane editor: its index stages, the
/// chunks between them, and the buffer to open with.
pub fn conflict_stages(root: &Path, path: &str) -> Result<ConflictStages, GitError> {
    let root = diff::canonical_root(root).map_err(to_git_error)?;
    let entries = unmerged_stages(&root, path)?;
    let stages: Vec<u8> = entries.iter().map(|entry| entry.stage).collect();
    let blob_of = |stage: u8| -> Result<Vec<u8>, GitError> {
        match entries.iter().find(|entry| entry.stage == stage) {
            Some(entry) => stage_blob(&root, &entry.sha),
            None => Ok(Vec::new()),
        }
    };
    let (base_bytes, our_bytes, their_bytes) = (blob_of(1)?, blob_of(2)?, blob_of(3)?);

    // A missing working-tree file is a real state here, not an error: a
    // both-deleted conflict has no file at all.
    let disk_bytes = read_worktree_bytes_opt(&root, path)?.unwrap_or_default();
    let revision = content_revision(&disk_bytes);
    let binary = [
        disk_bytes.as_slice(),
        our_bytes.as_slice(),
        their_bytes.as_slice(),
    ]
    .iter()
    .any(|bytes| diff::looks_binary(bytes));

    // Both content stages, and text: anything less has no line-by-line merge to
    // show, only the whole-file decision the panel already offers.
    let mergeable = stages.contains(&2) && stages.contains(&3) && !binary;
    let disk = diff::normalize_to_lf(&String::from_utf8_lossy(&disk_bytes));
    if !mergeable {
        return Ok(ConflictStages {
            path: path.to_string(),
            base: Vec::new(),
            ours: Vec::new(),
            theirs: Vec::new(),
            stages,
            chunks: Vec::new(),
            result: String::new(),
            disk,
            ours_label: String::new(),
            theirs_label: String::new(),
            revision,
            diverged: false,
            binary,
        });
    }

    let to_lines =
        |bytes: &[u8]| split_lines(&diff::normalize_to_lf(&String::from_utf8_lossy(bytes)));
    let (base, ours, theirs) = (
        to_lines(&base_bytes),
        to_lines(&our_bytes),
        to_lines(&their_bytes),
    );
    let (ours_label, theirs_label) = marker_labels(&root);
    let labels = Labels {
        ours: &ours_label,
        theirs: &theirs_label,
    };
    let (result, placed) = serialize_result(
        &chunks(&base, &ours, &theirs),
        &base,
        &ours,
        &theirs,
        labels,
    );

    // The divergence guard. Compared against *git's own* merge of these stages
    // first, because our diff is allowed to draw hunk boundaries differently from
    // git's xdiff — if the comparison were only against our rebuild, an ordinary
    // untouched file would look edited and the banner would cry wolf on every
    // open. Our rebuild is accepted too, which is what stops a file this window
    // has already part-resolved from being flagged when it is reopened.
    let diverged = match git_merge_file(&root, &base_bytes, &our_bytes, &their_bytes, labels) {
        Ok(git_version) => {
            !equivalent_ignoring_marker_labels(&disk, &git_version)
                && !equivalent_ignoring_marker_labels(&disk, &result)
        }
        // Losing the comparison must not lose the window. Claiming divergence we
        // cannot demonstrate would push the user at "start over" for no reason,
        // so an unavailable reproduction reads as "not diverged".
        Err(_) => false,
    };

    Ok(ConflictStages {
        path: path.to_string(),
        base,
        ours,
        theirs,
        stages,
        chunks: placed,
        result,
        disk,
        ours_label,
        theirs_label,
        revision,
        diverged,
        binary,
    })
}

/// The index stages of one path, in stage order.
fn unmerged_stages(root: &Path, path: &str) -> Result<Vec<UnmergedStage>, GitError> {
    reject_unusable_path(path)?;
    let output = git_read_command(root)
        .args(["ls-files", "--unmerged", "-z", "--", path])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    let mut entries = parse_unmerged(&output.stdout);
    // `--` restricts to this path, but a pathspec could still widen it; keep only
    // exact matches so a stage of some other file can never be read as ours.
    entries.retain(|entry| entry.path == path);
    entries.sort_by_key(|entry| entry.stage);
    Ok(entries)
}

/// One stage blob, exactly as stored — no smudge filters, so no CRLF translation.
fn stage_blob(root: &Path, sha: &str) -> Result<Vec<u8>, GitError> {
    let output = git_read_command(root)
        .args(["cat-file", "blob", sha])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    Ok(output.stdout)
}

/// Reproduce git's own merge of the three stages, for the divergence guard.
///
/// `git merge-file` **exits with the number of conflicts it wrote**, so a non-zero
/// status is the ordinary case and reading it as a failure would make every
/// conflicted file look diverged. Its documented error signal is a negative value,
/// which reaches us as a code above 127.
///
/// The merged text is produced from temp files rather than from the working tree
/// so that nothing here can write to the user's file, and the command runs with
/// the repository as its cwd so that `merge.conflictStyle` still applies — a
/// diff3 repo has to compare against diff3 output.
fn git_merge_file(
    root: &Path,
    base: &[u8],
    ours: &[u8],
    theirs: &[u8],
    labels: Labels,
) -> Result<String, GitError> {
    let io_err = |e: std::io::Error| GitError::Io(format!("could not stage the merge: {e}"));
    let dir = tempfile::tempdir().map_err(io_err)?;
    let write = |name: &str, bytes: &[u8]| -> Result<PathBuf, GitError> {
        let target = dir.path().join(name);
        std::fs::write(&target, bytes).map_err(io_err)?;
        Ok(target)
    };
    // Argument order is <current> <base> <other>, and the three -L labels line up
    // with it.
    let our_file = write("ours", ours)?;
    let base_file = write("base", base)?;
    let their_file = write("theirs", theirs)?;
    let output = git_read_command(root)
        .args(["merge-file", "-p", "-L", labels.ours, "-L", "base", "-L"])
        .arg(labels.theirs)
        .args([&our_file, &base_file, &their_file])
        .output()
        .map_err(map_io_err)?;
    match output.status.code() {
        Some(0..=127) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
        _ => Err(GitError::CommandFailed(stderr_of(&output))),
    }
}

/// Labels for the markers this window writes.
///
/// `HEAD` for our side, matching what git itself writes, and the applied ref or
/// commit subject for theirs. Display only, both of them; a failure to name the
/// other side costs a label and nothing else.
fn marker_labels(root: &Path) -> (String, String) {
    let theirs = match merge_state(root) {
        Ok(state) => state.merging_ref.or(state.subject),
        Err(_) => None,
    };
    (
        "HEAD".to_string(),
        theirs.unwrap_or_else(|| "theirs".into()),
    )
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

/// The working-tree file, or `None` when it is not there.
///
/// Absence is a state, not a failure: a both-deleted conflict has no file, and a
/// delete/modify one may or may not depending on which side deleted it.
fn read_worktree_bytes_opt(root: &Path, path: &str) -> Result<Option<Vec<u8>>, GitError> {
    let Some(target) = diff::resolve_read(root, path).map_err(to_git_error)? else {
        return Ok(None);
    };
    match std::fs::read(&target) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(GitError::Io(format!("could not read '{path}': {e}"))),
    }
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

/// The three ways out of an operation in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpAction {
    /// Commit what is staged and carry on, with git's own generated message.
    Continue,
    /// Drop the commit being applied and move to the next one. Destructive, and
    /// only some families have it.
    Skip,
    /// Undo the whole operation.
    Abort,
}

impl OpAction {
    fn flag(self) -> &'static str {
        match self {
            OpAction::Continue => "--continue",
            OpAction::Skip => "--skip",
            OpAction::Abort => "--abort",
        }
    }
}

/// Continue, skip or abort whatever the repository is in the middle of.
///
/// The **state is read here, not taken from the caller**, and the argv follows
/// from it. That is the same principle as [`merge`] reading the state before it
/// runs: the frontend's copy is only as fresh as the last watcher event, and
/// `rebase --abort` sent at a merge — or worse, `merge --abort` sent at a rebase —
/// would be a very expensive way to act on stale information.
pub fn run_op(root: &Path, action: OpAction) -> Result<(), GitError> {
    let state = merge_state(root)?;
    let Some(family) = state.kind.argv_family() else {
        return Err(GitError::Invalid(match state.kind {
            MergeKind::ConflictsOnly => "these conflicts came from restoring stashed changes, \
                 so there is no operation to continue or abort — resolving them is all there is"
                .to_string(),
            _ => "nothing is in progress".to_string(),
        }));
    };
    if action == OpAction::Skip && !state.kind.can_skip() {
        return Err(GitError::Invalid(format!(
            "a {family} has no commit to skip"
        )));
    }
    let mut cmd = git_command(root);
    cmd.args([family, action.flag()]);
    // Every family opens $EDITOR for the commit message it is about to make, and
    // `git_command` gives its children a closed stdin — so an editor here is a
    // subprocess that can never return. This is the correctness requirement Part 6
    // established, now applying to four commands instead of one.
    no_editor(&mut cmd);
    let output = cmd.output().map_err(map_io_err)?;
    if output.status.success() {
        return Ok(());
    }
    Err(GitError::CommandFailed(stderr_of(&output)))
}

/// Write the fully resolved `text` for `path` and stage it.
///
/// Two guards, both refusals rather than best-effort writes:
///
/// - **`revision`** is the hash of the working-tree bytes the caller's buffer was
///   built from. A mismatch means the file moved under the window — the watcher,
///   the terminal, Claude Code — and the honest answer is to reload rather than
///   overwrite whatever is there now with a buffer built from something else.
/// - **`parse_conflicts` must find nothing.** That is git's own definition of
///   resolved and the backend is what enforces it, so a frontend counter that has
///   drifted (or a `<<<<<<<` the user typed by hand) cannot get a marker committed.
///
/// The write is the *only* one this window makes: the buffer lives in memory until
/// every conflict is decided, which is why there is no debounce and no adopt-guard
/// dance against our own echo here.
pub fn write_resolved(
    root: &Path,
    path: &str,
    text: &str,
    revision: &str,
) -> Result<ResolveOutcome, GitError> {
    let root = diff::canonical_root(root).map_err(to_git_error)?;
    let bytes = read_worktree_bytes_opt(&root, path)?
        .ok_or_else(|| GitError::Invalid(format!("'{path}' is no longer in the working tree")))?;
    if content_revision(&bytes) != revision {
        return Err(GitError::Invalid(format!(
            "'{path}' changed on disk since it was read; reload it and try again"
        )));
    }

    let resolved = diff::normalize_to_lf(text);
    let remaining = parse_conflicts(&resolved).len();
    if remaining > 0 {
        return Err(GitError::Invalid(format!(
            "'{path}' still has {remaining} unresolved conflict{}; \
             decide {} before it can be staged",
            if remaining == 1 { "" } else { "s" },
            if remaining == 1 { "it" } else { "them all" },
        )));
    }

    // The file's own endings, not the buffer's: the buffer is always LF.
    let eol = diff::detect_eol(&bytes);
    diff::write_worktree_file(&root, path, &resolved, eol).map_err(to_git_error)?;
    stage(&root, path)?;
    Ok(ResolveOutcome {
        remaining: 0,
        staged: true,
    })
}

/// Resolve a whole path, for the conflicts with no merged text to edit.
pub fn resolve_path(root: &Path, path: &str, resolution: PathResolution) -> Result<(), GitError> {
    reject_unusable_path(path)?;
    match resolution {
        // `checkout --ours/--theirs` writes that stage into the working tree;
        // staging it is what marks the path resolved.
        PathResolution::KeepOurs => {
            run(git_literal_command(root).args(["checkout", "--ours", "--", path]))?;
            stage(root, path)
        }
        PathResolution::KeepTheirs => {
            run(git_literal_command(root).args(["checkout", "--theirs", "--", path]))?;
            stage(root, path)
        }
        // -f because the path is unmerged, which plain `git rm` refuses to touch:
        // it cannot tell a deliberate "the deletion is the resolution" from an
        // accident. The button that reaches here says it deletes the file.
        PathResolution::AcceptDeletion => {
            run(git_literal_command(root).args(["rm", "-f", "--", path]))
        }
        // Whatever is in the working tree is what the user meant; nothing is
        // overwritten on the way.
        PathResolution::MarkResolved => stage(root, path),
    }
}

/// `git add -- <path>`: what marks a conflicted path resolved.
fn stage(root: &Path, path: &str) -> Result<(), GitError> {
    run(git_literal_command(root).args(["add", "--", path]))
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
    }

    #[test]
    fn a_well_formed_block_is_complete_whatever_the_conflict_style() {
        assert!(parse_conflicts(TWO_WAY)[0].complete);
        assert!(parse_conflicts(DIFF3)[0].complete);
    }

    // --- parse_unmerged ----------------------------------------------------

    #[test]
    fn all_three_stages_of_one_path_are_read() {
        // Literal bytes, separators written as `\x00` rather than `\0`: this is
        // the exact shape of `ls-files --unmerged -z`, a NUL renders invisibly in
        // most tooling, and `\0100644` reads as an octal escape to both a human
        // and to clippy even though Rust's `\0` is always NUL.
        let bytes = b"100644 aaa1 1\tsrc/main.rs\x00100644 bbb2 2\tsrc/main.rs\x00100644 ccc3 3\tsrc/main.rs\x00";
        let stages = parse_unmerged(bytes);
        assert_eq!(stages.len(), 3);
        assert_eq!(stages[0].stage, 1);
        assert_eq!(stages[0].sha, "aaa1");
        assert_eq!(stages[2].stage, 3);
        assert!(stages.iter().all(|s| s.path == "src/main.rs"));
    }

    #[test]
    fn a_path_with_spaces_survives_the_tab_split() {
        // Why the split is on the tab and not on spaces: the three metadata fields
        // never contain one, the path routinely does.
        let bytes = b"100644 aaa1 2\tmy notes/to do.md\x00";
        let stages = parse_unmerged(bytes);
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].path, "my notes/to do.md");
    }

    #[test]
    fn a_newline_in_a_path_is_not_a_record_boundary() {
        // The whole reason for `-z`. Splitting on newlines would report two
        // garbage records here instead of one real one.
        let bytes = b"100644 aaa1 2\tweird\nname.txt\x00";
        let stages = parse_unmerged(bytes);
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].path, "weird\nname.txt");
    }

    #[test]
    fn a_missing_stage_is_simply_absent() {
        // A both-added path has no stage 1. Reporting two stages is the truth;
        // inventing an empty stage 1 would be a lie the chunk model acts on.
        let bytes = b"100644 bbb2 2\tnew.txt\x00100644 ccc3 3\tnew.txt\x00";
        let stages = parse_unmerged(bytes);
        assert_eq!(
            stages.iter().map(|s| s.stage).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    #[test]
    fn malformed_and_out_of_range_records_are_skipped_not_fatal() {
        // Stage 0 is a resolved entry, not an unmerged one, and a record with no
        // tab is not a record at all. Skipping leaves the window a whole-file
        // decision to offer; erroring would leave it nothing.
        let bytes = b"100644 aaa1 0\tresolved.txt\x00nonsense\x00100644 bbb2 2\treal.txt\x00";
        let stages = parse_unmerged(bytes);
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].path, "real.txt");
    }

    #[test]
    fn empty_output_means_no_unmerged_paths() {
        assert!(parse_unmerged(b"").is_empty());
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
        repo_with_cherry_pick_conflict, repo_with_commit, repo_with_conflicting_branches,
        repo_with_delete_modify_branches, repo_with_rebase_conflict, write,
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

    /// A path both branches added, so the index has stages 2 and 3 but no 1.
    fn empty_repo_with_both_adding() -> tempfile::TempDir {
        let dir = repo_with_conflicting_branches();
        git_in(dir.path(), &["switch", "--quiet", "feature"]);
        write(dir.path(), "added.txt", "from feature\n");
        commit_all(dir.path(), "feature adds it");
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        write(dir.path(), "added.txt", "from main\n");
        commit_all(dir.path(), "main adds it");
        assert!(merge(dir.path(), "feature").expect("merge").conflicted);
        dir
    }

    /// A conflict on a file whose content is not text on either side.
    fn repo_with_binary_conflict() -> tempfile::TempDir {
        let dir = empty_repo_with_binary_branches();
        assert!(merge(dir.path(), "feature").expect("merge").conflicted);
        dir
    }

    fn empty_repo_with_binary_branches() -> tempfile::TempDir {
        let dir = crate::testrepo::empty_repo();
        std::fs::write(dir.path().join("blob.bin"), [0x00, 0x01, 0x02]).expect("write");
        commit_all(dir.path(), "initial binary");
        git_in(dir.path(), &["switch", "--quiet", "-c", "feature"]);
        std::fs::write(dir.path().join("blob.bin"), [0x00, 0xAA, 0x02]).expect("write");
        commit_all(dir.path(), "feature changes the bytes");
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        std::fs::write(dir.path().join("blob.bin"), [0x00, 0xBB, 0x02]).expect("write");
        commit_all(dir.path(), "main changes the bytes");
        dir
    }

    /// Conflicted paths with **nothing in progress**: a stash that would not
    /// reapply because the branch moved on under it.
    fn conflicted_stash_pop() -> tempfile::TempDir {
        let dir = repo_with_conflicting_branches();
        write(dir.path(), "file.txt", "one\nstashed work\nthree\n");
        git_in(dir.path(), &["stash", "push", "--quiet"]);
        write(dir.path(), "file.txt", "one\nsomething else\nthree\n");
        commit_all(dir.path(), "moved on");
        let popped = git_raw(dir.path(), &["stash", "pop"]);
        assert!(!popped.status.success(), "the pop must conflict");
        dir
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

    // --- conflict_stages ---------------------------------------------------

    #[test]
    fn the_index_stages_and_the_chunks_between_them_are_read() {
        let dir = conflicted();
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");

        assert_eq!(stages.stages, vec![1, 2, 3]);
        assert!(!stages.binary);
        // Each side as git stored it, not as the working tree has it.
        assert_eq!(stages.base, vec!["one", "two", "three", ""]);
        assert_eq!(stages.ours, vec!["one", "two from main", "three", ""]);
        assert_eq!(stages.theirs, vec!["one", "two from feature", "three", ""]);
        assert_eq!(
            stages
                .chunks
                .iter()
                .filter(|c| c.kind == crate::mergechunks::ChunkKind::Conflict)
                .count(),
            1
        );
        // The buffer opens with that one conflict marked, labelled as git labels
        // its own.
        assert_eq!(parse_conflicts(&stages.result).len(), 1);
        assert_eq!(stages.ours_label, "HEAD");
        assert_eq!(stages.theirs_label, "feature");
    }

    /// The load-bearing test of this part. Our diff is allowed to split hunks
    /// differently from git's xdiff, so if the divergence guard were comparing
    /// against our own rebuild it would fire on ordinary untouched files and the
    /// banner would cry wolf on every single open.
    #[test]
    fn a_file_git_just_wrote_does_not_look_diverged() {
        let dir = conflicted();
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        assert!(
            !stages.diverged,
            "a freshly conflicted file is not an edited one; disk was:\n{}",
            stages.disk
        );
    }

    #[test]
    fn a_diff3_repository_still_does_not_look_diverged() {
        // git writes an extra `|||||||` base section in this style, which our
        // two-way serialisation does not have. The guard has to compare against
        // git's own output for that to be a non-event.
        let dir = repo_with_conflicting_branches();
        git_in(dir.path(), &["config", "merge.conflictStyle", "diff3"]);
        let outcome = merge(dir.path(), "feature").expect("merge");
        assert!(outcome.conflicted);

        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        assert!(
            stages.disk.contains("|||||||"),
            "the fixture must actually be in diff3 style: {}",
            stages.disk
        );
        assert!(!stages.diverged, "disk was:\n{}", stages.disk);
    }

    #[test]
    fn a_hand_edited_file_looks_diverged_and_is_still_readable() {
        let dir = conflicted();
        write(dir.path(), "file.txt", "one\nresolved by hand\nthree\n");
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");

        assert!(stages.diverged, "the window has to be able to say so");
        // And the edit is handed back, because "use the file on disk" needs it.
        assert_eq!(stages.disk, "one\nresolved by hand\nthree\n");
        // The rebuild is still there to start over from.
        assert_eq!(parse_conflicts(&stages.result).len(), 1);
    }

    #[test]
    fn a_crlf_working_file_is_not_divergence_on_its_own() {
        // Blobs are stored LF; the working file may be CRLF. That difference is a
        // line-ending convention, not an edit.
        let dir = conflicted();
        let path = dir.path().join("file.txt");
        let lf = std::fs::read_to_string(&path).expect("read");
        std::fs::write(&path, lf.replace('\n', "\r\n")).expect("rewrite as CRLF");

        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        assert!(!stages.diverged, "disk was:\n{}", stages.disk);
    }

    #[test]
    fn a_both_added_conflict_has_no_base_stage_but_still_merges() {
        // No merge base at all, which is exactly the empty-base case the chunk
        // model has to treat as "every line is an insertion" rather than as an
        // error.
        let dir = empty_repo_with_both_adding();
        let stages = conflict_stages(dir.path(), "added.txt").expect("read");
        assert_eq!(stages.stages, vec![2, 3]);
        // The *empty file*, which is `[""]` under split_lines' convention, not a
        // zero-length vector: the trailing-newline sentinel has to keep a
        // counterpart in the base, or it falls inside the conflict block and
        // serialises as a blank line in each side.
        assert!(
            stages.base.join("\n").is_empty(),
            "an absent stage 1 is the empty file: {:?}",
            stages.base
        );
        assert!(!stages.chunks.is_empty(), "still mergeable");
        assert_eq!(parse_conflicts(&stages.result).len(), 1);
        // And the rebuild is what git wrote, blank lines and all.
        assert!(!stages.diverged, "disk was:\n{}", stages.disk);
    }

    #[test]
    fn a_delete_modify_conflict_has_only_one_content_stage() {
        // One side has no content, so there is nothing to merge line by line and
        // the window has to fall back to the whole-file decision rather than open
        // an editor with an empty pane.
        let dir = repo_with_delete_modify_branches();
        assert!(merge(dir.path(), "feature").expect("merge").conflicted);
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        assert_eq!(stages.stages, vec![1, 2]);
        assert!(stages.chunks.is_empty(), "no line-by-line merge to offer");
        assert!(stages.result.is_empty());
        assert!(!stages.diverged);
    }

    #[test]
    fn a_binary_conflict_reports_binary_and_no_chunks() {
        let dir = repo_with_binary_conflict();
        let stages = conflict_stages(dir.path(), "blob.bin").expect("read");
        assert!(stages.binary);
        assert!(stages.chunks.is_empty());
        assert!(
            stages.ours.is_empty() && stages.theirs.is_empty(),
            "no lossy decode of binary content"
        );
    }

    #[test]
    fn a_path_that_is_no_longer_unmerged_reports_no_stages() {
        // How the window knows to render "resolved" instead of an empty editor,
        // including for a file staged outside the app.
        let dir = conflicted();
        resolve_path(dir.path(), "file.txt", PathResolution::MarkResolved).expect("stage");
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        assert!(stages.stages.is_empty());
        assert!(stages.chunks.is_empty());
    }

    #[test]
    fn reading_a_path_outside_the_repository_is_refused() {
        let dir = conflicted();
        let error = conflict_stages(dir.path(), "../escaped.txt").expect_err("traversal refused");
        assert!(!error.to_string().is_empty());
    }

    // --- write_resolved ----------------------------------------------------

    #[test]
    fn writing_a_resolved_file_stages_it() {
        let dir = conflicted();
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");

        let outcome = write_resolved(
            dir.path(),
            "file.txt",
            "one\ntwo from main\nthree\n",
            &stages.revision,
        )
        .expect("write");

        assert_eq!(outcome.remaining, 0);
        assert!(outcome.staged);
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo from main\nthree\n");
        assert!(
            conflicts_of(dir.path()).is_empty(),
            "the path is no longer unmerged"
        );
    }

    #[test]
    fn a_resolved_file_shows_as_staged() {
        // Keeping *their* side leaves content that differs from HEAD, so there is
        // a visible staged row to assert on — the confirmation the user sees.
        let dir = conflicted();
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        write_resolved(
            dir.path(),
            "file.txt",
            "one\ntwo from feature\nthree\n",
            &stages.revision,
        )
        .expect("write");
        assert!(
            porcelain(dir.path())
                .iter()
                .any(|line| line.starts_with('M') && line.ends_with("file.txt")),
            "the resolved file moves to Staged Changes: {:?}",
            porcelain(dir.path())
        );
    }

    #[test]
    fn text_with_a_conflict_left_in_it_is_refused() {
        // The backend, not the frontend's counter, is what decides "resolved" —
        // so a marker cannot reach a commit through a drifted UI count or a
        // `<<<<<<<` the user typed by hand.
        let dir = conflicted();
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        let before = read(dir.path(), "file.txt");

        let error = write_resolved(dir.path(), "file.txt", &stages.result, &stages.revision)
            .expect_err("markers must not be written and staged");
        assert!(error.to_string().contains("unresolved conflict"), "{error}");
        assert_eq!(read(dir.path(), "file.txt"), before, "nothing was written");
        assert!(!conflicts_of(dir.path()).is_empty(), "still unmerged");
    }

    #[test]
    fn a_stale_revision_is_refused_instead_of_overwriting() {
        let dir = conflicted();
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        // Someone else — the terminal, Claude Code, an editor — rewrites the file
        // between the read and the resolve.
        write(dir.path(), "file.txt", "rewritten by someone else\n");

        let error = write_resolved(
            dir.path(),
            "file.txt",
            "one\ntwo from main\nthree\n",
            &stages.revision,
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
    fn writing_preserves_crlf_line_endings() {
        // The Windows case: the buffer is always LF, the file keeps its own.
        let dir = conflicted();
        let path = dir.path().join("file.txt");
        let lf = std::fs::read_to_string(&path).expect("read");
        std::fs::write(&path, lf.replace('\n', "\r\n")).expect("rewrite as CRLF");

        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        write_resolved(
            dir.path(),
            "file.txt",
            "one\ntwo from main\nthree\n",
            &stages.revision,
        )
        .expect("write");

        assert_eq!(
            std::fs::read(&path).expect("read"),
            b"one\r\ntwo from main\r\nthree\r\n"
        );
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
        run_op(dir.path(), OpAction::Continue).expect("continue");
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
        run_op(dir.path(), OpAction::Continue).expect("continue");
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

    // --- run_op: merge -----------------------------------------------------

    #[test]
    fn continuing_commits_the_merge_without_ever_opening_an_editor() {
        let dir = conflicted();
        // A core.editor that fails if it is ever run. GIT_EDITOR (which
        // `no_editor` sets) overrides it, so a passing test proves no editor was
        // launched — and a regression here would hang or fail, not merely warn.
        git_in(dir.path(), &["config", "core.editor", "exit 1"]);

        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        write_resolved(
            dir.path(),
            "file.txt",
            "one\ntwo from main\nthree\n",
            &stages.revision,
        )
        .expect("write");
        run_op(dir.path(), OpAction::Continue).expect("continue");

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
        let error =
            run_op(dir.path(), OpAction::Continue).expect_err("git refuses an unresolved merge");
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
        run_op(dir.path(), OpAction::Abort).expect("abort");

        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        assert!(conflicts_of(dir.path()).is_empty());
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo from main\nthree\n");
        assert_eq!(current_branch(dir.path()), "main");
        assert!(porcelain(dir.path()).is_empty());
    }

    #[test]
    fn a_merge_has_no_commit_to_skip() {
        // `git merge --skip` does not exist. Refused here rather than sent to git,
        // and the banner hides the button for the same reason.
        let dir = conflicted();
        let state = merge_state(dir.path()).expect("state");
        assert!(!state.can_skip);
        let error = run_op(dir.path(), OpAction::Skip).expect_err("merge has no --skip");
        assert!(error.to_string().contains("no commit to skip"), "{error}");
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::Merge,
            "and nothing happened to the merge"
        );
    }

    #[test]
    fn nothing_in_progress_has_nothing_to_conclude() {
        let dir = repo_with_conflicting_branches();
        for action in [OpAction::Continue, OpAction::Skip, OpAction::Abort] {
            let error = run_op(dir.path(), action).expect_err("nothing to do");
            assert!(
                error.to_string().contains("nothing is in progress"),
                "{error}"
            );
        }
    }

    #[test]
    fn conflicts_from_a_stash_have_no_operation_to_conclude() {
        // The stash-restore state: resolving is the whole job, and `merge
        // --continue` would be the wrong command rather than a no-op.
        let dir = conflicted_stash_pop();
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::ConflictsOnly
        );
        let error = run_op(dir.path(), OpAction::Continue).expect_err("nothing to continue");
        assert!(error.to_string().contains("stashed changes"), "{error}");
    }

    // --- run_op: rebase, cherry-pick, revert -------------------------------

    #[test]
    fn a_conflicted_rebase_is_named_with_where_it_is_going_and_how_far() {
        let dir = repo_with_rebase_conflict();
        let state = merge_state(dir.path()).expect("state");

        assert_eq!(state.kind, MergeKind::Rebase);
        assert_eq!(
            state.merging_ref.as_deref(),
            Some("feature"),
            "the branch being replayed"
        );
        assert_eq!(state.onto.as_deref(), Some("main"), "and where onto");
        assert!(
            state.can_skip,
            "a rebase can drop the commit it is stuck on"
        );
        let progress = state.progress.expect("a rebase counts its commits");
        assert_eq!(progress.total, 2, "two commits are being replayed");
        assert!(progress.current >= 1 && progress.current <= progress.total);
    }

    #[test]
    fn a_conflicted_rebase_is_resolved_and_continued_with_rebase_argv() {
        // The whole point of dispatching on the state: `merge --continue` here
        // would fail, and Part 6 disabled the button rather than get this wrong.
        let dir = repo_with_rebase_conflict();
        git_in(dir.path(), &["config", "core.editor", "exit 1"]);
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        assert_eq!(stages.stages, vec![1, 2, 3], "the editor works unchanged");

        write_resolved(
            dir.path(),
            "file.txt",
            "one\ntwo resolved\nthree\n",
            &stages.revision,
        )
        .expect("write");
        run_op(dir.path(), OpAction::Continue).expect("continue the rebase");

        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None,
            "the rebase finished"
        );
        assert_eq!(current_branch(dir.path()), "feature");
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo resolved\nthree\n");
    }

    #[test]
    fn a_rebase_commit_can_be_skipped() {
        let dir = repo_with_rebase_conflict();
        run_op(dir.path(), OpAction::Skip).expect("skip the conflicting commit");

        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        // Skip drops that commit's changes, which is why it sits behind a confirm:
        // main's version of the line is what survives.
        assert_eq!(read(dir.path(), "file.txt"), "one\ntwo from main\nthree\n");
        // The commit that replayed cleanly is still there.
        assert!(dir.path().join("extra.txt").exists());
    }

    #[test]
    fn a_rebase_can_be_aborted_back_to_where_it_started() {
        let dir = repo_with_rebase_conflict();
        run_op(dir.path(), OpAction::Abort).expect("abort the rebase");

        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        assert_eq!(current_branch(dir.path()), "feature");
        assert_eq!(
            read(dir.path(), "file.txt"),
            "one\ntwo from feature\nthree\n",
            "feature's own version is back"
        );
        assert!(porcelain(dir.path()).is_empty());
    }

    #[test]
    fn a_conflicted_cherry_pick_is_named_by_its_subject_and_continued() {
        let dir = repo_with_cherry_pick_conflict();
        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::CherryPick);
        assert_eq!(
            state.subject.as_deref(),
            Some("feature edits the shared line"),
            "a bare sha names nothing a person recognises"
        );
        assert!(state.can_skip);

        git_in(dir.path(), &["config", "core.editor", "exit 1"]);
        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        write_resolved(
            dir.path(),
            "file.txt",
            "one\ntwo resolved\nthree\n",
            &stages.revision,
        )
        .expect("write");
        run_op(dir.path(), OpAction::Continue).expect("continue the cherry-pick");

        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        assert!(porcelain(dir.path()).is_empty());
    }

    #[test]
    fn a_conflicted_revert_is_driven_by_revert_argv() {
        let dir = repo_with_commit("file.txt", "one\ntwo\nthree\n");
        write(dir.path(), "file.txt", "one\nsecond\nthree\n");
        commit_all(dir.path(), "second edit");
        let target = crate::testrepo::rev_parse(dir.path(), "HEAD");
        write(dir.path(), "file.txt", "one\nthird\nthree\n");
        commit_all(dir.path(), "third edit");
        // Reverting the middle commit cannot apply cleanly on top of the third.
        assert!(!git_raw(dir.path(), &["revert", "--no-edit", &target])
            .status
            .success());

        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::Revert);
        assert!(state.can_skip);

        run_op(dir.path(), OpAction::Abort).expect("abort the revert");
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
        assert_eq!(read(dir.path(), "file.txt"), "one\nthird\nthree\n");
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
        run_op(dir.path(), OpAction::Continue).expect("continue");
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
        run_op(dir.path(), OpAction::Continue).expect("continue");
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
        run_op(dir.path(), OpAction::Continue).expect("continue");
    }

    // --- state detection ---------------------------------------------------

    #[test]
    fn a_conflicted_stash_pop_is_conflicts_only_and_finishes_by_resolving() {
        // Part 5's "leave my changes" round trip, when the branch has moved on.
        // There is no operation to conclude here: staging the file is the end of it.
        let dir = conflicted_stash_pop();
        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::ConflictsOnly);
        assert_eq!(state.kind.argv_family(), None, "no command concludes this");
        assert!(!conflicts_of(dir.path()).is_empty());

        let stages = conflict_stages(dir.path(), "file.txt").expect("read");
        assert_eq!(stages.stages, vec![1, 2, 3], "the editor works here too");
        let outcome = write_resolved(
            dir.path(),
            "file.txt",
            "one\nstashed work\nthree\n",
            &stages.revision,
        )
        .expect("write");
        assert!(outcome.staged);
        assert_eq!(
            merge_state(dir.path()).expect("state").kind,
            MergeKind::None
        );
    }

    #[test]
    fn a_clean_repository_reports_no_operation_in_progress() {
        let dir = repo_with_conflicting_branches();
        let state = merge_state(dir.path()).expect("state");
        assert_eq!(state.kind, MergeKind::None);
        assert_eq!(state.merging_ref, None);
        assert_eq!(state.progress, None);
        assert!(!state.can_skip);
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
