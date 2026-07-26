//! Per-file git actions for the status panel's context menu: stage, unstage,
//! roll back and commit one path.
//!
//! Every function takes the path git reported plus the rename/copy origin when
//! there is one, and passes **both** to git as pathspecs. A staged rename is one
//! row in the panel and two paths in the index; acting on only one of them would
//! leave the other half of the rename behind.
//!
//! Two properties of `git status` shape the whole module. It runs without a `-u`
//! flag, so git's default `--untracked-files=normal` collapses an untracked
//! directory into a single `dir/` record — a "file" here can be a whole subtree.
//! And a path's staged and unstaged states are separate records, so the same
//! path can be the target of an action from either group.

use std::path::Path;

use serde::Serialize;

use crate::git::{
    git_literal_command, git_read_command, head_short_sha, reject_unusable_path, run_checked,
    GitError,
};

/// What a commit produced, for the status-bar notice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    /// Short sha of the new commit. `None` only if HEAD cannot be read back,
    /// which a successful commit makes very unlikely — the notice just omits it.
    pub sha: Option<String>,
}

/// `git add -- <paths>`.
pub fn stage(root: &Path, path: &str, orig: Option<&str>) -> Result<(), GitError> {
    let paths = pathspecs(path, orig)?;
    run_checked(git_literal_command(root).args(["add", "--"]).args(&paths))
}

/// Drop the index entry for `path`, leaving the working tree alone.
///
/// Two commands because `reset` resolves HEAD and an unborn HEAD has none: in a
/// repository with no commits there is no revision to reset the entry *to*, and
/// removing it from the index is the whole operation.
pub fn unstage(root: &Path, path: &str, orig: Option<&str>) -> Result<(), GitError> {
    let paths = pathspecs(path, orig)?;
    if head_short_sha(root)?.is_some() {
        run_checked(
            git_literal_command(root)
                .args(["reset", "--quiet", "HEAD", "--"])
                .args(&paths),
        )
    } else {
        // -r because the path may be a directory; --cached so the file itself
        // survives, which is the difference between unstaging and rolling back.
        run_checked(
            git_literal_command(root)
                .args(["rm", "--cached", "-r", "--quiet", "--"])
                .args(&paths),
        )
    }
}

/// Make the index and working tree agree with HEAD for this path.
///
/// One rule, applied per pathspec: **is it in HEAD?** If it is, HEAD's version
/// is restored; if it is not, then agreeing with HEAD means it should not exist,
/// so the index entry goes and the file is deleted. That covers every row the
/// panel can show without a case for each — a modification, a staged deletion, a
/// staged brand-new file, an untracked file, an untracked directory, a rename
/// (the origin is in HEAD and comes back, the new path is not and goes), and a
/// repository with no commits at all (nothing is in HEAD, so everything goes).
///
/// Destructive and unrecoverable by design: nothing here is in git's object
/// database, so the caller confirms first.
pub fn rollback(root: &Path, path: &str, orig: Option<&str>) -> Result<(), GitError> {
    let paths = pathspecs(path, orig)?;
    let (in_head, absent): (Vec<&String>, Vec<&String>) =
        paths.iter().partition(|p| is_in_head(root, p));

    if !in_head.is_empty() {
        // `checkout HEAD --` rewrites the index entry *and* the working tree,
        // which is what makes this one command rather than a reset plus a
        // restore. It also resolves a conflicted path, by taking our side.
        run_checked(
            git_literal_command(root)
                .args(["checkout", "HEAD", "--"])
                .args(in_head),
        )?;
    }
    for path in absent {
        // --ignore-unmatch: an untracked path has no index entry to remove, and
        // that is not a failure. -r for a collapsed directory.
        run_checked(git_literal_command(root).args([
            "rm",
            "--cached",
            "-r",
            "--quiet",
            "--ignore-unmatch",
            "--",
            path,
        ]))?;
        // Untracked by now, whether it started that way or was just unstaged, so
        // clean can see it. -d for a directory; never -x, which would also
        // delete ignored files the user never asked about, and never -ff, which
        // is what git demands before it will remove a nested repository — that
        // guard is right, since a checkout down there could hold commits that
        // exist nowhere else.
        run_checked(git_literal_command(root).args(["clean", "--quiet", "-f", "-d", "--", path]))?;
        // `clean` exits 0 when it declined to remove a nested repository, so
        // success is not proof the path is gone. Saying so beats leaving a
        // half-deleted subtree, a row that will not go away, and no error.
        if root.join(path).exists() {
            return Err(GitError::Invalid(format!(
                "git left part of '{path}' in place, most likely a checkout of \
                 another repository inside it. Remove it by hand if you meant to."
            )));
        }
    }
    Ok(())
}

