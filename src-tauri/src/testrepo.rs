//! Throwaway git repositories for tests.
//!
//! Lifted out of `diff`'s test module so `branch` and `remote` can share it.
//! Every invocation is isolated from the developer's own git config: `autocrlf`,
//! hooks, commit signing and `init.defaultBranch` would otherwise leak in and
//! make results machine-dependent.
//!
//! [`repo_with_bare_remote`] is what lets the network operations be tested at
//! all: a bare repository on the filesystem is a perfectly ordinary git remote,
//! so fetch, pull and push run end to end with no network and no credentials.
//!
//! To check a fixture really is self-sufficient, run the suite the way a bare CI
//! runner sees the world — with no global or system git config at all:
//!
//! ```text
//! GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
//!   cargo test --manifest-path src-tauri/Cargo.toml
//! ```
//!
//! A developer's own global identity otherwise masks anything the fixture forgot
//! to set for the code under test.

use std::path::Path;
use std::process::Command;

/// Run git in `dir`, isolated and with a fixed identity. Panics on failure —
/// a broken fixture should fail loudly, not produce a confusing assertion later.
pub fn git_in(dir: &Path, args: &[&str]) {
    let output = git_raw(dir, args);
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// As [`git_in`], but hands back the result instead of asserting, for the cases
/// where a non-zero exit is the thing under test.
pub fn git_raw(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", dir.join("no-global-config"))
        .env("GIT_CONFIG_SYSTEM", dir.join("no-system-config"))
        .env("GIT_AUTHOR_NAME", "isabuild test")
        .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
        .env("GIT_COMMITTER_NAME", "isabuild test")
        .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
        .output()
        .expect("run git")
}

/// An empty repo on branch `main`.
///
/// `-b main` is explicit because `init.defaultBranch` is unset here (the config
/// isolation above), and git's built-in default has changed over releases.
///
/// The settings are written **repo-local** on purpose. `git_in` isolates the
/// fixture's own commands, but the code under test builds its commands through
/// `git::git_command`, which sets no config env — so without these, a developer
/// with `core.autocrlf=true` or `commit.gpgsign=true` globally would get
/// different results from the same test, and a machine with *no* git identity
/// (a bare CI runner) would fail outright wherever production code makes a
/// commit: a merging `pull`, and `stash push`, both need a committer.
pub fn empty_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    git_in(dir.path(), &["init", "--quiet", "-b", "main"]);
    for (key, value) in [
        // Identity for commits made by the code under test, not by the fixture.
        ("user.name", "isabuild test"),
        ("user.email", "test@example.invalid"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        // Only affects the pull tests, and for a fast-forward both strategies
        // land in the same place; pinning it keeps the argv under test honest.
        ("pull.rebase", "false"),
    ] {
        git_in(dir.path(), &["config", key, value]);
    }
    // Ignore resolution has to be deterministic too, for the same reason as the
    // settings above: the code under test builds its commands through
    // `git::git_read_command`, which sets no config env, so a developer with a
    // global `~/.config/git/ignore` would get different answers from the same test
    // than a bare CI runner does. A repo-local `core.excludesFile` pointing at a
    // file that does not exist overrides whatever is global.
    let no_excludes = dir.path().join("no-global-excludes");
    git_in(
        dir.path(),
        &[
            "config",
            "core.excludesFile",
            &no_excludes.to_string_lossy(),
        ],
    );
    dir
}

/// A repo with one committed file, ready for working-tree edits.
pub fn repo_with_commit(name: &str, content: &str) -> tempfile::TempDir {
    let dir = empty_repo();
    write(dir.path(), name, content);
    git_in(dir.path(), &["add", name]);
    commit(dir.path(), "initial");
    dir
}

/// A repo with one commit, plus a bare `origin` it already tracks.
///
/// The bare repo lives inside the same temp dir, so it is cleaned up with
/// everything else.
pub fn repo_with_bare_remote() -> tempfile::TempDir {
    let dir = repo_with_commit("file.txt", "one\n");
    let bare = dir.path().join("origin.git");
    std::fs::create_dir(&bare).expect("create bare dir");
    git_in(&bare, &["init", "--quiet", "--bare", "-b", "main"]);
    git_in(
        dir.path(),
        &["remote", "add", "origin", &bare.to_string_lossy()],
    );
    git_in(dir.path(), &["push", "--quiet", "-u", "origin", "main"]);
    dir
}

/// A repo on `main` with a `feature` branch that changed the *same line*, so
/// `git merge feature` is guaranteed to conflict. Nothing is merged yet.
///
/// Three lines, not one, so a resolved file can be checked to still have its
/// context: a resolution that quietly ate the surrounding lines would otherwise
/// pass.
pub fn repo_with_conflicting_branches() -> tempfile::TempDir {
    let dir = repo_with_commit("file.txt", "one\ntwo\nthree\n");
    git_in(dir.path(), &["switch", "--quiet", "-c", "feature"]);
    write(dir.path(), "file.txt", "one\ntwo from feature\nthree\n");
    commit_all(dir.path(), "feature edit");
    git_in(dir.path(), &["switch", "--quiet", "main"]);
    write(dir.path(), "file.txt", "one\ntwo from main\nthree\n");
    commit_all(dir.path(), "main edit");
    dir
}

/// A repo on `main` where `feature` deleted the file `main` went on editing.
/// Merging `feature` gives a delete/modify conflict (`UD`) — no markers, no text
/// to accept, which is the case a marker-only implementation cannot finish.
pub fn repo_with_delete_modify_branches() -> tempfile::TempDir {
    let dir = repo_with_commit("file.txt", "one\ntwo\n");
    git_in(dir.path(), &["switch", "--quiet", "-c", "feature"]);
    git_in(dir.path(), &["rm", "-q", "file.txt"]);
    commit(dir.path(), "feature deletes the file");
    git_in(dir.path(), &["switch", "--quiet", "main"]);
    write(dir.path(), "file.txt", "one\ntwo edited\n");
    commit_all(dir.path(), "main edits the file");
    dir
}

/// A repo stopped part-way through a **conflicting rebase** of `feature` onto
/// `main`, on the *second* of two replayed commits.
///
/// Two commits rather than one so `msgnum`/`end` have something to count and
/// `--skip` has somewhere to go: with a single commit, skipping it ends the rebase
/// and the "N of M" the banner shows would always read "1 of 1".
///
/// The rebase is started with the fixture's own git, not the code under test —
/// Part 7 drives an in-progress rebase, it does not start one.
pub fn repo_with_rebase_conflict() -> tempfile::TempDir {
    let dir = repo_with_commit("file.txt", "one\ntwo\nthree\n");
    git_in(dir.path(), &["switch", "--quiet", "-c", "feature"]);
    // A first commit that replays cleanly, then one that cannot.
    write(dir.path(), "extra.txt", "from feature\n");
    commit_all(dir.path(), "feature adds a file");
    write(dir.path(), "file.txt", "one\ntwo from feature\nthree\n");
    commit_all(dir.path(), "feature edits the shared line");
    git_in(dir.path(), &["switch", "--quiet", "main"]);
    write(dir.path(), "file.txt", "one\ntwo from main\nthree\n");
    commit_all(dir.path(), "main edits the shared line");

    git_in(dir.path(), &["switch", "--quiet", "feature"]);
    // Expected to stop on the conflict, so the exit code is not asserted.
    let output = git_raw(dir.path(), &["rebase", "main"]);
    assert!(
        !output.status.success(),
        "the fixture's rebase was supposed to conflict"
    );
    dir
}

/// A repo stopped part-way through a **conflicting cherry-pick**: `main` picks a
/// commit from `feature` that touches the same line.
pub fn repo_with_cherry_pick_conflict() -> tempfile::TempDir {
    let dir = repo_with_commit("file.txt", "one\ntwo\nthree\n");
    git_in(dir.path(), &["switch", "--quiet", "-c", "feature"]);
    write(dir.path(), "file.txt", "one\ntwo from feature\nthree\n");
    commit_all(dir.path(), "feature edits the shared line");
    let sha = rev_parse(dir.path(), "feature");
    git_in(dir.path(), &["switch", "--quiet", "main"]);
    write(dir.path(), "file.txt", "one\ntwo from main\nthree\n");
    commit_all(dir.path(), "main edits the shared line");

    let output = git_raw(dir.path(), &["cherry-pick", &sha]);
    assert!(
        !output.status.success(),
        "the fixture's cherry-pick was supposed to conflict"
    );
    dir
}

/// Full sha of `reference`.
pub fn rev_parse(dir: &Path, reference: &str) -> String {
    let output = git_raw(dir, &["rev-parse", reference]);
    assert!(output.status.success(), "rev-parse {reference} failed");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Path of the bare remote inside a [`repo_with_bare_remote`] fixture.
pub fn bare_remote_path(dir: &Path) -> std::path::PathBuf {
    dir.join("origin.git")
}

/// Commit everything staged with `message`.
pub fn commit(dir: &Path, message: &str) {
    git_in(dir, &["commit", "--quiet", "-m", message]);
}

/// Stage everything and commit it.
pub fn commit_all(dir: &Path, message: &str) {
    git_in(dir, &["add", "-A"]);
    commit(dir, message);
}

pub fn write(dir: &Path, name: &str, content: &str) {
    std::fs::write(dir.join(name), content).expect("write file");
}

pub fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).expect("read file")
}

/// `git status --porcelain` as a set of lines, for asserting on the index/tree
/// split without re-deriving the porcelain parser.
pub fn porcelain(dir: &Path) -> Vec<String> {
    let output = git_raw(dir, &["status", "--porcelain"]);
    assert!(output.status.success(), "git status failed");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

/// Name of the checked-out branch.
pub fn current_branch(dir: &Path) -> String {
    let output = git_raw(dir, &["symbolic-ref", "--short", "HEAD"]);
    assert!(output.status.success(), "detached HEAD in fixture");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// `git stash list` subjects, newest first.
pub fn stash_subjects(dir: &Path) -> Vec<String> {
    let output = git_raw(dir, &["stash", "list", "--format=%gs"]);
    assert!(output.status.success(), "git stash list failed");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}
