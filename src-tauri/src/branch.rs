//! Branch and ref state, plus the non-network branch mutations.
//!
//! Per CLAUDE.md: shell out to `git` and parse only machine-readable output.
//! Reading is one `for-each-ref` with `%00` field separators (git's format hex
//! escape) and `\n` records — a ref name cannot contain a control character, so
//! that framing is unambiguous and needs no quoting.
//!
//! Two traps this module exists to avoid, both about *not* using the obvious
//! field:
//!
//! - **Ahead/behind** comes from `rev-list --left-right --count`, not from
//!   `%(upstream:track)`. The latter renders prose (`[ahead 1, behind 3]`) and
//!   in the opposite order to the plumbing. In `<upstream>...HEAD` the *left*
//!   side is the upstream, so left is how far behind we are.
//! - **`refs/remotes/<remote>/HEAD`** is a symbolic ref, not a branch, and its
//!   `%(refname:short)` is bare `origin`. Filtering it on the short name would
//!   leave a phantom branch called "origin" in the dropdown, so the full
//!   refname is what gets tested.
//!
//! The parsers are pure and unit-tested against fixture strings; the runners
//! are the thin shell-out layer around them.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::git::{
    git_command, git_read_command, head_short_sha, map_io_err, run_checked, stderr_of, GitError,
};

/// Prefix of every stash this app creates, so an auto-restore only ever pops
/// its own stash and never one the user made by hand.
const STASH_MARKER: &str = "isabuild:";

/// The `for-each-ref` format: NUL-separated fields, one ref per line.
///
/// Both forms of the upstream are read. The short one is what the UI shows; the
/// full ref is what can be *verified*, and it has to be the full one because an
/// upstream is not necessarily under `refs/remotes` (`git branch --track` against
/// a local branch sets `branch.<n>.remote = .`).
const REF_FORMAT: &str = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream)%00%(committerdate:unix)%00%(objectname:short)";

/// One parsed `for-each-ref` row, before it is sorted into local/remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefRow {
    /// Full ref, e.g. `refs/heads/main` or `refs/remotes/origin/main`.
    pub refname: String,
    /// Abbreviated ref, e.g. `main` or `origin/main`.
    pub short: String,
    /// Configured upstream (locals only), e.g. `origin/main`.
    pub upstream: Option<String>,
    /// The same upstream as a full ref, e.g. `refs/remotes/origin/main`. Comes
    /// from `branch.<n>.merge` config, so git still reports it after the ref
    /// itself has been pruned — which is exactly why it gets verified.
    pub upstream_ref: Option<String>,
    /// Committer date as a unix timestamp; 0 when unparseable.
    pub committer_date: u64,
    pub head_short: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub committer_date: u64,
    pub head_short: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// Short name including the remote, e.g. `origin/feature`.
    pub name: String,
    /// The remote, e.g. `origin`.
    pub remote: String,
    /// The branch part, e.g. `feature` — may itself contain slashes.
    pub branch: String,
    /// True when a local branch of the same name already exists, so picking
    /// this row should switch to the local branch instead of creating one.
    pub has_local: bool,
    pub committer_date: u64,
    pub head_short: String,
}

/// Everything the branch UI needs, in one round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    /// Current branch, or `None` on a detached HEAD.
    pub current: Option<String>,
    /// Short sha when HEAD is detached.
    pub detached_sha: Option<String>,
    /// True when HEAD points at a branch with no commits yet.
    pub unborn: bool,
    /// Upstream of the current branch, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// True when an upstream is configured but its ref no longer exists — the
    /// remote branch was deleted and the tracking ref pruned.
    ///
    /// Worth its own flag because `upstream` stays populated in that state (it is
    /// read from config, not from the ref), so without this the UI would report a
    /// perfectly healthy-looking `↑0 ↓0` for a branch whose remote copy is gone.
    pub upstream_gone: bool,
    /// True when the upstream ref lives under `refs/remotes/`, i.e. it really is a
    /// remote-tracking branch.
    ///
    /// `git branch --track topic main` sets `branch.topic.remote = "."`, giving a
    /// perfectly valid upstream that is a *local* branch. The sync cluster is
    /// about a remote, so it needs to know the difference: without this it would
    /// tell the user a missing local branch "no longer exists on the remote" and
    /// offer to push to recreate it.
    pub upstream_on_remote: bool,
    /// Remote that fetch/push would target, resolved from the upstream or
    /// falling back (see [`resolve_remote`]). `None` when there is no usable one.
    pub remote: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// `FETCH_HEAD` mtime as a unix timestamp; `None` when never fetched.
    pub last_fetch: Option<u64>,
    pub locals: Vec<LocalBranch>,
    pub remotes: Vec<RemoteBranch>,
}

/// What to do with uncommitted changes when switching away from a branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirtyPolicy {
    /// Let git carry the changes across. git does this natively when they do
    /// not collide, and unlike a stash round trip it preserves the
    /// staged/unstaged split exactly. When git refuses, the caller sees its
    /// stderr and can retry with `Leave`.
    Bring,
    /// Stash the changes (marked for this branch) and leave them behind.
    Leave,
}

/// Where a switch should end up.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchTarget {
    /// The local branch to be on afterwards.
    pub branch: String,
    /// When set, `branch` does not exist locally yet: create it tracking this
    /// remote-tracking ref (e.g. `origin/feature`). The local name is passed
    /// explicitly rather than left to git's DWIM, so it is predictable.
    pub track: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOutcome {
    pub branch: String,
    /// Branch whose changes were stashed on the way out, if any.
    pub stashed_from: Option<String>,
    /// True when a marker stash was restored on arrival.
    pub restored: bool,
    /// Non-fatal problems worth telling the user about — the switch itself
    /// succeeded.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/// Parse `for-each-ref` output in [`REF_FORMAT`]. Symbolic `*/HEAD` rows are
/// dropped: they are not branches, and their short name is just the remote.
pub fn parse_for_each_ref(bytes: &[u8]) -> Vec<RefRow> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(parse_ref_row)
        .collect()
}

fn parse_ref_row(line: &str) -> Option<RefRow> {
    let mut fields = line.split('\0');
    let refname = fields.next()?;
    let short = fields.next()?;
    let upstream = fields.next()?;
    let upstream_ref = fields.next()?;
    let date = fields.next()?;
    let head_short = fields.next()?;
    // `refs/remotes/<remote>/HEAD` is a symbolic ref, not a branch, and its
    // `refname:short` is bare `origin` — filtering on the short name would leave
    // a phantom branch called "origin" in the list. Scoped to remotes on
    // purpose: `git branch foo/HEAD` is legal, and such a local branch must not
    // vanish from the menu.
    if refname.is_empty() || (refname.starts_with("refs/remotes/") && refname.ends_with("/HEAD")) {
        return None;
    }
    Some(RefRow {
        refname: refname.to_string(),
        short: short.to_string(),
        upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
        upstream_ref: (!upstream_ref.is_empty()).then(|| upstream_ref.to_string()),
        committer_date: date.parse().unwrap_or(0),
        head_short: head_short.to_string(),
    })
}

