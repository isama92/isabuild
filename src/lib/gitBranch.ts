// Thin wrapper over the branch Tauri commands. Same split as lib/gitStatus:
// this module knows the IPC surface, the store decides when to call it. Types
// mirror the Rust structs in src-tauri/src/branch.rs.

import { invoke } from "@tauri-apps/api/core";

export interface LocalBranch {
  name: string;
  /** Configured upstream, e.g. `origin/main`. Absent when there is none. */
  upstream?: string;
  /** Committer date of the branch tip, unix seconds. Sort key for the menu. */
  committerDate: number;
  headShort: string;
}

export interface RemoteBranch {
  /** Short name including the remote, e.g. `origin/feature`. */
  name: string;
  remote: string;
  /** The branch part, e.g. `feature`. May contain slashes. */
  branch: string;
  /**
   * True when a local branch of the same name already exists, so picking this
   * row should switch to the local branch rather than create a second one.
   */
  hasLocal: boolean;
  committerDate: number;
  headShort: string;
}

export interface BranchState {
  /** Current branch, or null on a detached HEAD. */
  current: string | null;
  /** Short sha when HEAD is detached. */
  detachedSha: string | null;
  /** True when HEAD points at a branch that has no commits yet. */
  unborn: boolean;
  upstream: string | null;
  /**
   * True when an upstream is configured but its ref no longer exists: the remote
   * branch was deleted and the tracking ref pruned.
   *
   * `upstream` stays populated in that state (it comes from config, not from the
   * ref), so without this flag `↑0 ↓0` would read as "in sync" for a branch whose
   * remote copy is gone.
   */
  upstreamGone: boolean;
  /**
   * True when the upstream really is a remote-tracking branch (its ref is under
   * `refs/remotes/`). `git branch --track topic main` gives a valid upstream that
   * is a *local* branch, which the sync controls must not describe as living on a
   * remote or offer to push.
   */
  upstreamOnRemote: boolean;
  /** Remote that fetch/push targets, or null when there is no usable one. */
  remote: string | null;
  ahead: number;
  behind: number;
  /** FETCH_HEAD mtime in unix seconds; null when never fetched. */
  lastFetch: number | null;
  locals: LocalBranch[];
  remotes: RemoteBranch[];
}

/** What to do with uncommitted changes when switching away from a branch. */
export type DirtyPolicy = "bring" | "leave";

export interface SwitchTarget {
  /** The local branch to be on afterwards. */
  branch: string;
  /**
   * Set when `branch` does not exist locally yet: create it tracking this
   * remote-tracking ref (e.g. `origin/feature`).
   */
  track?: string;
}

export interface SwitchOutcome {
  branch: string;
  /** Branch whose changes were stashed on the way out, if any. */
  stashedFrom: string | null;
  /** True when changes previously left here were restored. */
  restored: boolean;
  /** Non-fatal problems; the switch itself succeeded. */
  warnings: string[];
}

/** Branch, upstream, ahead/behind and both branch lists, in one round trip. */
export function getBranchState(repoRoot: string): Promise<BranchState> {
  return invoke<BranchState>("git_branch_state", { repoRoot });
}

/**
 * Switch branch. The backend does the whole sequence (stash if `leave`, switch,
 * restore anything left on the target) as one operation, so it cannot be
 * interrupted midway.
 */
export function switchBranch(
  repoRoot: string,
  target: SwitchTarget,
  policy: DirtyPolicy,
): Promise<SwitchOutcome> {
  return invoke<SwitchOutcome>("git_switch_branch", {
    repoRoot,
    target: { branch: target.branch, track: target.track ?? null },
    policy,
  });
}

/** Create `name` (from `base`, or the current HEAD) and switch to it. */
export function createBranch(repoRoot: string, name: string, base?: string): Promise<void> {
  return invoke<void>("git_create_branch", { repoRoot, name, base: base ?? null });
}

/** Delete a local branch. Without `force`, git refuses an unmerged one. */
export function deleteBranch(repoRoot: string, name: string, force: boolean): Promise<void> {
  return invoke<void>("git_delete_branch", { repoRoot, name, force });
}

export function renameBranch(repoRoot: string, from: string, to: string): Promise<void> {
  return invoke<void>("git_rename_branch", { repoRoot, from, to });
}

/**
 * `null` when `name` is usable as a new branch, otherwise the reason it is not.
 * A rejected name resolves — it is an answer, not a failure.
 */
export function validateBranchName(repoRoot: string, name: string): Promise<string | null> {
  return invoke<string | null>("git_validate_branch_name", { repoRoot, name });
}