/// Commit this path alone: `git commit -m <message> -- <paths>`.
///
/// git builds a temporary index from HEAD plus these paths, so anything else
/// staged stays staged. Two consequences worth knowing, both git's own and both
/// surfaced in the UI rather than worked around here: it commits the path as it
/// is in the **working tree**, not the version in the index, and git refuses it
/// outright during a merge.
///
/// A path git has never heard of is staged first. `git commit -- <pathspec>`
/// matches against the index, so on a brand-new file it fails with "did not match
/// any file(s) known to git" — which would make committing a new file, the most
/// obvious thing to want, the one thing this could not do.
///
/// Hooks are deliberately not bypassed. A `pre-commit` that fails is a real
/// failure, and its output reaches the user through [`GitError::CommandFailed`].
pub fn commit_path(
    root: &Path,
    path: &str,
    orig: Option<&str>,
    message: &str,
) -> Result<CommitOutcome, GitError> {
    if message.trim().is_empty() {
        return Err(GitError::Invalid("a commit needs a message".to_string()));
    }
    let paths = pathspecs(path, orig)?;
    // "Known to git" for a partial commit means the index *or* HEAD, because that
    // is what git builds its temporary index from. Both halves matter: a rename's
    // origin is gone from the index but present in HEAD, and `git add` on it would
    // fail outright.
    for path in paths
        .iter()
        .filter(|p| !is_in_index(root, p) && !is_in_head(root, p))
    {
        run_checked(git_literal_command(root).args(["add", "--", path]))?;
    }
    // -m means git never opens an editor, so there is no GIT_EDITOR to neutralise.
    run_checked(
        git_literal_command(root)
            .args(["commit", "--quiet", "-m", message, "--"])
            .args(&paths),
    )?;
    Ok(CommitOutcome {
        sha: head_short_sha(root)?,
    })
}

/// The pathspecs for one row: the path, plus the rename/copy origin when there
/// is one. Both are checked before any command runs.
fn pathspecs(path: &str, orig: Option<&str>) -> Result<Vec<String>, GitError> {
    reject_unusable_path(path)?;
    let mut paths = vec![path.to_string()];
    if let Some(orig) = orig {
        reject_unusable_path(orig)?;
        if orig != path {
            paths.push(orig.to_string());
        }
    }
    Ok(paths)
}

/// Whether HEAD has an entry at exactly this path. False for an unborn HEAD,
/// which has nothing.
fn is_in_head(root: &Path, path: &str) -> bool {
    has_entry(root, "HEAD", path)
}

/// Whether the index has an entry at exactly this path — the state that decides
/// whether `git commit -- <path>` can see it at all.
fn is_in_index(root: &Path, path: &str) -> bool {
    has_entry(root, "", path)
}

/// Whether `<revision>:<path>` names an entry git holds: `HEAD:x` for the last
/// commit, `:x` for the index.
///
/// An object *name* rather than a pathspec, deliberately: `HEAD:x` means exactly
/// the bytes in `x`, where a pathspec would glob (see
/// [`crate::git::git_literal_command`]).
///
/// `cat-file -t` rather than `-e`, and the type is the point. A directory in HEAD
/// is a tree, and a tree is an object, so a mere existence check answers "yes" for
/// `HEAD:dir/` — which would send a collapsed untracked-directory row down
/// `rollback`'s restore branch and overwrite the user's untracked files with
/// committed ones. Only a non-tree (a blob, or a `commit` for a submodule) is an
/// entry a checkout would restore.
///
/// The type name is plumbing output from a fixed vocabulary, not the localized
/// prose this module refuses to parse.
fn has_entry(root: &Path, revision: &str, path: &str) -> bool {
    let output = git_read_command(root)
        .args(["cat-file", "-t", &format!("{revision}:{path}")])
        .output();
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim() != "tree",
        _ => false,
    }
}

