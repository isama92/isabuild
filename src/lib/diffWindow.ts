// Opening the per-file diff window from the main window. Like lib/ptySession
// and lib/gitStatus this module owns an IPC surface and decides nothing else:
// StatusPanel says which file, this says how a window for it is addressed.
//
// One window per file, deduped by label: clicking a file that already has a
// window focuses it instead of stacking a second copy. The label, the dedupe and
// the creation-failure handling live in lib/fileWindow, shared with the merge
// window (Part 6).

import { routeDiffWindow } from "./diffRegistry";
import { fileWindowLabel, openFileWindow, withTheme } from "./fileWindow";

export interface DiffTarget {
  /** Repository root, as resolved by `git_status`. */
  repoRoot: string;
  /** Repo-relative path with forward slashes, as git reports it. */
  path: string;
  /** Rename/copy origin; the HEAD side is read from there. */
  origPath?: string;
}

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;

/** Window label for a diff target. `origPath` is deliberately not part of it:
 * the window is identified by the file it edits, and a rename origin is context,
 * not identity. */
export function diffWindowLabel(target: DiffTarget): string {
  return fileWindowLabel("diff", target);
}

/** URL for the diff document, carrying its target in the query string. */
export function diffWindowUrl(target: DiffTarget): string {
  const params = new URLSearchParams({ repo: target.repoRoot, path: target.path });
  if (target.origPath) {
    params.set("orig", target.origPath);
  }
  return `diff.html?${withTheme(params).toString()}`;
}

/**
 * Show the diff for `target`: focus the window already open for that file, or
 * create one. Rejects with an actionable message when the window cannot be
 * created, so the caller can surface it rather than clicking into nothing.
 *
 * The label alone is no longer enough to find the right window, because a diff
 * window can be pointed at a sibling file after it opens — so the backend, which
 * is the only place that knows where each window actually is, decides. It may also
 * answer with a window that is open for *this* file's label but showing something
 * else, having already asked it to come back here.
 */
export async function openDiffWindow(target: DiffTarget): Promise<void> {
  const label = diffWindowLabel(target);
  // A registry failure must never be able to stop a file opening: falling back to
  // the label is exactly the behaviour this had before the registry existed, and
  // the worst it can cost is one duplicate window.
  const focusLabel = await routeDiffWindow(target, label).catch(() => null);
  return openFileWindow({
    label,
    focusLabel: focusLabel ?? undefined,
    url: diffWindowUrl(target),
    title: `Diff: ${target.path}`,
    subject: "the diff window",
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
}
