# Plan 6: Merge conflicts MVP

## Goal
Start a merge from the UI, understand a conflicted repository at a glance, resolve every kind of
conflict git can produce without dropping into the bottom shell, and finish or abandon the merge.

This is not a hypothetical state: the app can already *enter* a conflict it cannot leave. A
conflicting `pull` (Part 5) writes markers into the working tree, `stash pop --index` on a branch
return can conflict, and `git.rs` collapses every one of them into a single `!` row with no kind and
no action.

Out of scope for this plan: the 3-pane merge editor (Part 7), driving a rebase/cherry-pick/revert to
completion, `--no-ff`/`--squash`/`--ff-only` merge options, hand-editing inside the merge window, and
cross-restart persistence (Part 8).

## Decisions

| Decision | Choice |
|---|---|
| Conflict UI | A **new `merge-*` window**, one per conflicted file, on a third Vite entry (`merge.html`) with its own `capabilities/merge.json`. Part 7 grows the 3-pane CodeMirror editor *inside this window*, rather than putting conflict logic into the Monaco diff window and tearing it out again. |
| Pane rendering | **Plain React blocks, read-only.** Markers are parsed in Rust; the pane renders context lines plus one block per conflict with its own button row. The single-pane marker view is replaced in Part 7 whatever it is built on, so the cheap version wins — and it needs no editor shim under jsdom. Hand-editing stays available through the diff window and the terminal. |
| Merge entry point | **Per-row action in `BranchMenu`**, beside the existing rename/delete affordances: "Merge into `<current>`". A remote-only row merges the tracking ref directly (`git merge origin/main`), which is what its checkout-less equivalent would mean. |
| State scope | `MERGE_HEAD` (a `git merge`, and a merge-style conflicting `pull`) **plus** "unmerged paths, nothing in progress" — the conflicted stash pop from Part 5, where resolve-and-add is the whole job and there is nothing to continue. |
| …and the states we do not drive | A rebase, cherry-pick or revert in progress is **detected and named**, with Continue/Abort disabled. Their continue/abort argv differs enough to deserve its own step, and driving them with merge argv would be worse than saying so. Reachable today because Part 5's bare `pull` honours `pull.rebase`. |
| Continue | `git merge --continue` with **`GIT_EDITOR=true`**, committing git's own generated `MERGE_MSG`. This is a correctness requirement, not only a UX choice: `git_command` sets `Stdio::null()`, so a launched editor is a subprocess that can never return. The same applies to `git merge` itself, which opens an editor for a real merge commit — hence `--no-edit`. |
| Marking resolved | **Auto-add when the last marker goes.** "No conflict markers left" is git's own definition of resolved; the row moving to *Staged Changes* is the confirmation. Decided in the backend, in the same call that rewrites the file, so it cannot half-happen. |
| Odd conflicts | **Whole-file choices in the panel.** The `u XY` code becomes a `ConflictKind`, and delete/modify, one-sided add, both-deleted and binary conflicts each get their own per-file buttons. Without this a pull that deletes a file you edited is a dead end: there are no markers to accept, so the merge could never be continued from the UI. |
| Merge banner | A **strip atop the Status panel**: what is merging into what, how many conflicts remain, Continue and Abort. Directly above the rows it describes, and it has room for a sentence — which a 24px status bar does not (Part 5's plan already called that bar cramped). |
| Abort | `git merge --abort` behind a confirm dialog: it discards resolutions the user has just made by hand. |
| Dirty tree before a merge | Let **git refuse** and show its stderr in the existing `OpErrorDialog`. No pre-emptive stash: Part 5 prompts Bring/Leave because `git switch` genuinely can carry changes, whereas a merge that would clobber local work is git saying no — and paraphrasing that is how someone's edits get lost. |
| Op safety | Merge, continue, abort and every resolution go through the existing `GitOps` lock via `with_op_lock`, so a resolution cannot interleave with a switch or a pull. Reads stay on `git_read_command`. |
| Naming the merged ref | `for-each-ref --points-at <MERGE_HEAD> --format=%(refname:short) refs/heads refs/remotes`, falling back to the short sha. **Never** parsed out of `.git/MERGE_MSG`: that is human-readable text, and CLAUDE.md forbids parsing it. |
| Marker labels | The text after `<<<<<<<` / `>>>>>>>` is **displayed verbatim and never used for logic**, the same rule Part 5 applies to progress lines. All logic keys off the fixed 7-character ASCII marker prefixes. |

## Deliverables

### 1. Rust: `src-tauri/src/git.rs` — conflicts become their own group
`GitStatus` gains `conflicts: Vec<ConflictEntry>`, and unmerged paths *leave* the `unstaged` group so
each is reported exactly once. `ConflictKind` comes from the `u XY` code, per git's documented table:
`UU` both modified, `AA` both added, `DD` both deleted, `AU` added by us, `UA` added by them,
`UD` deleted by them, `DU` deleted by us.

The letters were previously discarded, which is what made every conflict a dead end: `UU` has markers
to accept, `UD` has no text at all, and nothing downstream could tell them apart.

### 2. Rust: `src-tauri/src/merge.rs`
Same shape as the rest of the crate: pure, fixture-tested parsers with a thin shell-out layer.

- **State detection** — `merge_state(root)` → `MergeState { kind, merging_ref, conflicted }`, where
  `kind` is `none | merge | conflictsOnly | rebase | cherryPick | revert`. Detected from
  `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` plus the `rebase-merge`/`rebase-apply`
  directories — an interactive rebase paused between steps has no `REBASE_HEAD`, so the directory is
  the reliable signal. The git dir comes from `rev-parse --absolute-git-dir`, never assumed to be
  `<root>/.git`: in a linked worktree or a submodule that is a *file*.
- **Marker parser** — `parse_conflicts(text)` over LF-normalised text, returning each block's line
  span plus its `ours`, `base` and `theirs` sections. Handles the 2-way style and `diff3`/`zdiff3`
  (the `|||||||` base section, which "accept both" drops). A marker is at least 7 repeated marker
  characters followed by a space or end of line.
- **A half-edited block is shown but not resolvable.** A block missing its `=======` or its
  `>>>>>>>` is reported with `complete: false`: the file really does have an unfinished conflict in
  it and the user needs to see it, but there is no honest boundary between the sides. Guessing one
  wrote a `>>>>>>>` line back into the file — and then staged it, because a lone terminator starts
  no new block, so the recount read zero. The window withholds the accept buttons and says what is
  missing; `resolve_conflict` refuses.
- **`PathResolution::MarkResolved`** — `git add` and nothing else, offered by the merge window once
  a file has no markers left. The escape hatch for a file resolved *outside* the app, which the
  plan's own Known limits invite: git goes on reporting such a path as unmerged until something
  stages it, so without this a hand-resolved conflict sat in the Conflicts group forever with
  Continue disabled and the shell as the only way on.
- **Per-conflict resolution** — `resolve_conflict(root, path, index, choice, revision)` with `choice`
  in `ours | theirs | both`. `revision` is a content hash of the read the client acted on, and the
  check is load-bearing: the file is watched, and Claude Code in the main terminal can rewrite it
  between the read and the click, so without it a stale index rewrites the wrong hunk. Endings
  round-trip through `diff::detect_eol`/`apply_eol`; path safety and binary rejection reuse
  `diff.rs`'s `resolve_write` and `looks_binary`. Returns `ResolveOutcome { remaining, staged }`, and
  `remaining == 0` runs `git add -- <path>` in the same call.
- **Whole-file resolution** — `resolve_path(root, path, side)`: `keepOurs` and `keepTheirs` via
  `checkout --ours/--theirs -- <path>` then `add`, `acceptDeletion` via `rm -- <path>`. Only the
  sides that exist for that `ConflictKind` are offered.
- **Merge / continue / abort** — `merge(root, ref)` → `MergeOutcome { conflicted, output }`, plus
  `continue_merge` and `abort`. Local and fast, so these stay on the `Command::output()` path rather
  than the streamed one; the output is shown verbatim on failure.
- **The state is read *before* the merge too**, and a merge is refused outright when anything is
  already in progress. Without that, the conflict-versus-failure split is unsound: git refuses a
  merge that starts mid-merge without clearing `MERGE_HEAD`, so the state read afterwards reports
  the refusal as a successful conflicted merge — under the *previous* merge's name. Reachable
  whenever the frontend's state is stale, e.g. a merge started in the bottom terminal inside the
  watcher's 300 ms debounce.

### 3. Rust: commands, wiring, test helpers
`git_merge_state` is a read (blocking pool, no lock). `git_merge`, `git_merge_continue`,
`git_merge_abort`, `git_conflict_file`, `git_resolve_conflict` and `git_resolve_path` all go through
`with_op_lock`. Registered in `lib.rs`; the window-close handling needs no change, since it already
closes every non-`main` window, which covers `merge-*`.

`testrepo.rs` gains `repo_with_conflict` and `repo_with_delete_modify_conflict`, so every path above
is exercised against real git with no network.

### 4. Frontend
- `lib/fileWindow.ts` — the FNV-1a hash and Tauri label rules extracted from `lib/diffWindow.ts`,
  which is refactored onto it so `diff-*` labels stay byte-identical and the charset rule lives in
  one place. `lib/mergeWindow.ts` builds `merge-<slug>-<hash>` on top.
- `lib/gitMerge.ts` — the IPC surface; `store/gitStore.ts` gains `mergeState`, `conflicts` and the
  actions, reusing the existing `mutate` helper and its `opError` routing.
- `components/MergeBanner.tsx` — the Status-panel strip, including the honest read-only line for a
  rebase or cherry-pick in progress.
- `components/StatusPanel.tsx` — a **Conflicts** group above *Staged Changes*; a content conflict
  opens the merge window, a non-content one carries its whole-file buttons inline.
- `components/BranchMenu.tsx` — the per-row merge action, inside the existing keyboard navigation.
- `src/merge/MergeWindow.tsx` + `ConflictBlocks.tsx`, `merge.html`, `src/merge-main.tsx`, the
  `vite.config.ts` input, and `capabilities/merge.json` granting `core:default` plus
  `core:window:allow-close` only — the pane is read-only, so nothing needs the `destroy` that
  `diff.json` requires for its flush-then-close dance. The window follows `repo://changed`, keeps
  Esc/Ctrl+W, and renders a resolved state rather than closing itself when the last conflict goes.

## Acceptance criteria
- [ ] A branch row's merge action merges into the current branch; a clean merge just updates the status bar, a conflicting one leaves the app in a legible conflicted state.
- [ ] Conflicted files appear once, in their own **Conflicts** group, with the right kind.
- [ ] The banner names both sides and counts conflicts remaining; Continue is disabled until zero.
- [ ] Accept ours / theirs / both rewrites exactly that conflict, leaves the others alone, preserves the file's line endings, and stages the file when the last marker goes.
- [ ] `diff3`/`zdiff3` conflicts parse, and "accept both" drops the base section.
- [ ] Delete/modify, both-deleted, one-sided add and binary conflicts all resolve from the panel.
- [ ] Continue commits with git's own message and launches no editor; Abort restores the pre-merge tree after a confirm.
- [ ] A conflicting `pull` and a conflicted stash restore both land in this UI and can be finished.
- [ ] A rebase in progress is named and does not offer merge Continue/Abort.
- [ ] Resolving a file that changed on disk since it was read is refused with a reload message, not applied to the wrong block.
- [ ] A resolution started while another git operation runs is refused, not queued.
- [ ] Verified on macOS, Linux and Windows.

## Known limits, accepted for this part
- **A file containing marker-like lines** (a literal `<<<<<<<` at the start of a line — a test
  fixture about merge conflicts, most plausibly) will confuse this parser, as it does git's own
  tooling. Documented rather than defended against. The `complete` flag limits the damage: such a
  block usually has no matching separator, so it can be seen but not accepted.
- **`conflict-marker-size` above 7** parses, since a marker is "7 or more". A *raised* size means a
  run of 7 in the file's own content is no longer a marker to git while this still reads it as one —
  the same ambiguity, in the other direction.
- **No hand-editing in the merge window.** The pane is read-only by design; a resolution the buttons
  cannot express is made in the diff window or the terminal, and then **Mark resolved** in the merge
  window stages it. (git does not notice a hand-resolved file on its own — it reports the path as
  unmerged until something stages it — so the button is what keeps that route from being a dead end.)
- **Rebase, cherry-pick and revert are detected, not driven.**
- **Exotic conflicts** (rename/rename) fall back to whatever `checkout --ours/--theirs` says, with
  git's stderr surfaced verbatim rather than second-guessed.

## Risks specific to this part
- **The editor hazard is a hang, not a warning.** `git merge` and `git merge --continue` open
  `$EDITOR` for the commit message, and with `Stdio::null()` stdin that subprocess never returns.
  `--no-edit` and `GIT_EDITOR=true` are both required, and the tests assert neither command can
  inherit a real editor.
- **Index-based resolution against a live file.** The revision guard is the whole defence; without it
  a watcher-driven reload racing a click silently rewrites the wrong hunk.
- **The `unstaged` shape change is a contract change.** Everything that read unmerged rows out of
  *Changes* has to move in the same commit, or conflicts disappear from the panel entirely.
- **Auto-add hides a footgun**: staging happens the instant the markers go, so a file resolved wrongly
  is already staged. Mitigated by the row visibly moving to *Staged Changes*, with the diff window
  still there to inspect it.
- **`git rm` during a conflict deletes the user's file.** Offered only for the kinds where the
  deletion *is* the resolution, and labelled with what it does rather than as a generic discard.
