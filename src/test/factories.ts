// Builders for the wider store shapes, so a test can state the one or two fields
// it cares about instead of restating a struct.
//
// Worth having for `MergeState` in particular: Part 7 gave it four more fields
// (where a rebase is going, how far through it is, whether it has a commit to
// skip), and four test files were each spelling out all of them to assert on one.

import type { MergeKind, MergeState, OpProgress } from "../lib/gitMerge";

/**
 * A `MergeState` with everything absent, overridden by `fields`.
 *
 * `canSkip` defaults to what the kind implies — the replaying families have a
 * `--skip`, a merge does not — because a test that sets `kind: "rebase"` and gets
 * `canSkip: false` would be asserting against a state the backend never produces.
 */
export function mergeState(kind: MergeKind, fields: Partial<MergeState> = {}): MergeState {
  return {
    kind,
    mergingRef: null,
    onto: null,
    subject: null,
    progress: null,
    canSkip: kind === "rebase" || kind === "cherryPick" || kind === "revert",
    ...fields,
  };
}

export function opProgress(current: number, total: number): OpProgress {
  return { current, total };
}
