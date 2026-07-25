// Thin wrapper over the git Tauri commands and the repo-change event. Mirrors
// lib/ptySession's split of concerns: this module knows the IPC surface, while
// the store/hook layer (store/gitStore, hooks/useRepoWatch) decides when to
// call it. Types mirror the Rust structs in src-tauri/src/git.rs.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** How a single path changed, in one group. Mirrors Rust `ChangeStatus`. */
export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked";

export interface FileEntry {
  path: string;
  /** Set only for renames/copies. */
  origPath?: string;
  status: ChangeStatus;
}

/**
 * Which sides of the merge touched a conflicted path. Mirrors Rust
 * `ConflictKind`, which derives it from the `u <XY>` code.
 *
 * Only `bothModified` and `bothAdded` have conflict markers in the file; the
 * rest have no merged text at all and take a whole-file decision instead. See
 * `conflictHasMarkers`.
 */
export type ConflictKind =
  | "bothModified"
  | "bothAdded"
  | "bothDeleted"
  | "addedByUs"
  | "addedByThem"
  | "deletedByUs"
  | "deletedByThem"
  | "unknown";

export interface ConflictEntry {
  path: string;
  kind: ConflictKind;
}

export interface GitStatus {
  repoRoot: string;
  staged: FileEntry[];
  unstaged: FileEntry[];
  /** Conflicted paths. Their own group: a conflict is not an unstaged change. */
  conflicts: ConflictEntry[];
}

/**
 * Whether this kind of conflict has markers in the working-tree file, i.e.
 * whether opening the merge window has anything to show. Mirrors Rust
 * `ConflictKind::has_markers`.
 */
export function conflictHasMarkers(kind: ConflictKind): boolean {
  return kind === "bothModified" || kind === "bothAdded";
}

/**
 * Read the working-tree status of the repo containing `path`; omit `path` to
 * use the app's launch directory (the backend resolves it). Rejects when the
 * directory is not inside a git repository.
 */
export function getStatus(path?: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path: path ?? null });
}

/** (Re)start the debounced backend file watcher on `repoRoot`. */
export function startWatch(repoRoot: string): Promise<void> {
  return invoke<void>("git_watch", { repoRoot });
}

/**
 * Subscribe to `repo://changed`. The payload is empty — the event only means
 * "the repo changed, refetch". Returns the unlisten handle.
 */
export function onRepoChanged(callback: () => void): Promise<UnlistenFn> {
  return listen("repo://changed", () => callback());
}