/// Split parsed rows into locals and remote-tracking branches, flagging the
/// remote rows that already have a local counterpart.
pub fn dedupe_remotes(
    rows: &[RefRow],
    remotes: &[String],
) -> (Vec<LocalBranch>, Vec<RemoteBranch>) {
    let mut locals = Vec::new();
    let mut remote_rows = Vec::new();
    for row in rows {
        if let Some(name) = row.refname.strip_prefix("refs/heads/") {
            locals.push(LocalBranch {
                name: name.to_string(),
                upstream: row.upstream.clone(),
                committer_date: row.committer_date,
                head_short: row.head_short.clone(),
            });
        } else if row.refname.starts_with("refs/remotes/") {
            remote_rows.push(row);
        }
    }
    let local_names: HashSet<&str> = locals.iter().map(|l| l.name.as_str()).collect();
    let remote_branches = remote_rows
        .into_iter()
        .map(|row| {
            let (remote, branch) = split_remote(&row.short, remotes);
            RemoteBranch {
                name: row.short.clone(),
                remote: remote.to_string(),
                branch: branch.to_string(),
                has_local: local_names.contains(branch),
                committer_date: row.committer_date,
                head_short: row.head_short.clone(),
            }
        })
        .collect();
    (locals, remote_branches)
}

/// Split `origin/feature/x` into its remote and branch parts. Both halves may
/// contain slashes, so the known remote names decide the boundary (longest
/// match wins); the first slash is only a fallback for an unknown remote.
fn split_remote<'a>(short: &'a str, remotes: &[String]) -> (&'a str, &'a str) {
    let best = remotes
        .iter()
        .filter(|r| {
            short
                .strip_prefix(r.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
        })
        .max_by_key(|r| r.len());
    match best {
        Some(remote) => (&short[..remote.len()], &short[remote.len() + 1..]),
        None => short.split_once('/').unwrap_or(("", short)),
    }
}

/// Parse `git rev-list --left-right --count <upstream>...HEAD` into
/// `(ahead, behind)`.
///
/// git prints `<left>\t<right>`, and with the upstream on the left of the
/// range, left counts commits only the upstream has — i.e. how far *behind* we
/// are. Returning the pair the other way round is the classic bug here, so both
/// orientations are covered by tests.
pub fn parse_ahead_behind(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.split_whitespace();
    let behind: u32 = parts.next()?.parse().ok()?;
    let ahead: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((ahead, behind))
}

/// Find the newest stash this app left for `branch` in `git stash list
/// --format=%gd%x00%gs` output, returning its `stash@{n}` ref.
///
/// `git stash push -m <msg>` stores the subject as `On <branch>: <msg>`, so the
/// marker is matched as a suffix. `stash list` is newest-first, so the first
/// match is the newest.
pub fn find_marker_stash(text: &str, branch: &str) -> Option<String> {
    let marker = format!("{STASH_MARKER}{branch}");
    text.lines().find_map(|line| {
        let (reff, subject) = line.split_once('\0')?;
        subject
            .trim_end()
            .ends_with(&marker)
            .then(|| reff.to_string())
    })
}

/// Pick the remote that fetch/push should target: the upstream's remote, else
/// `origin`, else the only remote there is.
pub fn resolve_remote(upstream: Option<&str>, remotes: &[String]) -> Result<String, GitError> {
    if let Some(up) = upstream {
        let (remote, _) = split_remote(up, remotes);
        if !remote.is_empty() {
            return Ok(remote.to_string());
        }
    }
    if remotes.iter().any(|r| r == "origin") {
        return Ok("origin".to_string());
    }
    match remotes {
        [only] => Ok(only.clone()),
        [] => Err(GitError::Invalid(
            "this repository has no remote; add one with `git remote add origin <url>`".to_string(),
        )),
        many => Err(GitError::Invalid(format!(
            "this branch has no upstream and there are several remotes ({}); publish it to pick one",
            many.join(", ")
        ))),
    }
}

/// Reject a name git would read as an option or expand as a revision. Not all
/// git subcommands accept `--` before a branch name, so unusable names are
/// refused here instead of being passed through.
fn reject_unusable(name: &str) -> Result<(), GitError> {
    if name.is_empty() {
        return Err(GitError::Invalid("enter a branch name".to_string()));
    }
    if name.starts_with('-') {
        return Err(GitError::Invalid(
            "a branch name cannot start with '-'".to_string(),
        ));
    }
    // `check-ref-format --branch` *expands* @{-1} instead of rejecting it, so
    // it would report a name like this as valid.
    if name.contains("@{") {
        return Err(GitError::Invalid(
            "a branch name cannot contain '@{'".to_string(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Read the full branch state of the repo at `root`.
pub fn branch_state(root: &Path) -> Result<BranchState, GitError> {
    let remotes = list_remotes(root)?;
    let rows = read_refs(root)?;
    let (locals, remote_branches) = dedupe_remotes(&rows, &remotes);
    let head = read_head(root)?;

    // Taken from the raw row rather than the serialized LocalBranch, because the
    // full upstream ref is needed for verification and is not part of the
    // frontend's payload.
    let current_row = head.branch.as_deref().and_then(|branch| {
        let refname = format!("refs/heads/{branch}");
        rows.iter().find(|row| row.refname == refname)
    });
    let upstream = current_row.and_then(|row| row.upstream.clone());

    // An upstream whose ref has been deleted (the remote branch was removed and
    // the tracking ref pruned) still shows up in `%(upstream)`, since that comes
    // from config. `%(upstream:track)` would say `[gone]`, but that is prose, so
    // the ref is verified directly instead.
    let upstream_ref = current_row.and_then(|row| row.upstream_ref.clone());
    let upstream_gone = match upstream_ref.as_deref() {
        Some(reff) => !upstream_ref_exists(root, reff, &rows)?,
        None => false,
    };
    let upstream_on_remote = upstream_ref
        .as_deref()
        .is_some_and(|reff| reff.starts_with("refs/remotes/"));

    // Counting against a ref that does not exist would only fail; the flag above
    // is what the UI reports instead of a misleading 0/0.
    let (ahead, behind) = match upstream.as_deref() {
        Some(up) if !upstream_gone => count_ahead_behind(root, up)?,
        _ => (0, 0),
    };

    Ok(BranchState {
        current: head.branch,
        detached_sha: head.detached_sha,
        unborn: head.unborn,
        // A resolution failure here is a state, not an error: the UI shows
        // "no remote" rather than refusing to render the branch at all.
        remote: resolve_remote(upstream.as_deref(), &remotes).ok(),
        upstream,
        upstream_gone,
        upstream_on_remote,
        ahead,
        behind,
        last_fetch: last_fetch_time(root),
        locals,
        remotes: remote_branches,
    })
}

struct HeadInfo {
    branch: Option<String>,
    detached_sha: Option<String>,
    unborn: bool,
}

fn read_head(root: &Path) -> Result<HeadInfo, GitError> {
    // `-q` plus a non-zero exit is how symbolic-ref reports a detached HEAD;
    // that is a normal state, not a failure.
    let output = git_read_command(root)
        .args(["symbolic-ref", "--short", "-q", "HEAD"])
        .output()
        .map_err(map_io_err)?;
    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        // A fresh repo's HEAD still resolves symbolically (to a branch that
        // has no commit), so the name is real while nothing is committed yet.
        let unborn = head_short_sha(root)?.is_none();
        return Ok(HeadInfo {
            branch: Some(branch),
            detached_sha: None,
            unborn,
        });
    }
    Ok(HeadInfo {
        branch: None,
        detached_sha: head_short_sha(root)?,
        unborn: false,
    })
}

fn read_refs(root: &Path) -> Result<Vec<RefRow>, GitError> {
    let output = git_read_command(root)
        .args([
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={REF_FORMAT}"),
            "refs/heads",
            "refs/remotes",
        ])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    Ok(parse_for_each_ref(&output.stdout))
}

fn list_remotes(root: &Path) -> Result<Vec<String>, GitError> {
    let output = git_read_command(root)
        .arg("remote")
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

fn count_ahead_behind(root: &Path, upstream: &str) -> Result<(u32, u32), GitError> {
    let range = format!("{upstream}...HEAD");
    let output = git_read_command(root)
        .args(["rev-list", "--left-right", "--count", &range])
        .output()
        .map_err(map_io_err)?;
    // An upstream configured for a remote branch that has since been deleted
    // makes this fail. Reporting 0/0 beats failing the whole panel.
    if !output.status.success() {
        return Ok((0, 0));
    }
    Ok(parse_ahead_behind(&String::from_utf8_lossy(&output.stdout)).unwrap_or((0, 0)))
}

fn last_fetch_time(root: &Path) -> Option<u64> {
    let output = git_read_command(root)
        .args(["rev-parse", "--absolute-git-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let git_dir = PathBuf::from(
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string(),
    );
    // FETCH_HEAD is written by every fetch (including the one inside a pull)
    // and does not exist until the first one.
    let modified = std::fs::metadata(git_dir.join("FETCH_HEAD"))
        .and_then(|m| m.modified())
        .ok()?;
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// Switch to `target`, honouring `policy` for uncommitted changes and
/// restoring any changes previously left on the target branch.
///
/// The whole sequence is one call so it cannot interleave with a
/// watcher-driven read or a second operation (see `crate::gitops`).
pub fn switch(
    root: &Path,
    target: &SwitchTarget,
    policy: DirtyPolicy,
) -> Result<SwitchOutcome, GitError> {
    reject_unusable(&target.branch)?;
    if let Some(track) = target.track.as_deref() {
        reject_unusable(track)?;
    }

    let previous = read_head(root)?.branch;
    let mut outcome = SwitchOutcome {
        branch: target.branch.clone(),
        ..Default::default()
    };

    if policy == DirtyPolicy::Leave {
        if let Some(prev) = previous.as_deref() {
            if is_dirty(root)? {
                if find_stash(root, prev)?.is_some() {
                    outcome.warnings.push(format!(
                        "'{prev}' already had changes stashed by an earlier switch; that older stash stays in `git stash list`"
                    ));
                }
                stash_changes(root, prev)?;
                outcome.stashed_from = Some(prev.to_string());
            }
        }
    }

    if let Err(error) = run_switch(root, target) {
        // We may have just emptied the working tree for a switch that then did
        // not happen (the branch was deleted from another window, a hook
        // refused, a stale index.lock). Leaving the stash hidden would look
        // exactly like the user's changes had vanished, so put them back.
        if let Some(prev) = outcome.stashed_from.as_deref() {
            return Err(restore_after_failed_switch(root, prev, error));
        }
        return Err(error);
    }

    // Arrival: restore changes an earlier "leave my changes" left here.
    if let Some(stash_ref) = find_stash(root, &target.branch)? {
        match pop_stash(root, &stash_ref) {
            Ok(()) => outcome.restored = true,
            // A pop that conflicts leaves the stash intact, so nothing is lost
            // and the user can resolve it (or wait for Part 6).
            Err(GitError::CommandFailed(message)) => outcome.warnings.push(format!(
                "changes stashed for '{}' could not be restored and are still in `git stash list`: {message}",
                target.branch
            )),
            Err(other) => return Err(other),
        }
    }

    Ok(outcome)
}

/// Create `name` (optionally from `base`) and switch to it.
pub fn create(root: &Path, name: &str, base: Option<&str>) -> Result<(), GitError> {
    reject_unusable(name)?;
    let mut cmd = git_command(root);
    cmd.args(["switch", "-c", name]);
    if let Some(base) = base {
        reject_unusable(base)?;
        cmd.arg(base);
    }
    run_checked(cmd)
}

/// Delete a local branch. Without `force`, git refuses one whose commits are
/// not merged anywhere — that refusal is what the UI escalates on.
pub fn delete(root: &Path, name: &str, force: bool) -> Result<(), GitError> {
    reject_unusable(name)?;
    let mut cmd = git_command(root);
    cmd.args(["branch", if force { "-D" } else { "-d" }, "--", name]);
    run_checked(cmd)
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), GitError> {
    reject_unusable(from)?;
    reject_unusable(to)?;
    let mut cmd = git_command(root);
    cmd.args(["branch", "-m", "--", from, to]);
    run_checked(cmd)
}

/// `Ok(None)` when `name` is usable as a new branch, `Ok(Some(reason))` when it
/// is not. A rejected name is an expected answer, not an error.
pub fn validate_new_branch_name(root: &Path, name: &str) -> Result<Option<String>, GitError> {
    if let Err(GitError::Invalid(reason)) = reject_unusable(name) {
        return Ok(Some(reason));
    }
    let output = git_read_command(root)
        .args(["check-ref-format", "--branch", name])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        // Our own wording, not git's localized stderr.
        return Ok(Some(format!("'{name}' is not a valid branch name")));
    }
    if branch_exists(root, name)? {
        return Ok(Some(format!("a branch named '{name}' already exists")));
    }
    Ok(None)
}

/// Whether an upstream ref resolves, avoiding a process spawn where it can.
///
/// `rows` already lists every ref under `refs/heads` and `refs/remotes`, so a hit
/// there settles it for free — and this runs on every watcher-driven refresh, where
/// a spawn is not free on Windows. A *miss* proves nothing though: `rows` covers
/// only those two namespaces (a custom refspec can put tracking refs under
/// `refs/tracked/*`) and drops `refs/remotes/*/HEAD`, so the rare case falls back
/// to asking git rather than reporting a false "gone".
fn upstream_ref_exists(root: &Path, upstream_ref: &str, rows: &[RefRow]) -> Result<bool, GitError> {
    if rows.iter().any(|row| row.refname == upstream_ref) {
        return Ok(true);
    }
    ref_exists(root, upstream_ref)
}

/// Whether `refname` resolves. A missing ref is a normal answer here, not an
/// error, which is why `--quiet` plus the exit code is the whole test.
fn ref_exists(root: &Path, refname: &str) -> Result<bool, GitError> {
    let output = git_read_command(root)
        .args(["rev-parse", "--verify", "--quiet", refname])
        .output()
        .map_err(map_io_err)?;
    Ok(output.status.success())
}

fn branch_exists(root: &Path, name: &str) -> Result<bool, GitError> {
    ref_exists(root, &format!("refs/heads/{name}"))
}

/// Undo the `Leave` stash after the switch it was taken for failed, folding what
/// happened into the error the user will see.
///
/// The switch error is what they need to read first, so it leads; the stash note
/// is appended only when the work could *not* be put back, because that is the
/// case where they have to go and find it themselves.
fn restore_after_failed_switch(root: &Path, previous: &str, switch_error: GitError) -> GitError {
    let found = find_stash(root, previous);
    let restored = match &found {
        Ok(Some(stash_ref)) => pop_stash(root, stash_ref).is_ok(),
        // Nothing to put back, or we cannot even read the stash list.
        Ok(None) => true,
        Err(_) => false,
    };
    if restored {
        return switch_error;
    }
    GitError::CommandFailed(format!(
        "{switch_error}\n\nYour uncommitted changes were stashed as '{STASH_MARKER}{previous}' \
         before the switch failed, and could not be restored automatically. They are safe: \
         run `git stash list` to find them."
    ))
}

fn run_switch(root: &Path, target: &SwitchTarget) -> Result<(), GitError> {
    let mut cmd = git_command(root);
    match target.track.as_deref() {
        Some(remote_ref) => {
            cmd.args(["switch", "-c", &target.branch, "--track", remote_ref]);
        }
        None => {
            cmd.args(["switch", &target.branch]);
        }
    }
    run_checked(cmd)
}

fn is_dirty(root: &Path) -> Result<bool, GitError> {
    let status = crate::git::run_status(root)?;
    Ok(!status.staged.is_empty() || !status.unstaged.is_empty())
}

fn stash_changes(root: &Path, branch: &str) -> Result<(), GitError> {
    let message = format!("{STASH_MARKER}{branch}");
    let mut cmd = git_command(root);
    cmd.args(["stash", "push", "--include-untracked", "-m", &message]);
    run_checked(cmd)
}

fn find_stash(root: &Path, branch: &str) -> Result<Option<String>, GitError> {
    let output = git_read_command(root)
        .args(["stash", "list", "--format=%gd%x00%gs"])
        .output()
        .map_err(map_io_err)?;
    if !output.status.success() {
        return Err(GitError::CommandFailed(stderr_of(&output)));
    }
    Ok(find_marker_stash(
        &String::from_utf8_lossy(&output.stdout),
        branch,
    ))
}

/// `--index` so a restored stash keeps its staged/unstaged split; without it
/// everything that was staged would silently come back unstaged.
fn pop_stash(root: &Path, stash_ref: &str) -> Result<(), GitError> {
    let mut cmd: Command = git_command(root);
    cmd.args(["stash", "pop", "--index", stash_ref]);
    run_checked(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build `for-each-ref` output from (refname, short, upstream, date, sha).
    ///
    /// The full upstream ref is derived as `refs/remotes/<upstream>`, which is
    /// what git reports for an ordinary remote-tracking upstream. Tests that need
    /// a different one (a local-branch upstream) use [`refs_with_upstream_ref`].
    fn refs(rows: &[(&str, &str, &str, &str, &str)]) -> Vec<u8> {
        let mut out = String::new();
        for (refname, short, upstream, date, sha) in rows {
            let upstream_ref = if upstream.is_empty() {
                String::new()
            } else {
                format!("refs/remotes/{upstream}")
            };
            out.push_str(&format!(
                "{refname}\0{short}\0{upstream}\0{upstream_ref}\0{date}\0{sha}\n"
            ));
        }
        out.into_bytes()
    }

    /// As [`refs`], but with the full upstream ref given explicitly.
    fn refs_with_upstream_ref(
        refname: &str,
        short: &str,
        upstream: &str,
        upstream_ref: &str,
    ) -> Vec<u8> {
        format!("{refname}\0{short}\0{upstream}\0{upstream_ref}\0100\0abc1234\n").into_bytes()
    }

    fn origin() -> Vec<String> {
        vec!["origin".to_string()]
    }

    // --- parse_for_each_ref ------------------------------------------------

    #[test]
    fn empty_input_yields_no_rows() {
        assert!(parse_for_each_ref(&[]).is_empty());
        assert!(parse_for_each_ref(&refs(&[])).is_empty());
    }

    #[test]
    fn local_and_remote_rows_are_parsed() {
        let rows = parse_for_each_ref(&refs(&[
            (
                "refs/heads/main",
                "main",
                "origin/main",
                "1700000000",
                "abc1234",
            ),
            (
                "refs/remotes/origin/main",
                "origin/main",
                "",
                "1700000000",
                "abc1234",
            ),
        ]));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].short, "main");
        assert_eq!(rows[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(rows[0].committer_date, 1_700_000_000);
        assert_eq!(rows[0].head_short, "abc1234");
        assert_eq!(
            rows[0].upstream_ref.as_deref(),
            Some("refs/remotes/origin/main")
        );
        // Empty upstream fields must become None, not Some("").
        assert_eq!(rows[1].upstream, None);
        assert_eq!(rows[1].upstream_ref, None);
    }

    #[test]
    fn a_local_branch_upstream_keeps_its_own_full_ref() {
        // `git branch --track x main` sets branch.x.remote = "." and an upstream
        // under refs/heads, so the full ref cannot be assumed to live under
        // refs/remotes — which is why it is read rather than reconstructed.
        let rows = parse_for_each_ref(&refs_with_upstream_ref(
            "refs/heads/topic",
            "topic",
            "main",
            "refs/heads/main",
        ));
        assert_eq!(rows[0].upstream.as_deref(), Some("main"));
        assert_eq!(rows[0].upstream_ref.as_deref(), Some("refs/heads/main"));
    }

    #[test]
    fn symbolic_remote_head_row_is_dropped_by_full_refname() {
        // The trap: `refname:short` for this row is bare "origin", so filtering
        // on the short name would leave a phantom branch called "origin".
        let rows = parse_for_each_ref(&refs(&[
            (
                "refs/remotes/origin/HEAD",
                "origin",
                "",
                "1700000000",
                "abc1234",
            ),
            (
                "refs/remotes/origin/main",
                "origin/main",
                "",
                "1700000000",
                "abc1234",
            ),
        ]));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].short, "origin/main");
    }

    #[test]
    fn a_local_branch_called_head_is_kept() {
        // `git branch foo/HEAD` is legal, so the symbolic-ref filter must be
        // scoped to refs/remotes or such a branch would silently disappear from
        // the menu with no way to reach it.
        let rows = parse_for_each_ref(&refs(&[
            (
                "refs/heads/foo/HEAD",
                "foo/HEAD",
                "",
                "1700000000",
                "abc1234",
            ),
            (
                "refs/remotes/origin/HEAD",
                "origin",
                "",
                "1700000000",
                "abc1234",
            ),
        ]));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].short, "foo/HEAD");
    }

    #[test]
    fn nested_branch_names_survive() {
        let rows = parse_for_each_ref(&refs(&[(
            "refs/heads/feature/nested/deep",
            "feature/nested/deep",
            "",
            "1700000000",
            "abc1234",
        )]));
        assert_eq!(rows[0].short, "feature/nested/deep");
    }

    #[test]
    fn short_row_and_unparseable_date_degrade_without_panicking() {
        // A truncated record (too few fields) is skipped entirely.
        let mut bytes = b"refs/heads/main\0main\n".to_vec();
        // A non-numeric date falls back to 0 rather than dropping the branch.
        // Fields: refname, short, upstream, upstream ref, date, sha.
        bytes.extend_from_slice(b"refs/heads/other\0other\0\0\0nonsense\0abc1234\n");
        let rows = parse_for_each_ref(&bytes);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].short, "other");
        assert_eq!(rows[0].committer_date, 0);
    }

    #[test]
    fn non_utf8_ref_name_degrades_lossily() {
        // git reports ref names as raw bytes, so they need not be valid UTF-8.
        let mut bytes = b"refs/heads/caf".to_vec();
        bytes.push(0xFF);
        bytes.extend_from_slice(b"\0caf");
        bytes.push(0xFF);
        // Empty upstream and upstream ref, then the date — written in pieces
        // because "\0" next to a digit reads as an attempted octal escape.
        bytes.extend_from_slice(b"\0\0\0");
        bytes.extend_from_slice(b"1700000000\0abc1234\n");
        let rows = parse_for_each_ref(&bytes);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].short.contains('\u{FFFD}'));
        assert_eq!(rows[0].committer_date, 1_700_000_000);
    }

    // --- dedupe_remotes ---------------------------------------------------

    #[test]
    fn locals_and_remotes_are_split_and_local_counterparts_flagged() {
        let rows = parse_for_each_ref(&refs(&[
            ("refs/heads/main", "main", "origin/main", "3", "aaa"),
            ("refs/remotes/origin/main", "origin/main", "", "3", "aaa"),
            (
                "refs/remotes/origin/only-remote",
                "origin/only-remote",
                "",
                "2",
                "bbb",
            ),
        ]));
        let (locals, remotes) = dedupe_remotes(&rows, &origin());
        assert_eq!(locals.len(), 1);
        assert_eq!(locals[0].name, "main");
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].remote, "origin");
        assert_eq!(remotes[0].branch, "main");
        assert!(remotes[0].has_local, "origin/main mirrors local main");
        assert_eq!(remotes[1].branch, "only-remote");
        assert!(!remotes[1].has_local);
    }

    #[test]
    fn remote_split_prefers_the_longest_matching_remote_name() {
        // A remote called "origin/mirror" and a branch containing slashes: a
        // plain split_once('/') would call the remote "origin".
        let rows = parse_for_each_ref(&refs(&[(
            "refs/remotes/origin/mirror/feature/x",
            "origin/mirror/feature/x",
            "",
            "1",
            "aaa",
        )]));
        let remotes = vec!["origin".to_string(), "origin/mirror".to_string()];
        let (_, parsed) = dedupe_remotes(&rows, &remotes);
        assert_eq!(parsed[0].remote, "origin/mirror");
        assert_eq!(parsed[0].branch, "feature/x");
    }

    #[test]
    fn unknown_remote_falls_back_to_the_first_slash() {
        let rows = parse_for_each_ref(&refs(&[(
            "refs/remotes/upstream/main",
            "upstream/main",
            "",
            "1",
            "aaa",
        )]));
        let (_, parsed) = dedupe_remotes(&rows, &origin());
        assert_eq!(parsed[0].remote, "upstream");
        assert_eq!(parsed[0].branch, "main");
    }

    // --- parse_ahead_behind ------------------------------------------------

    #[test]
    fn left_is_behind_and_right_is_ahead() {
        // Verified against real git: upstream +3, local +1 prints "3\t1".
        assert_eq!(parse_ahead_behind("3\t1\n"), Some((1, 3)));
        // ...and the mirror image, so an inverted return cannot pass.
        assert_eq!(parse_ahead_behind("1\t3\n"), Some((3, 1)));
        assert_eq!(parse_ahead_behind("0\t0\n"), Some((0, 0)));
    }

    #[test]
    fn malformed_ahead_behind_is_rejected() {
        assert_eq!(parse_ahead_behind(""), None);
        assert_eq!(parse_ahead_behind("3\n"), None);
        assert_eq!(parse_ahead_behind("a\tb\n"), None);
        assert_eq!(parse_ahead_behind("-1\t2\n"), None);
        // A third number means we are not reading what we think we are.
        assert_eq!(parse_ahead_behind("1\t2\t3\n"), None);
    }

    // --- find_marker_stash -------------------------------------------------

    #[test]
    fn marker_stash_is_found_through_gits_on_branch_prefix() {
        let list = "stash@{0}\0On main: isabuild:main\n";
        assert_eq!(find_marker_stash(list, "main"), Some("stash@{0}".into()));
    }

    #[test]
    fn unrelated_and_hand_made_stashes_are_ignored() {
        let list = "stash@{0}\0WIP on main: abc1234 something\n\
                    stash@{1}\0On other: isabuild:other\n";
        assert_eq!(find_marker_stash(list, "main"), None);
        assert_eq!(find_marker_stash(list, "other"), Some("stash@{1}".into()));
        assert_eq!(find_marker_stash("", "main"), None);
    }

    #[test]
    fn newest_marker_stash_wins() {
        // `stash list` is newest-first, so the first match is the newest.
        let list = "stash@{0}\0On main: isabuild:main\n\
                    stash@{2}\0On main: isabuild:main\n";
        assert_eq!(find_marker_stash(list, "main"), Some("stash@{0}".into()));
    }

    #[test]
    fn marker_match_is_not_a_prefix_match_on_the_branch() {
        // "main" must not match a stash left for "maintenance".
        let list = "stash@{0}\0On maintenance: isabuild:maintenance\n";
        assert_eq!(find_marker_stash(list, "main"), None);
    }

    // --- resolve_remote ---------------------------------------------------

    #[test]
    fn upstream_remote_wins_over_origin() {
        let remotes = vec!["origin".to_string(), "upstream".to_string()];
        assert_eq!(
            resolve_remote(Some("upstream/main"), &remotes).unwrap(),
            "upstream"
        );
    }

    #[test]
    fn origin_is_the_fallback_then_a_sole_remote() {
        let two = vec!["origin".to_string(), "fork".to_string()];
        assert_eq!(resolve_remote(None, &two).unwrap(), "origin");
        let one = vec!["fork".to_string()];
        assert_eq!(resolve_remote(None, &one).unwrap(), "fork");
    }

    #[test]
    fn no_remote_and_ambiguous_remotes_are_actionable_errors() {
        let none: Vec<String> = vec![];
        let error = resolve_remote(None, &none).unwrap_err().to_string();
        assert!(error.contains("no remote"), "{error}");

        let many = vec!["a".to_string(), "b".to_string()];
        let error = resolve_remote(None, &many).unwrap_err().to_string();
        assert!(error.contains("several remotes"), "{error}");
    }

    // --- reject_unusable ---------------------------------------------------

    #[test]
    fn option_like_and_revision_like_names_are_refused() {
        assert!(reject_unusable("").is_err());
        assert!(reject_unusable("--force").is_err());
        assert!(reject_unusable("-x").is_err());
        // check-ref-format --branch would *expand* this rather than reject it.
        assert!(reject_unusable("@{-1}").is_err());
        assert!(reject_unusable("feature/ok").is_ok());
    }
}

