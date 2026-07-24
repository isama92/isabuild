//! Streamed fetch / pull / push.
//!
//! The first git path in the crate that does not use `Command::output()`:
//! network ops can take a minute, so their progress has to reach the UI while
//! they run. Structurally this mirrors `crate::pty` — spawn, hand the child to a
//! lease so it can be killed, read the pipe on a named thread, emit a terminal
//! event last — driven through an `Fn(OpEvent)` sink so tests can substitute an
//! mpsc channel instead of an app handle.
//!
//! Three details that are not obvious:
//!
//! - **`--progress` is forced.** git only draws progress when stderr is a tty,
//!   and ours is a pipe, so without it the UI would sit silent for the whole op.
//! - **Progress is stderr, and it is localized.** Lines are forwarded verbatim
//!   and never parsed (per CLAUDE.md); the UI displays whatever git said.
//! - **Both pipes are read, on their own threads.** git does not put everything
//!   worth reporting on stderr: a *conflicting pull* exits non-zero having
//!   written "CONFLICT (content): Merge conflict in <file>" to **stdout**, while
//!   stderr holds only the fetch progress. Discarding stdout would show that
//!   failure as a dialog full of successful-looking transfer output. One thread
//!   per pipe is also what avoids the deadlock that reading two pipes in
//!   sequence would hit as soon as the unread one filled.
//!
//! Both streams accumulate into one shared buffer in arrival order, which is as
//! close to git's real chronology as two pipes allow, and that buffer is what a
//! failure dialog shows.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use crate::git::{git_command, map_io_err, GitError};
use crate::gitops::OpLease;

/// Upper bound on the output we keep for the failure dialog. A pathological op
/// (a repo with tens of thousands of refs) must not grow this without limit.
const MAX_COLLECTED_OUTPUT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteOpKind {
    Fetch,
    Pull,
    Push,
}

impl RemoteOpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteOpKind::Fetch => "fetch",
            RemoteOpKind::Pull => "pull",
            RemoteOpKind::Push => "push",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOpSpec {
    pub kind: RemoteOpKind,
    pub remote: String,
    /// Current branch. Required for a push; unused by fetch.
    pub branch: Option<String>,
    /// Publish: `push -u`, setting the upstream as a side effect.
    #[serde(default)]
    pub set_upstream: bool,
}

/// What the frontend hears while an op runs.
pub enum OpEvent {
    /// One line of git's own progress output, verbatim.
    Progress { id: String, line: String },
    /// The op ended. Emitted exactly once per op (see `gitops`'s latch).
    Done {
        id: String,
        exit_code: i32,
        /// Everything git said, on both pipes, for the failure dialog. Named
        /// `output` rather than `stderr` precisely because the most useful line
        /// of a failed pull is on stdout.
        output: String,
        cancelled: bool,
    },
}

/// Build the argv for one operation.
///
/// `pull` is deliberately bare: no `--ff-only`, no `--rebase`, so the user's own
/// `pull.rebase`/`pull.ff` config and hooks decide what happens.
pub fn op_args(spec: &RemoteOpSpec) -> Result<Vec<String>, GitError> {
    if spec.remote.is_empty() || spec.remote.starts_with('-') {
        return Err(GitError::Invalid(format!(
            "'{}' is not a usable remote name",
            spec.remote
        )));
    }
    let mut args = vec![spec.kind.as_str().to_string(), "--progress".to_string()];
    match spec.kind {
        RemoteOpKind::Fetch => args.push(spec.remote.clone()),
        // Bare pull: the branch's upstream and the user's config decide.
        RemoteOpKind::Pull => {}
        RemoteOpKind::Push => {
            let branch = spec.branch.as_deref().unwrap_or_default();
            if branch.is_empty() || branch.starts_with('-') {
                return Err(GitError::Invalid(
                    "cannot push without a current branch".to_string(),
                ));
            }
            if spec.set_upstream {
                args.push("--set-upstream".to_string());
            }
            args.push(spec.remote.clone());
            args.push(branch.to_string());
        }
    }
    Ok(args)
}

