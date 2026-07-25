# Plan 7: Full 3-pane merge editor

## Goal
Resolve a conflict by reading what each side actually did, not just the regions git
could not decide — ours | result | theirs on CodeMirror 6, with the result pane
editable. And, since the index stages are populated identically for a rebase,
cherry-pick or revert, drive those to completion too instead of naming them and
stopping.

Part 6's conflict view was deliberately the cheap version: read-only React blocks
over the `<<<<<<<` markers git wrote, with Accept ours / theirs / both per block.
It could not show a change only one side made, and it could not let anyone type.

Out of scope: a base pane, filler-block pane alignment, and cross-restart
persistence (Part 8).

## The problem this part is really solving
**The source of truth flips.** Everything in Part 6 keys off markers in the
working-tree file. `git ls-files -u` plus the stage blobs are a different truth
about the same conflict, and our diff will not split hunks exactly the way git's
xdiff does — a rebuild can produce two conflicts where `git merge` wrote one.
Every decision below falls out of that.

## Decisions

| Decision | Choice |
|---|---|
| Result pane source | **Rebuilt from index stages 1/2/3**, with a divergence guard: when the file on disk is not what git wrote, the window says so and offers [Use the file on disk] or [Start over from the merge]. |
| Divergence test | Reproduce git's own merge with **`git merge-file -p`** over the three stage blobs and compare against disk. Compared against *git's* output, not our rebuild, precisely because our hunk boundaries may differ — the other way round the banner would cry wolf on every open. Label-insensitive and LF-normalised, since marker labels are display-only (Part 6's rule) and the working file may be CRLF while blobs are LF. |
| Writing | The buffer lives **in memory until every conflict is decided**; then it is written once and staged. No Save button, no debounce, and none of the diff window's adopt-guard machinery — there is no stream of our own writes to distinguish from someone else's. |
| Undecided conflicts in the buffer | **Real marker text**, styled by decorations. So "resolved" stays git's own definition — zero markers — and `parse_conflicts` keeps doing the counting *and* the write guard. A widget placeholder would have needed a second definition maintained in the frontend, and the two would eventually disagree. |
| Chunk model | Computed in **Rust** with the `similar` crate: a pure `chunks(base, ours, theirs)` with fixture tests, the same shape as every other parser in the crate. |
| Chunk positions | `serialize_result` also returns each chunk's span in the buffer (`PlacedChunk`). **One serialiser, one authority**: re-deriving the layout in TypeScript would be a second thing to keep in step, and a drift puts the arrows on the wrong lines. The frontend maps those spans through every CodeMirror transaction, but computes the *newline placement* of each edit from the live document at apply time — nothing about a separator is remembered, because resolving a neighbouring chunk can delete the newline a remembered answer counted on. |
| Chunk actions | **Every chunk is actionable.** A change only one side made is already applied, and can be reverted to base or swapped to the other side. A side a chunk already holds is never offered, so no button is a no-op. |
| Alignment | **Proportional scroll sync**, no filler blocks. Next/previous conflict is the primary way to move. |
| Highlighting | `@codemirror/language-data`, lazily imported per file type — the CodeMirror equivalent of `lib/diffLanguage.ts` picking from Monaco's registry. |
| Part 6's marker pane | **Replaced.** `ConflictBlocks.tsx`, `merge::resolve_conflict` and `resolved_text` are gone. `parse_conflicts`, `content_revision` and `resolve_path` stay. |
| Op scope | **Rebase, cherry-pick and revert are driven**: continue / skip / abort per operation. One `git_op` command takes an *action*; `merge::run_op` reads the state itself and derives the argv, so a stale frontend cannot send `rebase --abort` at a merge. Skip is destructive, so it is confirmed; a merge has no `--skip`, so the button is **absent** rather than disabled. |

## What was built

### Rust
- **`src-tauri/src/mergechunks.rs`** (new) — `ChunkKind {Unchanged, Ours, Theirs, Agreed, Conflict}`,
  `chunks()`, `serialize_result() -> (String, Vec<PlacedChunk>)`,
  `equivalent_ignoring_marker_labels()`. Chunks tile the base exactly, so the
  serialiser walks the list once and the panes need no second index. Changes with
  no common base line between them become **one** chunk (the diff3 grouping rule),
  so two touching edits are a single decision rather than two the user has to keep
  consistent by hand.
- **`merge.rs`** — `parse_unmerged` for `ls-files -u -z`, `conflict_stages` (one
  round trip: stages, chunks, buffer, disk text, labels, revision, `diverged`),
  `git_merge_file`, `write_resolved`, and `run_op`/`OpAction`. `MergeState` gains
  `onto`, `subject`, `progress` and `can_skip`.
- **`commands.rs` / `lib.rs`** — `git_conflict_stages` (a read), and
  `git_write_resolved` / `git_op` under `with_op_lock`.
- **`testrepo.rs`** — `repo_with_rebase_conflict`, `repo_with_cherry_pick_conflict`,
  `rev_parse`.

### Frontend
- **`src/merge/MergePanes.tsx`** + **`codemirrorSetup.ts`** — the only modules that
  touch CodeMirror, mirroring `DiffPane`/`monacoSetup` for Monaco. Three views,
  ours/theirs read-only, chunk tints and marker decorations, gutter arrows, a
  toolbar acting on the chunk under the cursor, proportional scroll sync.
- **`src/lib/mergeChunks.ts`** — types mirroring the Rust structs, the live marker
  count, `trackedRanges`/`replacementText` (the offset arithmetic), and navigation.
- **`src/lib/paneScroll.ts`**, **`src/lib/cmLanguage.ts`** — pure, tested.
- **`MergeWindow.tsx`** — rewritten around the buffer: the divergence banner, the
  single write, the reload that must not clobber a touched buffer, and the
  confirm-on-close. **`capabilities/merge.json`** gains `core:window:allow-destroy`
  for that last one.
- **`MergeBanner.tsx`**, **`GitDialogs.tsx`** (`AbortOpDialog`, `SkipCommitDialog`),
  **`gitStore.ts`** (`concludeOp`).
- **`src/test/factories.ts`** — a `MergeState` builder, so four test files state the
  one field they care about.

## Acceptance criteria
- [x] Three panes from the index stages; ours and theirs read-only, the result editable.
- [x] Non-conflicting changes are auto-applied and still reviewable, with arrows to revert or swap them.
- [x] A conflict resolves to ours / theirs / both / base, and the arrows keep hitting the right lines after the buffer has been edited above them.
- [x] The file is written once and staged the moment the last marker goes; text with a marker left is refused by the backend.
- [x] A file changed since git wrote it is detected, and the user picks which version to open.
- [x] A fresh conflict is **not** flagged as diverged, in the default and `diff3` conflict styles.
- [x] Line endings survive: a CRLF file is not divergence, and the write restores CRLF.
- [x] A rebase, cherry-pick and revert are named with progress, and continue / skip / abort drive them.
- [x] Skip is absent for a merge and confirmed for the others.
- [x] Closing with undecided conflicts asks before dropping the buffer.
- [x] A reload does not clobber a touched buffer; it says the file moved and offers to reload.
- [ ] Verified on macOS, Linux and Windows. *(Linux only so far.)*

## Known limits, accepted for this part
- **No base pane.** The merge base informs the chunk classification but is never
  shown, so a diff3 conflict's base section is not visible. The buffer always
  writes two-way markers whatever `merge.conflictStyle` says — which is a display
  difference only, since a written file has no markers at all.
- **No filler alignment**, so the panes drift apart in a long file.
- **The buffer is memory-only until fully resolved**, so a crash mid-resolution
  loses it. The confirm-on-close covers the ordinary path.
- Part 6's marker-parser limits carry over: a file containing literal marker-like
  lines, and a raised `conflict-marker-size`.
- A path with fewer than two content stages, or a binary one, still takes a
  whole-file decision; the window renders that rather than an empty editor.
- **No progress counter for a cherry-pick or a revert.** The sequencer keeps only a
  `todo` of the picks still to do — including the one it is stuck on — and writes no
  `done` file (verified on git 2.53), so "N of M" cannot be derived from it without
  counting commits since `sequencer/head`. A rebase does report progress, from
  `rebase-merge/msgnum`; the banner reads fine without one either way.
- **A gutter arrow cannot be clicked in a jsdom test.** CodeMirror resolves which
  line a gutter click belongs to from `getBoundingClientRect()`, which is all
  zeros there. The arrows' presence is asserted, and the apply path they share with
  the toolbar is driven through the toolbar; clicking one is a manual check.

## Risks
- **Our chunking versus git's xdiff.** If `diverged` fired on ordinary conflicts the
  feature would be dead on arrival. The defence is comparing against
  `git merge-file`'s output rather than our own rebuild, pinned by
  `a_file_git_just_wrote_does_not_look_diverged` and its `diff3` twin.
- **`git merge-file` exits non-zero by design** — its status is the count of
  conflicts. Reading that as failure would make every file look diverged.
- **Deleting `resolve_conflict` is a contract change**: the command, the store
  action, the pane and their tests had to go together.
- **Driving a rebase is more dangerous than driving a merge.** `--skip` drops a
  commit's changes and `--abort` rewinds; both are confirmed, and the argv comes
  from a freshly read state rather than from the frontend.
