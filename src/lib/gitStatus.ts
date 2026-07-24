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
  | "untracked"
  | "unmerged";

export interface FileEntry {
  path: string;
  /** Set only for renames/copies. */
  origPath?: string;
  status: ChangeStatus;
}

export interface GitStatus {
  repoRoot: string;
  staged: FileEntry[];
  unstaged: FileEntry[];
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
