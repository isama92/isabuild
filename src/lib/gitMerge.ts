// Thin wrapper over the merge Tauri commands. Same split as lib/gitStatus and
// lib/gitBranch: this module knows the IPC surface, the store decides when to
// call it. Types mirror the Rust structs in src-tauri/src/merge.rs.

import { invoke } from "@tauri-apps/api/core";
import type { Chunk } from "./mergeChunks";

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

/** How far through a multi-commit operation the repository is. */
export interface OpProgress {
  /** 1-based position of the commit being applied. */
  current: number;
  total: number;
}

export interface MergeState {
  kind: MergeKind;
  /**
   * What is being applied: the merged ref for a merge, the branch being replayed
   * for a rebase, else a short sha. Null for the states that have no such ref.
   */
  mergingRef: string | null;
  /** Where a rebase is replaying onto. Null for every other kind. */
  onto: string | null;
  /** Subject of the commit being applied, for a cherry-pick or revert. */
  subject: string | null;
  /** Position in the series, where the operation has one. */
  progress: OpProgress | null;
  /**
   * Whether this operation has a `--skip`. Comes from the backend rather than
   * being derived from `kind` here, so the argv and the button agree by
   * construction.
   */
  canSkip: boolean;
}

/** What to do with the operation in progress. Mirrors Rust's `OpAction`. */
export type OpAction = "continue" | "skip" | "abort";

/**
 * The git subcommand behind a kind. Mirrors Rust's `MergeKind::argv_family`.
 *
 * **Display only.** The backend derives the real argv from a state it reads for
 * itself; this exists so a failure dialog can show the command that was run and a
 * banner can name the operation. Duplicating it here cannot send the wrong command
 * — only describe one wrongly, which a stale state would do either way.
 */
export function opFamily(kind: MergeKind): string | null {
  switch (kind) {
    case "merge":
      return "merge";
    case "rebase":
      return "rebase";
    case "cherryPick":
      return "cherry-pick";
    case "revert":
      return "revert";
    // Neither has an operation to conclude: a bare pile of conflicted paths is
    // finished by resolving them.
    case "none":
    case "conflictsOnly":
      return null;
  }
}

/** The command an action runs, for the failure dialog's "Retry in terminal". */
export function opCommand(kind: MergeKind, action: OpAction): string | null {
  const family = opFamily(kind);
  return family === null ? null : `git ${family} --${action}`;
}

/** Title for the failure modal when an action does not go through. */
export function opFailureTitle(kind: MergeKind, action: OpAction): string {
  const family = opFamily(kind) ?? "operation";
  switch (action) {
    case "continue":
      return `Could not continue the ${family}`;
    case "skip":
      return `Could not skip this commit`;
    case "abort":
      return `Could not abort the ${family}`;
  }
}

/** Status-bar notice after an action succeeds. */
export function opSuccessNotice(kind: MergeKind, action: OpAction): string {
  const family = opFamily(kind) ?? "operation";
  switch (action) {
    // A merge continue *is* the commit, which is worth saying plainly; the
    // replaying families may have more commits to go, so "continued" is the
    // honest word for them.
    case "continue":
      return kind === "merge" ? "Merge committed" : `Continued the ${family}`;
    case "skip":
      return "Skipped that commit";
    case "abort":
      return `Aborted the ${family}`;
  }
}

/** Half-open range of line indices into `ConflictFile.lines`. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * A conflicted file as the three-pane editor needs it: the index stages, the
 * chunks between them, and the buffer to open with. Mirrors Rust's
 * `ConflictStages`.
 */
export interface ConflictStages {
  path: string;
  /**
   * Stage 1, the merge base. A path with no stage 1 (a both-added one) gets the
   * *empty file* — which is `[""]`, one empty line, not an empty array: that final
   * empty line is the trailing-newline sentinel all three texts share.
   */
  base: string[];
  /** Stage 2, our side. Empty array when the index holds no stage 2. */
  ours: string[];
  /** Stage 3, their side. */
  theirs: string[];
  /**
   * Which stages the index holds.
   *
   * **Empty means the path is no longer unmerged** — something staged it, here or
   * outside the app — which the window renders as resolved. Anything short of both
   * 2 and 3 means there is no text to merge, only a whole-file decision.
   */
  stages: number[];
  chunks: Chunk[];
  /** The initial buffer: git's own resolution, with conflicts left as markers. */
  result: string;
  /** The working-tree file, LF-normalised. What "use the file on disk" loads. */
  disk: string;
  /** Follows `<<<<<<<` in the buffer. Display only — never branch on it. */
  oursLabel: string;
  /** Follows `>>>>>>>`. Display only. */
  theirsLabel: string;
  /** Hash of the working-tree bytes; quote it back when writing. */
  revision: string;
  /**
   * True when the file on disk is neither git's own merge of these stages nor our
   * rebuild of it, so someone has edited it and loading the rebuild would take
   * their work off the screen without saying so.
   */
  diverged: boolean;
  binary: boolean;
}

/**
 * A whole-file decision, for the conflicts with no merged text — plus
 * `markResolved`, which stages the working-tree file exactly as it is. That is the
 * escape hatch for a file resolved outside the app: git reports a path as
 * unmerged until something stages it, so without it a conflict fixed in the diff
 * window or the terminal would sit in the Conflicts group forever.
 */
export type PathResolution = "keepOurs" | "keepTheirs" | "acceptDeletion" | "markResolved";

export interface ResolveOutcome {
  /** Conflicts still in the file. Always 0: a write only happens at zero. */
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

export function getConflictStages(repoRoot: string, path: string): Promise<ConflictStages> {
  return invoke<ConflictStages>("git_conflict_stages", { repoRoot, path });
}

/**
 * Merge `reference` into the current branch. Resolves with `conflicted: true`
 * when the merge stopped on conflicts — that is an outcome, not a failure. Only
 * a merge git refused (a dirty tree, an unknown ref) rejects.
 */
export function mergeRef(repoRoot: string, reference: string): Promise<MergeOutcome> {
  return invoke<MergeOutcome>("git_merge", { repoRoot, reference });
}

/**
 * Continue, skip or abort whatever is in progress.
 *
 * The action is what the user asked for; **which git command carries it out is
 * decided in the backend**, from a state it reads for itself. This module cannot
 * send `rebase --abort` at a merge even if `mergeState` here is stale.
 */
export function runOp(repoRoot: string, action: OpAction): Promise<void> {
  return invoke<void>("git_op", { repoRoot, action });
}

/**
 * Write a fully resolved file and stage it.
 *
 * `revision` is the hash from the `ConflictStages` this buffer was built on: a
 * stale one is refused rather than overwriting whatever is on disk now. Text that
 * still contains a marker is refused too — the backend, not this window's live
 * counter, is what decides a file is resolved.
 */
export function writeResolved(
  repoRoot: string,
  path: string,
  text: string,
  revision: string,
): Promise<ResolveOutcome> {
  return invoke<ResolveOutcome>("git_write_resolved", {
    repoRoot,
    path,
    text,
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
