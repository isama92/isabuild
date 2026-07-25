# Plan 9: the "No changes" flicker

## Goal
On a clean repository the Status panel's "No changes" text flickers. Stop it, and stop the three
things underneath it that make it a continuous strobe rather than a single blink.

Out of scope: reducing the *number of directories the OS watches* (Part 11), the same flicker family
arriving from the error arm (a transient `index.lock` failure still swaps rows for an error and back),
and collapsing `refreshAll`'s three IPC round trips into one command.

## The problem this part is really solving
Three independent defects compose into one symptom.

1. **A transient value in a render gate.** `gitStore.refresh()` opened with an unconditional
   `set({ phase: "loading" })`, and `StatusPanel` rendered "No changes" only when
   `phase === "ready"`. Every refresh therefore dropped the panel into the file-groups arm, where all
   three groups early-return `null` for empty arrays: a blank body for the length of the read.
   A *dirty* repo never showed this, because its stale rows are not gated on the phase and stayed on
   screen. The clean repo was the only case that regressed, which is why it survived review, and why
   the existing test missed it (it presets `phase: "ready"` instead of driving a real refresh).

2. **A watcher with no path filtering.** `watcher.rs` watched the root recursively and discarded the
   debounced batch entirely, checking only `res.is_ok()`. `src-tauri/target/` (12 GB in this
   checkout) and `node_modules/` (324 MB) are inside that watch, so under `npm run tauri dev` cargo
   and vite generate a permanent event stream, and `notify-debouncer-mini` re-emits `AnyContinuous`
   every ~300 ms indefinitely for a path that keeps being touched. Every one of those paths is
   gitignored, so `git status` keeps answering "clean": a permanently clean tree with a permanent
   event stream.

3. **No coalescing.** Each event ran `refreshAll`, three awaited reads and about 13 git subprocesses,
   with nothing stopping overlapping events from each starting their own cascade.

## Decisions

| Decision | Choice |
|---|---|
| The render fix | **Delete `"loading"` from `GitStatusPhase`** rather than write a better condition. `phase` becomes the *settled* outcome (`idle` / `ready` / `error`), so no future reader can gate on an in-flight value. The type has no external importers and no test asserted `"loading"`, so this costs nothing. |
| A refreshing indicator | **None.** No `refreshing` boolean either: nothing would render it, the placeholder gates on `phase === "idle"`, and at the observed event rate a spinner *is* the strobe. An honest one needs a latency threshold and a minimum dwell time, which is its own decision. |
| First load | **"Loading changes…"** while nothing has been read yet, which also fixes today's blank first-mount body. Not a refreshing indicator: `phase` never returns to `idle` once settled, so it cannot alternate with "No changes". |
| A read that fails, then retries | **Keep the error on screen.** `error` is only cleared on success, so error to data is atomic. Showing the placeholder instead would alternate error and placeholder on a genuinely broken repo: the identical bug in a different costume. |
| Ignore filtering | **Ask git**: batched `git check-ignore --stdin -z`, cached, plus explicit `.git` rules (git does not report anything under `.git` as "ignored"). Chosen over a hardcoded deny-list, which is wrong for repos that track those names, and over the `ignore` crate, which would be a second implementation of gitignore semantics able to drift from the binary the rest of the app defers to. |
| Cache shape | Verdicts for **the leaf and its whole ancestor chain**, keyed by repo-relative slug. Asking only about leaves teaches nothing reusable (every churn event has a different leaf); asking about ancestors learns `src-tauri/target` is ignored once, after which every event beneath its 2,915 directories is two hash lookups. Sound because git cannot re-include a file under an excluded parent. |
| `AnyContinuous` | **Not filtered by kind.** After path filtering it is nearly free, and dropping it would suppress refreshes *entirely* for a tracked file being written continuously (a long checkout, an LFS smudge, a build writing a tracked generated file) for the whole duration of the operation the user is watching. |
| The notify `Err` arm | **Refresh and flush the cache**, where it was previously dropped silently. On Linux the realistic error is an inotify queue overflow, which means events were lost, and today that leaves a stale sidebar with no recovery path at all. |
| Coalescing location | **`refreshAll` only**, in closure state beside `mutate`, following `runOp`'s closure-local `opId`. A promise slot in the store would be blanked by `resetForProjectSwitch` mid-cascade, letting an overlapping one start: the opposite of the point. |
| The coalescing contract | **`refreshAll()` always resolves after a status read that began after the call.** A late caller joins the *trailing* run, never the in-flight promise, so a mutation awaiting it can never be handed a read from before its own write. |
| `.isabuild-save-*` | **Both** a watcher rule and a `parse_porcelain_v2` rule, because they fix different failures: the watcher stops up to 4 events per keystroke burst, while the parser stops the phantom untracked row that any *legitimately* triggered read produces if it lands in the ~1 ms window while the temp file exists. Adding it to isabuild's own `.gitignore` fixes neither, since the user's repos will not have it. |

## Deliverables

### 1. Frontend: `src/store/gitStore.ts`, `src/components/StatusPanel.tsx`
`GitStatusPhase` narrows to `"idle" | "ready" | "error"`; `refresh()` no longer touches `phase` on the
way in. `refreshAll` keeps its operation guard and then awaits `requestCascade()`, which runs the
three reads when nothing is in flight and otherwise chains at most one trailing run back through the
action, so an operation starting mid-cascade still suppresses the queued read.

