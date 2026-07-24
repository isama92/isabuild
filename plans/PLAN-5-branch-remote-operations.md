# Plan 5: Branch & Remote Operations

## Goal
Manage the branch from the UI the way GitHub Desktop does: see the current branch and how far it has drifted from its upstream, switch or create one, check out a remote branch, rename or delete a local one, and fetch/pull/push with live progress and a real error dialog — all without dropping into the bottom shell.

Out of scope for this plan: force-push, remote management (add/remove/rename a remote), commit/stage from the UI, auto-fetch on a timer, merge and conflict resolution (Parts 6–7), and cross-restart persistence of anything here (Part 8).

## Decisions

| Decision | Choice |
|---|---|
| Placement | Right cluster of the existing bottom status bar (`⑂ main ↑2 ↓0 ⟳ ↓ ↑`); the branch menu is a popover opening **upward**. No new layout region and no new `Alt+<n>` — that scheme is region toggles, and a menu is not a region. |
| Branch ops | Switch, create, check out a remote branch, delete a local branch, rename the current branch. |
| Dirty switch | A GitHub Desktop-style prompt: **Bring my changes to X** or **Leave my changes on Y**. |
| "Bring" mechanism | Plain `git switch <target>` — git carries non-colliding changes natively and preserves the staged/unstaged split exactly. A deliberate deviation from GHD's stash+pop: `stash pop` without `--index` silently unstages everything, and with `--index` it conflicts in precisely the cases plain `switch` also refuses. On refusal we surface git's stderr and offer "Leave" instead. |
| "Leave" mechanism | `git stash push --include-untracked -m "isabuild:<branch>"`, then switch. |
| Stash restore | **Auto-restore on return**: switching to a branch pops a stash marked `isabuild:<branch>` with `--index`, so staging survives. A conflicting pop leaves the stash intact and reports. |
| New branch | Name **+ base ref picker** (defaults to current HEAD) → `git switch -c <name> <base>`, validated by `git check-ref-format --branch`. |
| Pull | Plain `git pull --progress`, honouring the user's `pull.rebase`/`pull.ff` config and hooks. A conflicting pull surfaces as `!` rows in the Status panel until Part 6. |
| Push | No upstream → the button reads **Publish branch** and runs `push -u <remote> <branch>`. Diverged → push fails and the modal shows git's own "fetch first" stderr. **No force-push path exists**, so this part cannot discard a remote commit. |
| Auto-fetch | **None.** Manual only; the Fetch button's tooltip shows staleness from `<git-dir>/FETCH_HEAD` mtime. Keeps the "events over polling" rule intact. |
| Progress / errors | Streamed progress collapses into the status-bar cluster (git's own line, **verbatim, never parsed** — it is localized), with a Cancel. A non-zero exit opens an in-app modal with the full stderr, Copy, and **Retry in terminal**. No `tauri-plugin-dialog`, so no new permission surface. |
| Op safety | `GIT_TERMINAL_PROMPT=0`; in-flight ops cancellable; one mutating op at a time behind a backend lock; `--no-optional-locks` on every read path. |
| Branch list | Type-to-filter input, ordered `-committerdate`. Locals first, then remote-only branches under a divider. |
| Remote resolution | The current branch's upstream remote → else `origin` → else the sole remote → else an actionable error. |

## Deliverables

### 1. Rust: `src-tauri/src/branch.rs`
`BranchState { current, detached_sha, unborn, upstream, remote, ahead, behind, last_fetch, locals, remotes }` in one round trip, plus the mutations. Reuses `git::git_command` / `map_io_err` / `GitError`.

Reading is one `for-each-ref` over `refs/heads refs/remotes`, `--sort=-committerdate`, with `%00` field separators (git's format hex escape) and `\n` records — ref names cannot contain control characters, so the framing is unambiguous.

Pure, fixture-tested parsers:
- `parse_for_each_ref` — drops symbolic rows by testing the **full** refname for a `/HEAD` suffix. `refs/remotes/origin/HEAD` has `%(refname:short)` == `origin`, so filtering on the short name would leave a phantom branch called "origin" in the list.
- `parse_ahead_behind` — `git rev-list --left-right --count <upstream>...HEAD` gives `behind<TAB>ahead`. **Left is the upstream side.** `%(upstream:track)` is prose (`[ahead 1, behind 3]`) *and* in the opposite order, which is why the plumbing command is used instead.
- `parse_stash_list` — `stash list --format=%gd%x00%gs`; `stash push -m` prefixes the subject with `On <branch>: `, so the marker is matched as a suffix; newest wins.
- `dedupe_remotes` — flags a remote branch whose basename matches a local one so the UI routes the pick to the local branch.
- `resolve_remote` — upstream's remote → `origin` → sole remote → error.

Mutations: `switch` (the whole stash → switch → auto-restore flow in **one** call, so it cannot interleave with a watcher-driven read), `create`, `delete`, `rename`, `validate_branch_name` (rejects a leading `-` in Rust first, so it can never be read as an option).

### 2. Rust: `src-tauri/src/gitops.rs`
`GitOps` managed state: `begin`/`finish` reject a second concurrent mutating op, `register_child`/`cancel` back the Cancel button. Branch mutations *and* network ops share it, so a checkout cannot race a pull.

### 3. Rust: `src-tauri/src/remote.rs`
Streamed fetch/pull/push, structurally mirroring `pty.rs`: a killer handle in managed state, a reader thread per pipe, and a terminal event emitted last. `--progress` is forced because git suppresses progress when stderr is not a tty. `split_progress_chunks` is pure and fixture-tested: git overwrites progress with `\r`, so both `\r` and `\n` split, and the partial tail is buffered.

**Both pipes are read, each on its own thread.** git does not put everything worth reporting on stderr: a conflicting `pull` exits non-zero having written `CONFLICT (content): Merge conflict in <file>` to **stdout**, with only the fetch progress on stderr. Capturing stderr alone produced a "pull failed" dialog full of successful-looking transfer output — the misleading opposite of what happened, while the working tree had conflict markers in it. Both streams accumulate into one shared buffer in arrival order; the stderr thread joins the stdout thread before reporting, so the dialog cannot miss half the story. One thread per pipe is also what avoids the deadlock that reading two pipes in sequence would hit once the unread one filled.

Environment: `GIT_TERMINAL_PROMPT=0` always; `GIT_SSH_COMMAND=ssh -o BatchMode=yes` only when neither the env var nor `core.sshCommand` is set (`GIT_SSH_COMMAND` overrides `core.sshCommand`, so setting it unconditionally would clobber the user's config).

Cancellation needs `kill()` concurrent with a `wait()` on another thread. Rather than reach for `shared_child`, the child lives in a `Mutex<Option<Child>>` whose guard is released *before* the blocking wait, and **the cancel path emits the terminal event itself** under the `gitops` latch. That inverts the dependency: recovery no longer needs the reader thread to be alive, which matters because git can hand its stderr pipe to a child `ssh` that survives the kill, so EOF may never arrive — no crate choice fixes that. Net: no new dependency.

### 4. Rust: commands, wiring, test helper
Eight commands (`git_branch_state`, `git_switch_branch`, `git_create_branch`, `git_delete_branch`, `git_rename_branch`, `git_validate_branch_name`, `git_remote_op`, `git_cancel_op`), branch work on the blocking pool like `git_status`. `git_remote_op` returns as soon as the child is spawned; results arrive on `git://progress/<opId>` and `git://done/<opId>`, following the `pty://output/{id}` naming. No capability change — `core:default` already grants event listening and the modal is in-app.

`git::git_read_command` adds `--no-optional-locks` to the read path so a watcher-driven read never contends for `index.lock` mid-operation.

`testrepo.rs` (`#[cfg(test)]`) lifts `git_in`/`repo_with_commit` out of `diff.rs` and adds `repo_with_bare_remote`, so fetch/pull/push are tested end to end **with no network**.

### 5. Frontend
- `lib/gitBranch.ts` / `lib/gitRemote.ts` — the IPC surface, listening **before** invoking so no progress event is lost (the `ptySession.ts` ordering).
- `store/gitStore.ts` — `branchState`, `op`, `opError`, `notice`, and the new actions. While an op runs, refreshes return early and one runs on completion: a large fetch writes many objects and would otherwise re-fire the 300 ms watcher debounce repeatedly.
- `components/BranchStatus.tsx` — the status-bar cluster; handles no-upstream, ahead-only, behind-only, in-sync, detached and unborn HEAD.
- `components/BranchMenu.tsx` — upward popover: filter, `Branches` / `Remote branches` sections, per-row rename/delete, *New branch…*, full keyboard navigation.
- `components/Modal.tsx` — the app's first modal primitive: a `div` with `role="dialog" aria-modal="true"`, not `<dialog>` (`showModal` is unreliable under jsdom).
- `components/GitDialogs.tsx` — new branch, dirty-switch choice, delete confirm, rename, and the op-error modal.
- Retry in terminal: `layoutStore.requestShellCommand` reveals the region and queues the command; `TerminalView` gains `onReady` so `TerminalPanel` can write it to `shell-main` once attached (no `pty_exists` polling). Written **without** a trailing newline — an escape hatch should not execute by surprise.

## Acceptance criteria
- [ ] The status bar shows the current branch and `↑ahead ↓behind` against its upstream, and updates from a branch switch made in the bottom shell with no button press.
- [ ] The branch menu opens upward, filters as you type, lists locals before remote-only branches, and is fully keyboard-navigable (↑/↓/Enter/Esc).
- [ ] Picking a local branch switches to it; picking a remote-only branch creates a local tracking branch; picking a remote branch that already has a local switches to the local one.
- [ ] New branch validates the name, offers a base ref, and switches to the result.
- [ ] Rename and delete work; deleting an unmerged branch is refused until the force confirm is accepted.
- [ ] Switching with uncommitted changes prompts Bring or Leave. Leave stashes with a marker and reports it; returning to that branch restores the stash **with staging intact**.
- [ ] Fetch, Pull and Push stream git's own progress into the status bar and can be cancelled mid-flight.
- [ ] With no upstream the button reads Publish branch and sets one; a diverged push fails with git's stderr in the modal, which offers Copy and Retry in terminal.
- [ ] A second mutating operation started while one is running is refused, not queued.
- [ ] A repo needing credentials fails fast with an actionable message instead of hanging.
- [ ] Detached HEAD and an unborn HEAD both render without breaking the cluster.
- [ ] Verified on macOS, Linux and Windows.

## Known limits, accepted for this part
- **Cancel does not reach a grandchild.** Killing git does not kill an `ssh` it spawned, so a cancelled op over ssh can leave that child holding the pipe; the reader thread then never sees EOF and the git child is not reaped. The UI always recovers (the cancel path reports the outcome itself), but a zombie per cancelled ssh op is possible on Unix.
- **A GUI credential helper can still block.** `GIT_TERMINAL_PROMPT=0` and ssh `BatchMode` cover the terminal prompts; a configured GUI askpass is deliberately left working, which means Windows' `git-credential-manager` can pop its own window that Cancel cannot reach. Verify the fail-fast criterion on Windows against an **HTTPS** remote specifically, not only ssh.
- **Untracked files count as changes**, so a repo with a stray unignored file prompts Bring/Leave on every switch even though plain `git switch` would carry it. Deliberate: GitHub Desktop counts them too, and `--include-untracked` is what "leave my changes" has to mean.

## Risks specific to this part
- **Ahead/behind orientation** — `--left-right --count` puts the upstream side first; tested in both directions.
- **`stash pop --index` can conflict** on auto-restore; the stash is left in place and the warning goes to the modal, not the status bar, because a conflicted pop writes markers into the tree. Real conflict resolution is Part 6.
- **The op slot must be released on every path.** A leaked slot refuses every later mutating operation until the app restarts, and the paths that leak are the ones nobody exercises: a join error, a panic in the spawn helper. `with_op_lock` releases before inspecting its result; `git_remote_op` releases on both of its failure branches.
- **Watcher storm during a fetch** — a big fetch re-fires the debounce repeatedly; mitigated by the store's op guard plus `--no-optional-locks`.
- **Credential hangs** — `GIT_TERMINAL_PROMPT=0`, ssh `BatchMode`, and Cancel as the backstop. A GUI askpass (macOS keychain) is deliberately left working.
- **Localized progress text** is displayed verbatim and never parsed; the rule only holds as long as nobody later reaches for a percentage.
- **A 24px status bar is cramped** for six controls plus a progress line: the progress line needs a hard ellipsis budget, and the popover must open upward because `#root` is `overflow: hidden`.