/// Against real temp repositories: the flows whose behaviour lives in git
/// rather than in our parsing, so a fixture string could not prove them.
#[cfg(test)]
mod repo_tests {
    use super::*;
    use crate::testrepo::{
        commit_all, current_branch, empty_repo, git_in, porcelain, repo_with_bare_remote,
        repo_with_commit, stash_subjects, write,
    };

    fn local(branch: &str) -> SwitchTarget {
        SwitchTarget {
            branch: branch.to_string(),
            track: None,
        }
    }

    // --- reading -----------------------------------------------------------

    #[test]
    fn a_fresh_repo_reports_an_unborn_head_and_no_branches() {
        let dir = empty_repo();
        let state = branch_state(dir.path()).expect("state");
        // HEAD still resolves symbolically to a branch that has no commit yet.
        assert_eq!(state.current.as_deref(), Some("main"));
        assert!(state.unborn);
        assert_eq!(state.detached_sha, None);
        assert!(
            state.locals.is_empty(),
            "no ref exists until the first commit"
        );
        assert_eq!(state.remote, None);
        assert_eq!(state.last_fetch, None);
    }

    #[test]
    fn a_committed_repo_reports_its_branch_and_no_upstream() {
        let dir = repo_with_commit("file.txt", "one\n");
        let state = branch_state(dir.path()).expect("state");
        assert_eq!(state.current.as_deref(), Some("main"));
        assert!(!state.unborn);
        assert_eq!(state.upstream, None);
        assert_eq!((state.ahead, state.behind), (0, 0));
        assert_eq!(state.locals.len(), 1);
        assert_eq!(state.locals[0].name, "main");
        assert!(state.remotes.is_empty());
    }