/// Start `spec` in the background. Returns as soon as the child is spawned;
/// everything else arrives on `sink`.
pub fn run<F>(root: &Path, spec: &RemoteOpSpec, lease: OpLease, sink: F) -> Result<(), GitError>
where
    F: Fn(OpEvent) + Send + 'static,
{
    let args = op_args(spec)?;
    let mut cmd = git_command(root);
    cmd.args(&args);
    apply_network_env(&mut cmd, root);
    // Both pipes: see the module note on a conflicting pull reporting itself on
    // stdout. Each gets its own thread, so neither can block on the other.
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(map_io_err)?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| GitError::Io("git produced no stderr pipe to read".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GitError::Io("git produced no stdout pipe to read".to_string()))?;
    lease.set_child(child);

    let id = lease.id().to_string();
    let collected = Arc::new(Mutex::new(String::new()));

    // stdout first: it carries no progress, only text worth keeping, and the
    // stderr thread joins it before reporting so nothing is lost.
    let stdout_collected = Arc::clone(&collected);
    let stdout_thread = std::thread::Builder::new()
        .name(format!("git-op-out-{id}"))
        .spawn(move || drain_into(stdout, &stdout_collected));
    let stdout_thread = match stdout_thread {
        Ok(handle) => handle,
        Err(_) => {
            lease.claim_terminal();
            lease.kill();
            lease.wait();
            return Err(GitError::Io(
                "failed to start the git output reader thread".to_string(),
            ));
        }
    };

    let thread_lease = lease.clone();
    let stderr_collected = Arc::clone(&collected);
    let reader = std::thread::Builder::new()
        .name(format!("git-op-{id}"))
        .spawn(move || {
            stream_stderr(
                stderr,
                id,
                thread_lease,
                sink,
                stderr_collected,
                stdout_thread,
            )
        });
    if reader.is_err() {
        // The OS refused a thread. Kill the child rather than leave it running
        // with nobody draining its pipe (it would block once the pipe filled).
        lease.claim_terminal();
        lease.kill();
        lease.wait();
        return Err(GitError::Io(
            "failed to start the git progress reader thread".to_string(),
        ));
    }
    Ok(())
}

/// Read a pipe to EOF, accumulating its lines. No events: this is the stdout
/// side, which git uses for results rather than progress.
fn drain_into(mut pipe: std::process::ChildStdout, collected: &Mutex<String>) {
    let mut pending = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(n) if n > 0 => {
                for line in split_progress_chunks(&mut pending, &buf[..n]) {
                    collect_line(collected, &line);
                }
            }
            _ => break,
        }
    }
    if let Some(line) = flush_progress(&mut pending) {
        collect_line(collected, &line);
    }
}

fn stream_stderr<F>(
    mut stderr: std::process::ChildStderr,
    id: String,
    lease: OpLease,
    sink: F,
    collected: Arc<Mutex<String>>,
    stdout_thread: std::thread::JoinHandle<()>,
) where
    F: Fn(OpEvent),
{
    let mut pending = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stderr.read(&mut buf) {
            Ok(n) if n > 0 => {
                for line in split_progress_chunks(&mut pending, &buf[..n]) {
                    collect_line(&collected, &line);
                    sink(OpEvent::Progress {
                        id: id.clone(),
                        line,
                    });
                }
            }
            // EOF, or a read error once the child is gone.
            _ => break,
        }
    }
    // git's final progress line usually has no trailing newline, so whatever is
    // left in the buffer is a real line, not a fragment.
    if let Some(line) = flush_progress(&mut pending) {
        collect_line(&collected, &line);
        sink(OpEvent::Progress {
            id: id.clone(),
            line,
        });
    }

    // Join before reporting, so the dialog cannot miss the stdout half (the
    // conflict message of a failed pull lives there). Both pipes are at EOF by
    // now in the normal case, so this does not add latency.
    let _ = stdout_thread.join();
    let exit_code = lease.wait();
    let output = collected
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    // Lost only when the op was cancelled: the canceller already reported it.
    if lease.claim_terminal() {
        sink(OpEvent::Done {
            id,
            exit_code,
            output,
            cancelled: false,
        });
    }
}

/// Split a chunk of git's stderr into complete lines.
///
/// git overwrites its progress line with a carriage return, so `\r` ends a line
/// just as `\n` does, and a `\r\n` pair counts once. The trailing partial line
/// stays in `pending` for the next chunk — splitting on byte boundaries is safe
/// because neither delimiter can occur inside a multi-byte UTF-8 sequence.
pub fn split_progress_chunks(pending: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    pending.extend_from_slice(chunk);
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < pending.len() {
        let byte = pending[i];
        if byte == b'\n' || byte == b'\r' {
            let line = String::from_utf8_lossy(&pending[start..i])
                .trim()
                .to_string();
            if !line.is_empty() {
                lines.push(line);
            }
            if byte == b'\r' && pending.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
            start = i + 1;
        }
        i += 1;
    }
    pending.drain(..start);
    lines
}

