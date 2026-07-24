// Pure presentation helpers for the branch UI.
//
// They live here rather than beside the components for two reasons: the eslint
// react-refresh rule wants component files to export only components, and these
// are the parts worth unit-testing on their own.

import type { BranchState, LocalBranch, RemoteBranch } from "./gitBranch";

/** Case-insensitive substring match, the rule GitHub Desktop's filter uses. */
function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * The branch menu's two sections for a given filter query.
 *
 * A remote branch that already has a local counterpart is dropped: it is the
 * same branch listed twice, and the local row is the one that can be switched to
 * directly. That is also why every surviving remote row needs `track` when
 * picked — see BranchStatus.
 */
export function filterBranches(
  state: BranchState,
  query: string,
): { locals: LocalBranch[]; remotes: RemoteBranch[] } {
  const trimmed = query.trim();
  return {
    locals: state.locals.filter((b) => trimmed === "" || matches(b.name, trimmed)),
    remotes: state.remotes.filter(
      (b) => !b.hasLocal && (trimmed === "" || matches(b.name, trimmed)),
    ),
  };
}

/**
 * Starting points for a new branch, the one you are on first. Remote branches are
 * included because "branch off what origin has" is a normal thing to want before
 * pulling.
 *
 * Two edge states matter here:
 * - **Unborn HEAD** (a repo with no commits): there is nothing to branch from at
 *   all, so this is empty and the caller must create with no start point —
 *   `git switch -c x main` fails when `main` has no commit, while a bare
 *   `git switch -c x` works fine.
 * - **Detached HEAD**: the sha leads, so "where I am now" stays offerable.
 *   Without it the dialog would silently base the branch off some unrelated
 *   local branch.
 */
export function baseOptions(state: BranchState): string[] {
  if (state.unborn) return [];
  const locals = state.locals.map((b) => b.name);
  const here = state.current ?? state.detachedSha;
  const ordered = here ? [here, ...locals.filter((name) => name !== here)] : locals;
  return [...ordered, ...state.remotes.map((b) => b.name)];
}

/**
 * How stale the ahead/behind counts are, for the Fetch tooltip.
 *
 * `now` is passed in rather than read here because a component may not call
 * `Date.now()` during render — it is impure, and the value would go stale the
 * moment it was rendered. `null` means it has not been sampled yet (the caller
 * samples on hover/focus, so no timer is needed); the result is then `null` too
 * and the caller simply omits the age.
 */
export function fetchAgeLabel(lastFetch: number | null, now: number | null): string | null {
  if (lastFetch === null) return "never fetched";
  if (now === null) return null;
  const seconds = Math.max(0, Math.floor(now / 1000 - lastFetch));
  if (seconds < 60) return "fetched just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `fetched ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `fetched ${hours}h ago`;
  return `fetched ${Math.floor(hours / 24)}d ago`;
}

/** What the branch button shows: the branch, or a detached/unborn HEAD. */
export function branchLabel(state: BranchState): string {
  if (state.current !== null) return state.current;
  if (state.detachedSha !== null) return `HEAD @ ${state.detachedSha}`;
  return "no branch";
}