    #[test]
    fn a_detached_head_reports_its_sha_and_no_branch() {
        let dir = repo_with_commit("file.txt", "one\n");
        git_in(dir.path(), &["checkout", "--quiet", "--detach", "HEAD"]);
        let state = branch_state(dir.path()).expect("state");
        assert_eq!(state.current, None);
        assert!(state.detached_sha.is_some());
        assert!(!state.unborn);
    }

    #[test]
    fn an_upstream_is_reported_with_ahead_and_behind_counts() {
        let dir = repo_with_bare_remote();
        let state = branch_state(dir.path()).expect("state");
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert_eq!(state.remote.as_deref(), Some("origin"));
        assert_eq!((state.ahead, state.behind), (0, 0));

        // One local commit puts us exactly one ahead, nothing behind.
        write(dir.path(), "file.txt", "two\n");
        commit_all(dir.path(), "local change");
        let state = branch_state(dir.path()).expect("state");
        assert_eq!((state.ahead, state.behind), (1, 0));
    }

    #[test]
    fn a_deleted_upstream_ref_is_reported_as_gone_not_as_in_sync() {
        let dir = repo_with_bare_remote();
        // Leave branch.main.merge pointing at a remote-tracking ref that is gone,
        // which is the state a prune leaves once the remote branch is deleted.
        git_in(
            dir.path(),
            &["update-ref", "-d", "refs/remotes/origin/main"],
        );
        let state = branch_state(dir.path()).expect("state must still be readable");
        // The upstream is still configured, so it is still reported...
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        // ...but it has to say the ref is gone, or `↑0 ↓0` reads as "in sync" for
        // a branch whose remote copy no longer exists.
        assert!(state.upstream_gone);
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn a_healthy_upstream_is_not_reported_as_gone() {
        let dir = repo_with_bare_remote();
        let state = branch_state(dir.path()).expect("state");
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert!(!state.upstream_gone);
        assert!(state.upstream_on_remote);
    }

    #[test]
    fn a_local_branch_upstream_is_detected_but_not_called_a_remote_one() {
        // `--track` against a local branch is a valid, if unusual, setup. Telling
        // the user a missing *local* branch "no longer exists on the remote", and
        // offering to push to recreate it, would be wrong on both counts.
        let dir = repo_with_commit("file.txt", "one\n");
        git_in(dir.path(), &["branch", "--track", "topic", "main"]);
        git_in(dir.path(), &["switch", "--quiet", "topic"]);

        let state = branch_state(dir.path()).expect("state");
        assert_eq!(state.upstream.as_deref(), Some("main"));
        assert!(!state.upstream_on_remote, "the upstream is a local branch");
        assert!(!state.upstream_gone, "and it still exists");

        // Now delete what it tracked: gone, but still not a remote upstream.
        git_in(dir.path(), &["branch", "-D", "main"]);
        let state = branch_state(dir.path()).expect("state");
        assert!(state.upstream_gone);
        assert!(!state.upstream_on_remote);
    }

    #[test]
    fn a_branch_with_no_upstream_is_not_reported_as_gone() {
        let dir = repo_with_commit("file.txt", "one\n");
        let state = branch_state(dir.path()).expect("state");
        assert_eq!(state.upstream, None);
        assert!(
            !state.upstream_gone,
            "having no upstream is not the same as having a missing one"
        );
    }

    #[test]
    fn the_symbolic_remote_head_never_appears_as_a_branch() {
        let dir = repo_with_bare_remote();
        git_in(
            dir.path(),
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        let state = branch_state(dir.path()).expect("state");
        assert!(
            state.remotes.iter().all(|r| r.name != "origin"),
            "origin/HEAD leaked in as a branch: {:?}",
            state.remotes.iter().map(|r| &r.name).collect::<Vec<_>>()
        );
        assert!(state.remotes.iter().any(|r| r.name == "origin/main"));
    }

    // --- create / rename / delete -----------------------------------------

    #[test]
    fn create_makes_a_branch_and_switches_to_it() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature/x", None).expect("create");
        assert_eq!(current_branch(dir.path()), "feature/x");
    }

    #[test]
    fn create_from_an_explicit_base_starts_there() {
        let dir = repo_with_commit("file.txt", "one\n");
        let first = crate::git::head_short_sha(dir.path()).unwrap().unwrap();
        write(dir.path(), "file.txt", "two\n");
        commit_all(dir.path(), "second");

        create(dir.path(), "from-first", Some(&first)).expect("create from base");
        assert_eq!(current_branch(dir.path()), "from-first");
        // Started at the first commit, so the second commit's content is gone.
        assert_eq!(crate::testrepo::read(dir.path(), "file.txt"), "one\n");
    }

    #[test]
    fn create_refuses_a_duplicate_and_an_unusable_name() {
        let dir = repo_with_commit("file.txt", "one\n");
        assert!(create(dir.path(), "main", None).is_err(), "already exists");
        assert!(create(dir.path(), "--force", None).is_err());
        assert!(create(dir.path(), "bad name", None).is_err());
    }

    #[test]
    fn rename_moves_the_current_branch() {
        let dir = repo_with_commit("file.txt", "one\n");
        rename(dir.path(), "main", "trunk").expect("rename");
        assert_eq!(current_branch(dir.path()), "trunk");
    }

    #[test]
    fn delete_refuses_unmerged_commits_until_forced() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "doomed", None).expect("create");
        write(dir.path(), "extra.txt", "unmerged\n");
        commit_all(dir.path(), "only on doomed");
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("back to main");

