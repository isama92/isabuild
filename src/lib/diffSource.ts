// Thin wrapper over the diff Tauri commands, mirroring lib/gitStatus's split:
// this module knows the IPC surface, the diff window decides when to call it.
// Types mirror the Rust structs in src-tauri/src/diff.rs.

import { invoke } from "@tauri-apps/api/core";

/** Line ending of the working-tree file. Mirrors Rust `Eol`. */
export type Eol = "lf" | "crlf";

export interface FileDiff {
  path: string;
  /** Rename/copy origin; the HEAD side was read from there. */
  origPath: string | null;
  /** Short HEAD sha for the left header; null on an unborn HEAD. */
  headSha: string | null;
  /** HEAD side; null when the path is not in HEAD (new file) or binary. */
  left: string | null;
  /** Working-tree side; null when the file is deleted or binary. */
  right: string | null;
  binary: boolean;
  /**
   * The file's own line ending. Both sides arrive LF-separated whatever this
   * says (see the module docs in diff.rs); it travels back on save so the file
   * keeps the endings it had.
   */
  eol: Eol;
}

/** Where a diff window points. Parsed from its own URL by `parseDiffParams`. */
export interface DiffParams {
  repoRoot: string;
  path: string;
  origPath?: string;
}

/** Read both sides of one file: the HEAD revision and the working tree. */
export function getFileDiff(params: DiffParams): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", {
    repoRoot: params.repoRoot,
    path: params.path,
    origPath: params.origPath ?? null,
  });
}

/**
 * Write the edited buffer back to the working-tree file. `content` is
 * LF-separated (what the editor holds); `eol` is the file's own ending from
 * `getFileDiff`. Rejects rather than creating a file that is not there.
 */
export function writeWorkingFile(
  params: DiffParams,
  content: string,
  eol: Eol,
): Promise<void> {
  return invoke<void>("write_working_file", {
    repoRoot: params.repoRoot,
    path: params.path,
    content,
    eol,
  });
}

/**
 * Read the target out of the diff window's own query string. Throws on a
 * missing repo/path, which can only mean the window was opened by hand — the
 * window renders the message instead of an empty editor.
 */
export function parseDiffParams(search: string): DiffParams {
  const params = new URLSearchParams(search);
  const repoRoot = params.get("repo");
  const path = params.get("path");
  if (!repoRoot || !path) {
    throw new Error("diff window opened without a repository and file path");
  }
  return {
    repoRoot,
    path,
    origPath: params.get("orig") ?? undefined,
  };
}