/// End to end against real repositories, like `merge`'s: no fixtures pretending
/// to be git, because what is being tested is what git does.
#[cfg(test)]
mod repo_tests {
    use super::*;
    use crate::git;
    use crate::testrepo::{
        commit_all, empty_repo, git_in, porcelain, read, repo_with_commit,
        repo_with_conflicting_branches, write,
    };

    fn status(dir: &Path) -> git::GitStatus {
        git::status_from(dir).expect("status")
    }

    fn paths(entries: &[git::FileEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.path.as_str()).collect()
    }

    /// The repository has nothing left to report: the action finished the whole
    /// job rather than half of it.
    fn assert_clean(dir: &Path) {
        let lines = porcelain(dir);
        assert!(lines.is_empty(), "expected a clean tree, got {lines:?}");
    }

    #[test]
    fn stage_moves_a_change_from_unstaged_to_staged() {
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "app.ts", "two\n");

        stage(dir.path(), "app.ts", None).expect("stage");

        let after = status(dir.path());
        assert_eq!(paths(&after.staged), vec!["app.ts"]);
        assert!(after.unstaged.is_empty(), "{:?}", after.unstaged);
    }

    #[test]
    fn unstage_moves_it_back_and_keeps_the_file() {
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "app.ts", "two\n");
        git_in(dir.path(), &["add", "app.ts"]);

        unstage(dir.path(), "app.ts", None).expect("unstage");

        let after = status(dir.path());
        assert!(after.staged.is_empty(), "{:?}", after.staged);
        assert_eq!(paths(&after.unstaged), vec!["app.ts"]);
        assert_eq!(read(dir.path(), "app.ts"), "two\n");
    }

    #[test]
    fn unstage_works_in_a_repository_with_no_commits() {
        // The reset branch cannot run here: there is no HEAD to reset the index
        // entry to. This is the case that makes `unstage` two commands.
        let dir = empty_repo();
        write(dir.path(), "app.ts", "one\n");
        git_in(dir.path(), &["add", "app.ts"]);
        assert_eq!(paths(&status(dir.path()).staged), vec!["app.ts"]);

        unstage(dir.path(), "app.ts", None).expect("unstage on an unborn HEAD");

        let after = status(dir.path());
        assert!(after.staged.is_empty(), "{:?}", after.staged);
        assert_eq!(paths(&after.unstaged), vec!["app.ts"]);
        assert_eq!(read(dir.path(), "app.ts"), "one\n");
    }

    #[test]
    fn rollback_restores_a_modified_file_from_head() {
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "app.ts", "two\n");

        rollback(dir.path(), "app.ts", None).expect("rollback");

        assert_eq!(read(dir.path(), "app.ts"), "one\n");
        assert_clean(dir.path());
    }

    #[test]
    fn rollback_restores_a_file_deleted_from_the_index_and_the_disk() {
        let dir = repo_with_commit("app.ts", "one\n");
        git_in(dir.path(), &["rm", "--quiet", "app.ts"]);
        assert!(!dir.path().join("app.ts").exists());

        rollback(dir.path(), "app.ts", None).expect("rollback");

        assert_eq!(read(dir.path(), "app.ts"), "one\n");
        assert_clean(dir.path());
    }

    #[test]
    fn rollback_deletes_an_untracked_file() {
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "notes.md", "scratch\n");

        rollback(dir.path(), "notes.md", None).expect("rollback");

        assert!(!dir.path().join("notes.md").exists());
        assert_clean(dir.path());
    }

    #[test]
    fn rollback_deletes_an_untracked_directory_and_its_contents() {
        // `git status` collapses an untracked directory into one `generated/`
        // record, so this is a real row in the panel and the path it hands back
        // has a trailing slash.
        let dir = repo_with_commit("app.ts", "one\n");
        std::fs::create_dir(dir.path().join("generated")).expect("mkdir");
        write(dir.path(), "generated/a.ts", "a\n");
        write(dir.path(), "generated/b.ts", "b\n");
        let untracked = status(dir.path());
        assert_eq!(paths(&untracked.unstaged), vec!["generated/"]);

        rollback(dir.path(), "generated/", None).expect("rollback");

        assert!(!dir.path().join("generated").exists());
        assert_clean(dir.path());
    }

    #[test]
    fn rollback_of_a_staged_new_file_unstages_it_and_deletes_it() {
        // Not in HEAD, so "look like HEAD" means the file should not exist.
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "new.ts", "fresh\n");
        git_in(dir.path(), &["add", "new.ts"]);

        rollback(dir.path(), "new.ts", None).expect("rollback");

        assert!(!dir.path().join("new.ts").exists());
        assert_clean(dir.path());
    }

    #[test]
    fn rollback_of_a_staged_rename_restores_the_origin_and_removes_the_new_path() {
        let dir = repo_with_commit("old.ts", "content\n");
        git_in(dir.path(), &["mv", "old.ts", "new.ts"]);
        let renamed = status(dir.path());
        assert_eq!(paths(&renamed.staged), vec!["new.ts"]);
        assert_eq!(renamed.staged[0].orig_path.as_deref(), Some("old.ts"));

        rollback(dir.path(), "new.ts", Some("old.ts")).expect("rollback");

        assert_eq!(read(dir.path(), "old.ts"), "content\n");
        assert!(!dir.path().join("new.ts").exists());
        assert_clean(dir.path());
    }

    #[test]
    fn rollback_in_a_repository_with_no_commits_removes_the_file() {
        // Nothing is in an unborn HEAD, so every path takes the delete branch.
        let dir = empty_repo();
        write(dir.path(), "app.ts", "one\n");
        git_in(dir.path(), &["add", "app.ts"]);

        rollback(dir.path(), "app.ts", None).expect("rollback on an unborn HEAD");

        assert!(!dir.path().join("app.ts").exists());
        assert_clean(dir.path());
    }

    #[test]
    fn rollback_of_a_conflicted_path_resolves_it_to_our_last_commit() {
        let dir = repo_with_conflicting_branches();
        let outcome = crate::merge::merge(dir.path(), "feature").expect("merge");
        assert!(outcome.conflicted, "output was: {}", outcome.output);
        let conflicted = status(dir.path());
        assert_eq!(conflicted.conflicts.len(), 1, "{:?}", conflicted.conflicts);
        let path = conflicted.conflicts[0].path.clone();
        let ours = git_in_output(dir.path(), &["show", &format!("HEAD:{path}")]);

        rollback(dir.path(), &path, None).expect("rollback a conflicted path");

        let after = status(dir.path());
        assert!(after.conflicts.is_empty(), "{:?}", after.conflicts);
        assert_eq!(read(dir.path(), &path), ours);
    }

    /// stdout of a git command that is expected to succeed.
    fn git_in_output(dir: &Path, args: &[&str]) -> String {
        let out = crate::testrepo::git_raw(dir, args);
        assert!(out.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn commit_records_only_its_own_path_and_returns_the_sha() {
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "app.ts", "two\n");
        write(dir.path(), "other.ts", "other\n");
        git_in(dir.path(), &["add", "other.ts"]);

        let outcome = commit_path(dir.path(), "app.ts", None, "change app").expect("commit");

        assert_eq!(
            outcome.sha.as_deref(),
            Some(head_short(dir.path()).as_str())
        );
        assert_eq!(committed_paths(dir.path()), vec!["app.ts"]);
        assert_eq!(head_subject(dir.path()), "change app");
        // The other staged file is untouched: a pathspec commit builds its own
        // temporary index and leaves the real one alone.
        assert_eq!(paths(&status(dir.path()).staged), vec!["other.ts"]);
    }

    #[test]
    fn commit_of_a_rename_records_it_as_a_rename() {
        let dir = repo_with_commit("old.ts", "content\n");
        git_in(dir.path(), &["mv", "old.ts", "new.ts"]);

        commit_path(dir.path(), "new.ts", Some("old.ts"), "rename it").expect("commit");

        // Both halves reached git, so it is one rename rather than an add with
        // the origin's deletion left behind. A clean tree afterwards is the
        // proof: passing only `new.ts` would leave old.ts's deletion staged.
        let status = git_in_output(dir.path(), &["show", "--name-status", "--format=", "HEAD"]);
        assert!(
            status.starts_with('R'),
            "not recorded as a rename: {status}"
        );
        assert!(
            status.contains("old.ts") && status.contains("new.ts"),
            "{status}"
        );
        assert_clean(dir.path());
    }

    #[test]
    fn commit_works_in_a_repository_with_no_commits() {
        let dir = empty_repo();
        write(dir.path(), "app.ts", "one\n");
        git_in(dir.path(), &["add", "app.ts"]);

        let outcome = commit_path(dir.path(), "app.ts", None, "first").expect("first commit");

        assert!(outcome.sha.is_some());
        assert_eq!(head_subject(dir.path()), "first");
    }

    #[test]
    fn a_blank_message_is_refused_before_git_runs() {
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "app.ts", "two\n");

        let error = commit_path(dir.path(), "app.ts", None, "   \n").expect_err("blank message");

        assert!(matches!(error, GitError::Invalid(_)), "{error:?}");
        // Nothing ran, so the change is still there to commit properly.
        assert_eq!(paths(&status(dir.path()).unstaged), vec!["app.ts"]);
    }

    #[test]
    fn a_commit_during_a_merge_fails_with_gits_own_refusal() {
        // git forbids a pathspec commit mid-merge. The UI disables the item, but
        // the backend must not paper over it either: the message is git's.
        let dir = repo_with_conflicting_branches();
        crate::merge::merge(dir.path(), "feature").expect("merge");

        let error = commit_path(dir.path(), "file.txt", None, "half a merge")
            .expect_err("a partial commit during a merge");

        let message = error.to_string();
        assert!(message.contains("merge"), "unexpected message: {message}");
    }

    #[test]
    fn a_row_named_like_a_glob_touches_only_itself() {
        // `*`, `?` and `[...]` are legal filenames and git reports them verbatim,
        // but a pathspec is a glob — so without GIT_LITERAL_PATHSPECS, rolling
        // back a row named `[ab]` would run `git clean -f -d -- '[ab]'` and delete
        // `a` as well, uncommitted edit and all. A row named `*` would take the
        // whole working tree.
        let dir = repo_with_commit("a", "committed\n");
        write(dir.path(), "a", "edited\n");
        write(dir.path(), "[ab]", "unrelated\n");
        write(dir.path(), "*", "also unrelated\n");

        rollback(dir.path(), "[ab]", None).expect("rollback");

        assert!(!dir.path().join("[ab]").exists(), "the row itself is gone");
        assert_eq!(
            read(dir.path(), "a"),
            "edited\n",
            "an unrelated file was hit"
        );
        assert!(dir.path().join("*").exists(), "an unrelated file was hit");
    }

    #[test]
    fn an_untracked_directory_sharing_a_name_with_head_is_still_deleted() {
        // The path is a *tree* in HEAD, not a blob, so an existence check would
        // say "HEAD has it" and restore HEAD's committed file over the user's
        // untracked one — the opposite of what the confirmation promised.
        let dir = empty_repo();
        std::fs::create_dir(dir.path().join("dir")).expect("mkdir");
        write(dir.path(), "dir/a.txt", "committed\n");
        commit_all(dir.path(), "initial");
        // Untrack it while leaving the file: status now reports the staged
        // deletion and a collapsed `dir/` row for the file that is left.
        git_in(dir.path(), &["rm", "--quiet", "--cached", "dir/a.txt"]);
        write(dir.path(), "dir/a.txt", "my own work\n");
        let rows = status(dir.path());
        assert_eq!(paths(&rows.unstaged), vec!["dir/"]);

        rollback(dir.path(), "dir/", None).expect("rollback");

        assert!(
            !dir.path().join("dir").exists(),
            "the untracked row survived"
        );
        // And the *other* row's staged deletion is untouched: rolling back one row
        // must not revert another.
        assert_eq!(paths(&status(dir.path()).staged), vec!["dir/a.txt"]);
    }

    #[test]
    fn rollback_reports_a_nested_repository_it_could_not_remove() {
        // `git clean -f -d` refuses to delete another checkout and still exits 0.
        // Reporting success there would leave a half-deleted subtree, a row that
        // does not go away, and no error anywhere.
        let dir = repo_with_commit("app.ts", "one\n");
        std::fs::create_dir_all(dir.path().join("vendor/pkg")).expect("mkdir");
        write(dir.path(), "vendor/plain.txt", "plain\n");
        git_in(
            &dir.path().join("vendor/pkg"),
            &["init", "--quiet", "-b", "main"],
        );

        let error = rollback(dir.path(), "vendor/", None).expect_err("a nested repo is left");

        assert!(matches!(error, GitError::Invalid(_)), "{error:?}");
        assert!(error.to_string().contains("another repository"), "{error}");
        assert!(dir.path().join("vendor/pkg").exists());
    }

    #[test]
    fn commit_stages_a_brand_new_file_first() {
        // `git commit -- <path>` matches against the index, so an untracked path
        // fails with "did not match any file(s) known to git". Committing a new
        // file is the most obvious thing to want from this menu.
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "notes.md", "notes\n");

        commit_path(dir.path(), "notes.md", None, "add notes").expect("commit a new file");

        assert_eq!(committed_paths(dir.path()), vec!["notes.md"]);
        assert_clean(dir.path());
    }

    #[test]
    fn commit_of_a_new_file_leaves_other_staged_work_alone() {
        // The pre-stage must not widen the commit: only this path is added.
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "notes.md", "notes\n");
        write(dir.path(), "other.ts", "other\n");
        git_in(dir.path(), &["add", "other.ts"]);

        commit_path(dir.path(), "notes.md", None, "add notes").expect("commit");

        assert_eq!(committed_paths(dir.path()), vec!["notes.md"]);
        assert_eq!(paths(&status(dir.path()).staged), vec!["other.ts"]);
    }

    #[test]
    fn a_pathspec_is_refused_before_any_command_runs() {
        let dir = repo_with_commit("app.ts", "one\n");
        write(dir.path(), "app.ts", "two\n");

        for result in [
            stage(dir.path(), ":(glob)**", None),
            unstage(dir.path(), ":(glob)**", None),
            rollback(dir.path(), "../outside.txt", None),
            // The origin is checked too, not just the path.
            rollback(dir.path(), "app.ts", Some(":!src")),
        ] {
            assert!(matches!(result, Err(GitError::Invalid(_))), "{result:?}");
        }
        // The working tree is exactly as it was.
        assert_eq!(read(dir.path(), "app.ts"), "two\n");
        assert_eq!(paths(&status(dir.path()).unstaged), vec!["app.ts"]);
    }

    #[test]
    fn staging_a_rename_passes_both_halves() {
        // The origin's deletion and the new path are one row and two index
        // entries; staging only `new.ts` would leave the deletion unstaged.
        let dir = repo_with_commit("old.ts", "content\n");
        std::fs::rename(dir.path().join("old.ts"), dir.path().join("new.ts")).expect("rename");

        stage(dir.path(), "new.ts", Some("old.ts")).expect("stage");

        assert!(status(dir.path()).unstaged.is_empty());
        commit_all(dir.path(), "renamed");
        assert_clean(dir.path());
    }

    fn head_short(dir: &Path) -> String {
        head_short_sha(dir).expect("head").expect("a commit")
    }

    fn head_subject(dir: &Path) -> String {
        git_in_output(dir, &["log", "-1", "--format=%s"])
            .trim()
            .to_string()
    }

    /// The paths touched by HEAD, from the commit itself rather than the tree.
    fn committed_paths(dir: &Path) -> Vec<String> {
        git_in_output(dir, &["show", "--name-only", "--format=", "HEAD"])
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect()
    }
}