        let refused =
            delete(dir.path(), "doomed", false).expect_err("git must refuse an unmerged branch");
        assert!(matches!(refused, GitError::CommandFailed(_)));
        delete(dir.path(), "doomed", true).expect("force delete");
        let state = branch_state(dir.path()).expect("state");
        assert!(state.locals.iter().all(|l| l.name != "doomed"));
    }

    // --- validation --------------------------------------------------------

    #[test]
    fn validation_accepts_a_usable_name_and_explains_every_rejection() {
        let dir = repo_with_commit("file.txt", "one\n");
        let ok = validate_new_branch_name(dir.path(), "feature/ok").expect("validate");
        assert_eq!(ok, None);

        let existing = validate_new_branch_name(dir.path(), "main").expect("validate");
        assert!(existing.unwrap().contains("already exists"));

        let malformed = validate_new_branch_name(dir.path(), "bad name").expect("validate");
        assert!(malformed.unwrap().contains("not a valid branch name"));

        let empty = validate_new_branch_name(dir.path(), "").expect("validate");
        assert!(empty.unwrap().contains("enter a branch name"));

        let option_like = validate_new_branch_name(dir.path(), "-x").expect("validate");
        assert!(option_like.unwrap().contains("cannot start with"));

        // Would be *expanded* by check-ref-format --branch, not rejected.
        let revision = validate_new_branch_name(dir.path(), "@{-1}").expect("validate");
        assert!(revision.unwrap().contains("@{"));
    }

    // --- switching with a dirty tree --------------------------------------

    #[test]
    fn bring_carries_uncommitted_changes_across() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature", None).expect("create");
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");
        write(dir.path(), "file.txt", "edited\n");

        let outcome = switch(dir.path(), &local("feature"), DirtyPolicy::Bring).expect("switch");
        assert_eq!(current_branch(dir.path()), "feature");
        assert_eq!(outcome.stashed_from, None, "bring must not stash");
        assert!(!outcome.restored);
        // The edit came along.
        assert_eq!(crate::testrepo::read(dir.path(), "file.txt"), "edited\n");
    }

    #[test]
    fn bring_surfaces_gits_refusal_when_changes_would_be_overwritten() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature", None).expect("create");
        write(dir.path(), "file.txt", "on feature\n");
        commit_all(dir.path(), "diverge the file");
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");
        // Now edit the same file on main: git cannot carry this across.
        write(dir.path(), "file.txt", "local edit\n");

        let error =
            switch(dir.path(), &local("feature"), DirtyPolicy::Bring).expect_err("git must refuse");
        assert!(matches!(error, GitError::CommandFailed(_)));
        // Nothing was lost and we are still where we were.
        assert_eq!(current_branch(dir.path()), "main");
        assert_eq!(
            crate::testrepo::read(dir.path(), "file.txt"),
            "local edit\n"
        );
    }

    #[test]
    fn leave_stashes_the_changes_under_a_marker_for_that_branch() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature", None).expect("create");
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");
        write(dir.path(), "file.txt", "left behind\n");
        write(dir.path(), "untracked.txt", "also left\n");

        let outcome = switch(dir.path(), &local("feature"), DirtyPolicy::Leave).expect("switch");
        assert_eq!(outcome.stashed_from.as_deref(), Some("main"));
        assert_eq!(current_branch(dir.path()), "feature");
        assert_eq!(stash_subjects(dir.path()), ["On main: isabuild:main"]);
        // Including the untracked file, and the tree is clean here.
        assert!(!dir.path().join("untracked.txt").exists());
        assert!(porcelain(dir.path()).is_empty());
    }

    #[test]
    fn returning_to_a_branch_restores_its_stash_with_staging_intact() {
        let dir = repo_with_commit("file.txt", "one\n");
        crate::testrepo::write(dir.path(), "staged.txt", "staged\n");
        git_in(dir.path(), &["add", "staged.txt"]);
        write(dir.path(), "file.txt", "unstaged edit\n");
        create(dir.path(), "feature", None).expect("create");
        // Land back on main so the stash is taken from there.
        let left = switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");
        assert_eq!(left.stashed_from, None);

        let before = porcelain(dir.path());
        assert!(
            before.iter().any(|l| l.starts_with("A ")),
            "expected a staged add, got {before:?}"
        );

        switch(dir.path(), &local("feature"), DirtyPolicy::Leave).expect("leave changes");
        assert!(porcelain(dir.path()).is_empty(), "stashed away");

        let back = switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("return");
        assert!(back.restored, "the marker stash must be popped on return");
        assert!(back.warnings.is_empty(), "{:?}", back.warnings);
        assert!(stash_subjects(dir.path()).is_empty(), "stash was consumed");
        // The whole point of `pop --index`: staged stays staged.
        assert_eq!(
            porcelain(dir.path()),
            before,
            "the staged/unstaged split must survive the round trip"
        );
    }

    #[test]
    fn a_hand_made_stash_is_never_restored_by_a_switch() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature", None).expect("create");
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");
        write(dir.path(), "file.txt", "mine\n");
        // The user's own stash, with no marker.
        git_in(dir.path(), &["stash", "push", "--quiet", "-m", "my work"]);

        let outcome = switch(dir.path(), &local("feature"), DirtyPolicy::Bring).expect("switch");
        assert!(!outcome.restored);
        let back = switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("return");
        assert!(!back.restored, "an unmarked stash is the user's business");
        assert_eq!(stash_subjects(dir.path()).len(), 1);
    }

    #[test]
    fn leaving_twice_warns_that_the_older_stash_stays_behind() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature", None).expect("create");
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");

        write(dir.path(), "file.txt", "first\n");
        switch(dir.path(), &local("feature"), DirtyPolicy::Leave).expect("leave once");
        // Back to main *without* restoring (bring finds and pops it), so make a
        // second stash from a fresh edit on main.
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        write(dir.path(), "file.txt", "second\n");

        let outcome =
            switch(dir.path(), &local("feature"), DirtyPolicy::Leave).expect("leave twice");
        assert_eq!(outcome.stashed_from.as_deref(), Some("main"));
        assert_eq!(outcome.warnings.len(), 1, "{:?}", outcome.warnings);
        assert!(outcome.warnings[0].contains("already had changes stashed"));
        assert_eq!(stash_subjects(dir.path()).len(), 2);
    }

    #[test]
    fn leave_with_a_clean_tree_stashes_nothing() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature", None).expect("create");
        let outcome = switch(dir.path(), &local("main"), DirtyPolicy::Leave).expect("switch");
        assert_eq!(outcome.stashed_from, None);
        assert!(stash_subjects(dir.path()).is_empty());
    }

    #[test]
    fn a_failed_switch_puts_leave_stashed_changes_straight_back() {
        let dir = repo_with_commit("file.txt", "one\n");
        write(dir.path(), "file.txt", "work in progress\n");

        // Target a branch that does not exist, so the switch fails *after* the
        // stash has been taken.
        let error = switch(dir.path(), &local("no-such-branch"), DirtyPolicy::Leave)
            .expect_err("switching to a missing branch must fail");
        assert!(matches!(error, GitError::CommandFailed(_)));

        // The user is still on main, with their work visible — not silently
        // stashed away by a switch that never happened.
        assert_eq!(current_branch(dir.path()), "main");
        assert_eq!(
            crate::testrepo::read(dir.path(), "file.txt"),
            "work in progress\n"
        );
        assert!(
            stash_subjects(dir.path()).is_empty(),
            "the rolled-back stash must not linger"
        );
    }

    #[test]
    fn a_stash_that_cannot_be_restored_is_reported_and_kept() {
        let dir = repo_with_commit("file.txt", "one\n");
        create(dir.path(), "feature", None).expect("create");
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");

        // Stash an edit to file.txt away from main...
        write(dir.path(), "file.txt", "stashed edit\n");
        switch(dir.path(), &local("feature"), DirtyPolicy::Leave).expect("leave");
        // ...then commit a conflicting change to the same file on main, so the
        // pop on return cannot apply.
        git_in(dir.path(), &["switch", "--quiet", "main"]);
        write(dir.path(), "file.txt", "committed elsewhere\n");
        commit_all(dir.path(), "conflicting commit");
        git_in(dir.path(), &["switch", "--quiet", "feature"]);

        let back =
            switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch still works");
        assert!(!back.restored);
        assert_eq!(back.warnings.len(), 1, "{:?}", back.warnings);
        assert!(back.warnings[0].contains("could not be restored"));
        // Nothing lost: the stash is still there to recover by hand.
        assert_eq!(stash_subjects(dir.path()).len(), 1);
    }

    // --- checking out a remote branch -------------------------------------

    #[test]
    fn a_remote_only_branch_becomes_a_local_tracking_branch() {
        let dir = repo_with_bare_remote();
        // Publish a branch, then drop the local copy so only the remote one is
        // left — exactly what a colleague's branch looks like after a fetch.
        create(dir.path(), "colleague", None).expect("create");
        git_in(dir.path(), &["push", "--quiet", "origin", "colleague"]);
        switch(dir.path(), &local("main"), DirtyPolicy::Bring).expect("switch");
        delete(dir.path(), "colleague", true).expect("drop local copy");

        let state = branch_state(dir.path()).expect("state");
        let remote_row = state
            .remotes
            .iter()
            .find(|r| r.branch == "colleague")
            .expect("remote branch listed");
        assert!(!remote_row.has_local);

        switch(
            dir.path(),
            &SwitchTarget {
                branch: "colleague".to_string(),
                track: Some("origin/colleague".to_string()),
            },
            DirtyPolicy::Bring,
        )
        .expect("track the remote branch");

        assert_eq!(current_branch(dir.path()), "colleague");
        let state = branch_state(dir.path()).expect("state");
        assert_eq!(state.upstream.as_deref(), Some("origin/colleague"));
        assert!(
            state
                .remotes
                .iter()
                .find(|r| r.branch == "colleague")
                .expect("still listed")
                .has_local,
            "now mirrored by a local branch"
        );
    }
}
