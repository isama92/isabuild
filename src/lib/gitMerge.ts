// Thin wrapper over the merge Tauri commands. Same split as lib/gitStatus and
// lib/gitBranch: this module knows the IPC surface, the store decides when to
// call it. Types mirror the Rust structs in src-tauri/src/merge.rs.

import { invoke } from "@tauri-apps/api/core";

/**
 * What the repository is in the middle of.
 *
 * `conflictsOnly` is real and reachable: a `stash pop` that would not reapply
 * leaves conflicted paths behind with no operation in progress, so there is
 * nothing to continue — resolving and staging is the whole job.
 *
 * `rebase`, `cherryPick` and `revert` are detected so they can be *named*. Their
 * continue/abort take a different command family, so this part reports them and
 * keeps its hands off.
 */
export type MergeKind = "none" | "merge" | "conflictsOnly" | "rebase" | "cherryPick" | "revert";

export interface MergeState {
  kind: MergeKind;
  /**
   * What is being merged in: a branch name where one points at MERGE_HEAD, else
   * a short sha. Null for the states that have no such ref.
   */
  mergingRef: string | null;
}

/** Half-open range of line indices into `ConflictFile.lines`. */
export interface LineRange {
  start: number;
  end: number;
}

export interface ConflictBlock {
  /** The `<<<<<<<` line. */
  start: number;
  /** One past the `>>>>>>>` line, or the end of the file if unterminated. */
  end: number;
  ours: LineRange;
  /** Present only in the diff3/zdiff3 conflict styles. */
  base: LineRange | null;
  theirs: LineRange;
  /** Text after `<<<<<<<`. Display only — never branch on it. */
  oursLabel: string;
  /** Text after `>>>>>>>`. Display only. */
  theirsLabel: string;
  /**
   * True when the block has both its `=======` and its `>>>>>>>`. A false one was
   * left half-edited by hand: it is shown, but its sides are not well enough
   * defined to accept, and the backend refuses to resolve it.
   */
  complete: boolean;
}

export interface ConflictFile {
  path: string;
  /** Every line, LF-normalised; a trailing newline is a final empty line. */
  lines: string[];
  blocks: ConflictBlock[];
  /** Hash of the bytes these lines came from; quote it back to resolve. */
  revision: string;
  binary: boolean;
}

export type ConflictChoice = "ours" | "theirs" | "both";

/**
 * A whole-file decision, for the conflicts with no merged text — plus
 * `markResolved`, which stages the working-tree file exactly as it is. That is the
 * escape hatch for a file resolved outside the app: git reports a path as
 * unmerged until something stages it, so without it a conflict fixed in the diff
 * window or the terminal would sit in the Conflicts group forever.
 */
export type PathResolution = "keepOurs" | "keepTheirs" | "acceptDeletion" | "markResolved";

export interface ResolveOutcome {
  /** Conflicts still in the file. */
  remaining: number;
  /** True when the file was staged, which happens exactly at `remaining === 0`. */
  staged: boolean;
}

export interface MergeOutcome {
  /** True when the merge stopped with conflicts rather than failing outright. */
  conflicted: boolean;
  /** git's own output, verbatim. */
  output: string;
}

/** Where a merge window points. Parsed from its own URL by `parseMergeParams`. */
export interface MergeParams {
  repoRoot: string;
  path: string;
}

/**
 * Read the target out of the merge window's own query string. Throws on a
 * missing repo/path, which can only mean the window was opened by hand — the
 * window renders the message rather than an empty pane.
 */
export function parseMergeParams(search: string): MergeParams {
  const params = new URLSearchParams(search);
  const repoRoot = params.get("repo");
  const path = params.get("path");
  if (!repoRoot || !path) {
    throw new Error("merge window opened without a repository and file path");
  }
  return { repoRoot, path };
}

export function getMergeState(repoRoot: string): Promise<MergeState> {
  return invoke<MergeState>("git_merge_state", { repoRoot });
}

export function getConflictFile(repoRoot: string, path: string): Promise<ConflictFile> {
  return invoke<ConflictFile>("git_conflict_file", { repoRoot, path });
}

/**
 * Merge `reference` into the current branch. Resolves with `conflicted: true`
 * when the merge stopped on conflicts — that is an outcome, not a failure. Only
 * a merge git refused (a dirty tree, an unknown ref) rejects.
 */
export function mergeRef(repoRoot: string, reference: string): Promise<MergeOutcome> {
  return invoke<MergeOutcome>("git_merge", { repoRoot, reference });
}

/** Commit the merge with git's own generated message. */
export function continueMerge(repoRoot: string): Promise<void> {
  return invoke<void>("git_merge_continue", { repoRoot });
}

/** Throw the merge away, restoring the pre-merge working tree. */
export function abortMerge(repoRoot: string): Promise<void> {
  return invoke<void>("git_merge_abort", { repoRoot });
}

/**
 * Keep one side of conflict `index`. `revision` is the hash from the
 * `ConflictFile` this choice was made against: the backend refuses a stale one
 * rather than rewriting whatever hunk now sits at that index.
 */
export function resolveConflict(
  repoRoot: string,
  path: string,
  index: number,
  choice: ConflictChoice,
  revision: string,
): Promise<ResolveOutcome> {
  return invoke<ResolveOutcome>("git_resolve_conflict", {
    repoRoot,
    path,
    index,
    choice,
    revision,
  });
}

/** Resolve a whole conflicted path (no markers to choose between). */
export function resolvePath(
  repoRoot: string,
  path: string,
  resolution: PathResolution,
): Promise<void> {
  return invoke<void>("git_resolve_path", { repoRoot, path, resolution });
}