/// Take whatever is left in the buffer as a final line.
pub fn flush_progress(pending: &mut Vec<u8>) -> Option<String> {
    if pending.is_empty() {
        return None;
    }
    let line = String::from_utf8_lossy(pending).trim().to_string();
    pending.clear();
    (!line.is_empty()).then_some(line)
}

/// Append one line to the shared buffer both pipe readers feed.
///
/// A poisoned lock is ignored rather than propagated: losing a line of
/// diagnostic text must not take down the operation reporting it.
fn collect_line(collected: &Mutex<String>, line: &str) {
    if let Ok(mut guard) = collected.lock() {
        collect_capped(&mut guard, line);
    }
}

fn collect_capped(collected: &mut String, line: &str) {
    if collected.len() >= MAX_COLLECTED_OUTPUT {
        return;
    }
    if !collected.is_empty() {
        collected.push('\n');
    }
    collected.push_str(line);
    if collected.len() >= MAX_COLLECTED_OUTPUT {
        collected.push_str("\n… output truncated");
    }
}

/// Environment for a network op: fail fast instead of blocking on a credential
/// prompt nobody can answer. `git_command` already closes stdin; these cover the
/// paths that would otherwise find a tty or pop their own prompt.
fn apply_network_env(cmd: &mut std::process::Command, root: &Path) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if user_ssh_command(root).is_none() {
        // BatchMode makes ssh fail rather than block on a passphrase prompt.
        // Only when the user has configured no ssh command of their own:
        // GIT_SSH_COMMAND overrides core.sshCommand, so setting it
        // unconditionally would silently discard their setting.
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
}

