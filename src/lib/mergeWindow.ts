// Opening the per-file merge window from the main window. Mirrors
// lib/diffWindow on top of the same lib/fileWindow helper: one window per
// conflicted file, deduped by label.
//
// A separate window (and a separate document, merge.html) rather than a mode of
// the diff window: the diff window is HEAD against the working tree on Monaco,
// and Part 7 replaces this one's single pane with a 3-pane CodeMirror editor
// without touching that.

import { fileWindowLabel, openFileWindow, withTheme } from "./fileWindow";

export interface MergeTarget {
  /** Repository root, as resolved by `git_status`. */
  repoRoot: string;
  /** Repo-relative path with forward slashes, as git reports it. */
  path: string;
}

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 850;

export function mergeWindowLabel(target: MergeTarget): string {
  return fileWindowLabel("merge", target);
}

/** URL for the merge document, carrying its target in the query string. */
export function mergeWindowUrl(target: MergeTarget): string {
  const params = new URLSearchParams({ repo: target.repoRoot, path: target.path });
  return `merge.html?${withTheme(params).toString()}`;
}

/**
 * Show the conflicts in `target`: focus the window already open for that file,
 * or create one. Rejects with an actionable message when the window cannot be
 * created.
 */
export function openMergeWindow(target: MergeTarget): Promise<void> {
  return openFileWindow({
    label: mergeWindowLabel(target),
    url: mergeWindowUrl(target),
    title: `Conflicts: ${target.path}`,
    subject: "the merge window",
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
}
