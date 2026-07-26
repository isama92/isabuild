// Thin wrapper over the per-file git Tauri commands. Same split as lib/gitStatus
// and lib/gitMerge: this module knows the IPC surface, the store decides when to
// call it. Types mirror the Rust structs in src-tauri/src/files.rs.

import { invoke } from "@tauri-apps/api/core";

/** What a commit produced. Mirrors Rust `CommitOutcome`. */
export interface CommitOutcome {
  /** Short sha of the new commit, or null if HEAD could not be read back. */
  sha: string | null;
}

/**
 * The row an action targets. `origPath` is git's rename/copy origin, and reaches
 * git as a second pathspec — a staged rename is one row and two index entries,
 * and acting on one half would leave the other behind.
 */
export interface FilePath {
  repoRoot: string;
  path: string;
  origPath?: string;
}

/** `git add` this path. */
export function stagePath(target: FilePath): Promise<void> {
  return invoke<void>("git_stage_path", args(target));
}

/** Drop this path's index entry, leaving the file alone. */
export function unstagePath(target: FilePath): Promise<void> {
  return invoke<void>("git_unstage_path", args(target));
}

/**
 * Put this path back the way HEAD has it — deleting it when HEAD does not have
 * it at all. Destructive and unrecoverable; confirm before calling.
 */
export function rollbackPath(target: FilePath): Promise<void> {
  return invoke<void>("git_rollback_path", args(target));
}

/** Commit this path alone, leaving the rest of the index staged. */
export function commitPath(target: FilePath, message: string): Promise<CommitOutcome> {
  return invoke<CommitOutcome>("git_commit_path", { ...args(target), message });
}

function args(target: FilePath) {
  return {
    repoRoot: target.repoRoot,
    path: target.path,
    origPath: target.origPath ?? null,
  };
}

/**
 * Quote a string for a POSIX shell, for the command "Retry in terminal" types
 * into the shell panel (a login shell on Unix, Git Bash on Windows).
 *
 * Single quotes, so nothing inside is expanded — a commit message is arbitrary
 * user text and could hold `$`, backticks or a newline. A literal single quote
 * cannot be escaped inside single quotes, so the string is closed, an escaped
 * quote emitted, and the string reopened: the usual `'\''`.
 */
export function singleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * A path as a shell argument for the same command line, quoted only when it
 * needs to be — so the command a user is shown reads like the one they would
 * have typed, until a space or a glob character makes quoting the honest form.
 */
export function shellPath(path: string): string {
  return /^[A-Za-z0-9._/@+-]+$/.test(path) ? path : singleQuote(path);
}