`StatusPanel`'s 4-deep ternary becomes a local `changesBody()` with guard clauses in priority order:
error, then `idle` (the placeholder), then empty, then the groups. The nesting is part of why the hole
was invisible in review, so flattening it is part of the fix.

### 2. Rust: `src-tauri/src/watchfilter.rs` (new)
`WatchFilter::should_refresh(paths)`, five passes, cheapest first, no process before pass 5 and
pass 5 skipped in the common cases:

0. Path to slug via component-wise `strip_prefix`. Unmappable means refresh.
1. Pure rules: the `.git` allow-list and drop-list, and the save-temp prefix.
2. A `.gitignore` write refreshes and invalidates, *unless* a strict ancestor is already known to be
   ignored (without that guard, `npm install` writing a `.gitignore` into every package under
   `node_modules/` becomes a new storm in the same shape as the one being fixed).
3. Apply invalidation, then early-return. In that order, so a batch holding both a real change and a
   `.gitignore` edit cannot leave a stale cache. This is also why any batch containing `.git/index`
   refreshes with zero subprocesses.
4. Cache fast path: an ancestor known to be ignored drops; an ancestor known *not* to be ignored
   decides nothing.
5. One batched `check-ignore`, then decide from the **leaves only** (`pending` holds ancestors like
   `src`, which are legitimately not ignored and would force a refresh for an ignored `src/foo.log`).

The `.git` allow-list is derived from what the backend actually reads (`merge_state`, `branch_state`,
`run_status`): `index`, `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `MERGE_MSG`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`, `BISECT_LOG`, `packed-refs`, `shallow`, and anything under `refs/`, `rebase-merge/`,
`rebase-apply/`, `sequencer/`. The rule for future additions: allow what git writes at most once per
user action, drop what it writes per object or per lock.

### 3. Rust: `src-tauri/src/git.rs`
`check_ignored(root, slugs)`, writing its NUL-framed input **from a separate thread**: git answers as
it reads, so writing a large batch while nothing drains stdout deadlocks once the pipe buffer fills
(4 KB on Windows). Exit 0 and exit 1 are both answers; 128 is an error, and an error means "refresh",
because a missed refresh is a silently wrong sidebar the user cannot force to update.

No `--no-index`: by default `check-ignore` consults the index, so a force-added tracked file is
reported as *not* ignored, which is what `git status` does too.

Also `status_at(root)`, which skips the discovery `rev-parse` and falls back to `resolve_repo_root`
only on the failure path, so the `NotARepo` message stays as it was; and untracked
`.isabuild-save-*` records dropped in `parse_porcelain_v2`.

### 4. The two adjacent bugs
- `useRepoWatch` never called `refreshMerge()` on mount, so a project opened mid-merge showed no
  merge banner until an unrelated file change happened to fire the watcher, and that banner is the
  only route to Continue and Abort.
- A status read in flight across a project switch resolved *after* the reset and wrote the previous
  repo's root and file list back into the store, after which every refresh read that root: the panel
  showed the wrong repo indefinitely. Guarded with a generation counter bumped by
  `resetForProjectSwitch`, checked by all three reads before they write. A counter rather than a
  comparison against `projectStore`, because `projectStore` imports `gitStore` and the reverse would
  be a cycle.

## Known limits
- **The OS-level watch still covers the whole tree.** Filtering removes the *events*, not the
  watches. On Linux `RecursiveMode::Recursive` installs one inotify watch per directory: 4,923 here,
  of which 279 matter. Fine against this machine's 524,288 limit, but distros still shipping the old
  8,192 default sit at 60% for a single project. macOS and Windows use one stream per root and are
  unaffected. Part 11.
- **A linked worktree or a submodule is not covered**, and was not before either: when the project's
  `.git` is a *file*, the index, HEAD and refs live outside the watch root, so staging never triggers
  a refresh. The new `.git` rules read as though this were handled, hence this note.
- **A force-added tracked file under an ignored directory** has its refresh delayed to the next real
  event once that directory is cached as ignored. Correct on a cold cache. This is the one place the
  filter knowingly disagrees with `git status`, and it has a named characterisation test so nobody
  "fixes" it into a per-path query that defeats the cache.
- **A global `core.excludesFile` edited while the app runs** is not detected: it is outside the watch
  root. The stale window ends at the next `.gitignore` edit or project switch.
- An awaited mutation can now wait up to two cascades, by construction of the freshness contract.
  The only awaited one is the branch delete dialog, which today *competes* with up to three
  concurrent cascades for the same git binary, so it is unlikely to be slower in practice.

## Acceptance criteria
1. On a clean repo, "No changes" does not move, including while cargo or vite are rebuilding into
   `target/`. This is the criterion the part exists for.
2. An idle clean repo with a build running emits **no** `repo://changed`, where it previously emitted
   roughly 3 per second.
3. Touching a tracked file produces exactly one refresh, promptly; staging it in the bottom terminal
   moves the row to Staged Changes. The filter did not go too far.
4. Editing `.gitignore` to stop ignoring a populated directory makes those files appear.
5. Typing in a diff window shows the file as modified and never shows a `.isabuild-save-*` row.
6. A first launch, and every project switch, shows "Loading changes…" and never "No changes" before
   the first read lands. Switching back and forth rapidly never leaves the previous repo's files on
   screen.
7. A project opened mid-merge shows the merge banner immediately.
8. A directory that is not a repository shows its error, and the error stays put across retries.
9. Overlapping watcher events run one cascade plus at most one trailing read, and the state after the
   burst is fresh.
10. Both suites green, clippy clean, and the Rust suite green with no global or system git config.