/// The user's own ssh command, from the environment or git config, if any.
fn user_ssh_command(root: &Path) -> Option<String> {
    for key in ["GIT_SSH_COMMAND", "GIT_SSH"] {
        if let Some(value) = std::env::var_os(key) {
            if !value.is_empty() {
                return Some(value.to_string_lossy().into_owned());
            }
        }
    }
    let output = crate::git::git_read_command(root)
        .args(["config", "--get", "core.sshCommand"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: RemoteOpKind, branch: Option<&str>, set_upstream: bool) -> RemoteOpSpec {
        RemoteOpSpec {
            kind,
            remote: "origin".to_string(),
            branch: branch.map(str::to_string),
            set_upstream,
        }
    }

    // --- op_args ----------------------------------------------------------

    #[test]
    fn fetch_names_the_remote_and_forces_progress() {
        let args = op_args(&spec(RemoteOpKind::Fetch, None, false)).unwrap();
        assert_eq!(args, ["fetch", "--progress", "origin"]);
    }

    #[test]
    fn pull_stays_bare_so_the_users_config_decides() {
        // No --ff-only and no --rebase: pull.rebase / pull.ff are the user's.
        let args = op_args(&spec(RemoteOpKind::Pull, Some("main"), false)).unwrap();
        assert_eq!(args, ["pull", "--progress"]);
    }

    #[test]
    fn push_names_remote_and_branch_and_publishes_with_set_upstream() {
        let args = op_args(&spec(RemoteOpKind::Push, Some("main"), false)).unwrap();
        assert_eq!(args, ["push", "--progress", "origin", "main"]);
        let published = op_args(&spec(RemoteOpKind::Push, Some("main"), true)).unwrap();
        assert_eq!(
            published,
            ["push", "--progress", "--set-upstream", "origin", "main"]
        );
    }

    #[test]
    fn option_like_and_missing_names_are_refused_before_git_runs() {
        assert!(op_args(&spec(RemoteOpKind::Push, None, false)).is_err());
        assert!(op_args(&spec(RemoteOpKind::Push, Some(""), false)).is_err());
        assert!(op_args(&spec(RemoteOpKind::Push, Some("--force"), false)).is_err());
        let mut bad_remote = spec(RemoteOpKind::Fetch, None, false);
        bad_remote.remote = "--upload-pack=evil".to_string();
        assert!(op_args(&bad_remote).is_err());
    }

    // --- split_progress_chunks --------------------------------------------

    #[test]
    fn newline_separated_lines_are_split() {
        let mut pending = Vec::new();
        let lines = split_progress_chunks(&mut pending, b"remote: Enumerating\nremote: Counting\n");
        assert_eq!(lines, ["remote: Enumerating", "remote: Counting"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn carriage_returns_end_a_line_because_git_overwrites_progress() {
        let mut pending = Vec::new();
        let lines = split_progress_chunks(
            &mut pending,
            b"Receiving objects:  50% (1/2)\rReceiving objects: 100% (2/2)\r",
        );
        assert_eq!(
            lines,
            [
                "Receiving objects:  50% (1/2)",
                "Receiving objects: 100% (2/2)"
            ]
        );
    }

    #[test]
    fn a_crlf_pair_yields_one_line_not_an_empty_extra() {
        let mut pending = Vec::new();
        let lines = split_progress_chunks(&mut pending, b"done\r\nnext\r\n");
        assert_eq!(lines, ["done", "next"]);
    }

    #[test]
    fn a_partial_line_is_buffered_until_its_delimiter_arrives() {
        let mut pending = Vec::new();
        assert!(split_progress_chunks(&mut pending, b"Resolving del").is_empty());
        assert!(!pending.is_empty());
        let lines = split_progress_chunks(&mut pending, b"tas: 100%\n");
        assert_eq!(lines, ["Resolving deltas: 100%"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn a_multibyte_character_split_across_chunks_survives() {
        // "\u{e9}" is two bytes; a delimiter can never appear inside it, so
        // buffering by bytes must not corrupt it.
        let mut pending = Vec::new();
        assert!(split_progress_chunks(&mut pending, b"caf\xc3").is_empty());
        let lines = split_progress_chunks(&mut pending, b"\xa9\n");
        assert_eq!(lines, ["café"]);
    }

    #[test]
    fn blank_and_whitespace_only_lines_are_dropped() {
        let mut pending = Vec::new();
        let lines = split_progress_chunks(&mut pending, b"\n\r\n   \nreal\n");
        assert_eq!(lines, ["real"]);
    }

    #[test]
    fn flush_returns_the_unterminated_tail_once() {
        let mut pending = Vec::new();
        split_progress_chunks(&mut pending, b"Everything up-to-date");
        assert_eq!(
            flush_progress(&mut pending).as_deref(),
            Some("Everything up-to-date")
        );
        assert_eq!(flush_progress(&mut pending), None);
    }

    // --- collect_capped ---------------------------------------------------

    #[test]
    fn collected_output_is_capped_and_says_so() {
        let mut collected = String::new();
        let line = "x".repeat(1024);
        for _ in 0..1024 {
            collect_capped(&mut collected, &line);
        }
        assert!(collected.len() < MAX_COLLECTED_OUTPUT + 4096);
        assert!(collected.ends_with("… output truncated"));
    }

    #[test]
    fn collected_output_joins_lines_with_newlines() {
        let mut collected = String::new();
        collect_capped(&mut collected, "first");
        collect_capped(&mut collected, "second");
        assert_eq!(collected, "first\nsecond");
    }

    #[test]
    fn collecting_through_the_shared_lock_accumulates_from_both_pipes() {
        let collected = Mutex::new(String::new());
        collect_line(&collected, "from stderr");
        collect_line(&collected, "from stdout");
        assert_eq!(
            collected.lock().unwrap().as_str(),
            "from stderr\nfrom stdout"
        );
    }
}

/// End to end against a bare repository on the filesystem.
///
/// A bare repo is an ordinary git remote, so fetch, pull and push run for real
/// here — the streaming, the exit codes and the stderr capture are all exercised
/// with no network and no credentials involved.
#[cfg(test)]
mod repo_tests {
    use super::*;
    use crate::gitops::GitOps;
    use crate::testrepo::{
        bare_remote_path, commit_all, git_in, git_raw, repo_with_bare_remote, write,
    };
    use std::sync::mpsc;
    use std::time::Duration;

    struct Finished {
        exit_code: i32,
        output: String,
        cancelled: bool,
        progress: Vec<String>,
    }

    /// Run one op to completion, collecting everything the sink saw.
    fn run_op(dir: &std::path::Path, spec: &RemoteOpSpec) -> Finished {
        let ops = GitOps::default();
        let lease = ops.begin("test-op").expect("claim the op slot");
        let (tx, rx) = mpsc::channel();
        run(dir, spec, lease, move |event| {
            let _ = tx.send(event);
        })
        .expect("spawn the op");

        let mut progress = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(60)) {
                Ok(OpEvent::Progress { line, .. }) => progress.push(line),
                Ok(OpEvent::Done {
                    exit_code,
                    output,
                    cancelled,
                    ..
                }) => {
                    return Finished {
                        exit_code,
                        output,
                        cancelled,
                        progress,
                    }
                }
                Err(error) => panic!("no terminal event arrived: {error}"),
            }
        }
    }

    fn spec_for(kind: RemoteOpKind, branch: &str, set_upstream: bool) -> RemoteOpSpec {
        RemoteOpSpec {
            kind,
            remote: "origin".to_string(),
            branch: Some(branch.to_string()),
            set_upstream,
        }
    }

    /// Commit into the bare remote out of band, the way a colleague would.
    fn advance_the_remote(dir: &std::path::Path) {
        let clone = dir.join("colleague");
        let bare = bare_remote_path(dir);
        let output = git_raw(
            dir,
            &["clone", "--quiet", &bare.to_string_lossy(), "colleague"],
        );
        assert!(output.status.success(), "clone the bare remote");
        write(&clone, "file.txt", "from the remote\n");
        commit_all(&clone, "remote side commit");
        git_in(&clone, &["push", "--quiet", "origin", "main"]);
    }

    #[test]
    fn a_successful_fetch_reports_zero_and_updates_the_remote_ref() {
        let dir = repo_with_bare_remote();
        advance_the_remote(dir.path());
        let before = crate::branch::branch_state(dir.path()).expect("state");
        assert_eq!((before.ahead, before.behind), (0, 0));

        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Fetch, "main", false));
        assert_eq!(finished.exit_code, 0, "stderr was: {}", finished.output);
        assert!(!finished.cancelled);

        // The fetch is what makes "behind" visible.
        let after = crate::branch::branch_state(dir.path()).expect("state");
        assert_eq!((after.ahead, after.behind), (0, 1));
        assert!(after.last_fetch.is_some(), "FETCH_HEAD should now exist");
    }

    #[test]
    fn a_pull_fast_forwards_the_working_tree() {
        let dir = repo_with_bare_remote();
        advance_the_remote(dir.path());

        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Pull, "main", false));
        assert_eq!(finished.exit_code, 0, "stderr was: {}", finished.output);
        assert_eq!(
            crate::testrepo::read(dir.path(), "file.txt"),
            "from the remote\n"
        );
        let state = crate::branch::branch_state(dir.path()).expect("state");
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn a_push_sends_the_local_commit() {
        let dir = repo_with_bare_remote();
        write(dir.path(), "file.txt", "pushed\n");
        commit_all(dir.path(), "local commit");
        let ahead = crate::branch::branch_state(dir.path()).expect("state");
        assert_eq!((ahead.ahead, ahead.behind), (1, 0));

        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Push, "main", false));
        assert_eq!(finished.exit_code, 0, "stderr was: {}", finished.output);

        let after = crate::branch::branch_state(dir.path()).expect("state");
        assert_eq!((after.ahead, after.behind), (0, 0), "no longer ahead");
    }

    #[test]
    fn publishing_a_branch_sets_its_upstream() {
        let dir = repo_with_bare_remote();
        crate::branch::create(dir.path(), "fresh", None).expect("create");
        let before = crate::branch::branch_state(dir.path()).expect("state");
        assert_eq!(before.upstream, None, "a new branch has no upstream");

        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Push, "fresh", true));
        assert_eq!(finished.exit_code, 0, "stderr was: {}", finished.output);

        let after = crate::branch::branch_state(dir.path()).expect("state");
        assert_eq!(after.upstream.as_deref(), Some("origin/fresh"));
    }

    #[test]
    fn a_conflicting_pull_reports_the_conflict_from_stdout() {
        // The regression this test exists for: git writes "CONFLICT (content):
        // ..." to *stdout* and only the fetch progress to stderr, so capturing
        // stderr alone produced a "pull failed" dialog full of
        // successful-looking transfer output.
        let dir = repo_with_bare_remote();
        advance_the_remote(dir.path());
        // Touch the same file locally and commit, so the merge must conflict.
        write(dir.path(), "file.txt", "mine\n");
        commit_all(dir.path(), "local conflicting commit");

        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Pull, "main", false));

        assert_ne!(finished.exit_code, 0, "a conflicting pull must fail");
        assert!(
            finished.output.contains("CONFLICT"),
            "the dialog must carry git's conflict message, got: {}",
            finished.output
        );
    }

    #[test]
    fn a_diverged_push_fails_with_gits_own_stderr() {
        let dir = repo_with_bare_remote();
        advance_the_remote(dir.path());
        // Commit locally too, so both sides have moved: the push must be
        // rejected rather than fast-forwarded.
        write(dir.path(), "other.txt", "local only\n");
        commit_all(dir.path(), "local commit");

        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Push, "main", false));
        assert_ne!(finished.exit_code, 0, "a diverged push must fail");
        assert!(
            !finished.output.is_empty(),
            "the error dialog needs git's stderr to show"
        );
        // Nothing is parsed out of this text; the test only asserts we captured
        // enough of it to be worth showing.
        assert!(
            finished.output.len() > 20,
            "stderr was: {}",
            finished.output
        );
    }

    #[test]
    fn a_broken_remote_url_fails_without_hanging() {
        let dir = repo_with_bare_remote();
        git_in(
            dir.path(),
            &[
                "remote",
                "set-url",
                "origin",
                // A path that does not exist: git fails immediately rather than
                // waiting on anything.
                &dir.path().join("no-such-repo.git").to_string_lossy(),
            ],
        );
        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Fetch, "main", false));
        assert_ne!(finished.exit_code, 0);
        assert!(!finished.output.is_empty());
    }

    #[test]
    fn progress_lines_reach_the_sink_before_the_terminal_event() {
        let dir = repo_with_bare_remote();
        advance_the_remote(dir.path());
        let finished = run_op(dir.path(), &spec_for(RemoteOpKind::Fetch, "main", false));
        assert_eq!(finished.exit_code, 0);
        // A fetch that actually transfers objects always narrates itself. The
        // content is git's and localized, so only its presence is asserted.
        assert!(
            !finished.progress.is_empty(),
            "expected progress output from a fetch that transferred objects"
        );
    }

    #[test]
    fn a_second_operation_is_refused_while_one_holds_the_slot() {
        let dir = repo_with_bare_remote();
        let ops = GitOps::default();
        let _held = ops.begin("first").expect("claim");
        let error = ops.begin("second").expect_err("refused");
        assert!(error.to_string().contains("first"), "{error}");
        // And the slot frees up again for a real op.
        ops.finish("first");
        let lease = ops.begin("second").expect("claim");
        let (tx, rx) = mpsc::channel();
        run(
            dir.path(),
            &spec_for(RemoteOpKind::Fetch, "main", false),
            lease,
            move |event| {
                let _ = tx.send(event);
            },
        )
        .expect("spawn");
        // Drain to completion so the temp dir is not removed under a live child.
        while let Ok(event) = rx.recv_timeout(Duration::from_secs(60)) {
            if matches!(event, OpEvent::Done { .. }) {
                break;
            }
        }
    }

    #[test]
    fn cancelling_reports_once_and_the_reader_stays_quiet() {
        let dir = repo_with_bare_remote();
        let ops = GitOps::default();
        let lease = ops.begin("cancel-me").expect("claim");
        let (tx, rx) = mpsc::channel();
        run(
            dir.path(),
            &spec_for(RemoteOpKind::Fetch, "main", false),
            lease,
            move |event| {
                let _ = tx.send(event);
            },
        )
        .expect("spawn");

        // A local fetch may well finish first; either way exactly one side gets
        // to report, which is the invariant under test.
        let cancelled_by_us = ops.cancel("cancel-me");
        let mut terminal_events = 0;
        while let Ok(event) = rx.recv_timeout(Duration::from_secs(60)) {
            if matches!(event, OpEvent::Done { .. }) {
                terminal_events += 1;
            }
        }
        if cancelled_by_us {
            assert_eq!(
                terminal_events, 0,
                "the canceller claimed the event, so the reader must not emit one"
            );
        } else {
            assert_eq!(
                terminal_events, 1,
                "the op finished on its own and reported exactly once"
            );
        }
    }
}
