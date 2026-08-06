// The list of files a diff window can step between, and where in it a given file
// sits.
//
// Pure, and separate from both the Status panel and the diff window, because the
// two need the same answer from different places: the panel is in the main window
// with the git store, and a diff window is a different webview that reads
// `git_status` for itself. Whatever they disagree about would show up as a
// "10 / 26" that does not match what the panel lists.
//
// Only the *predicate* is shared with the panel, deliberately — see
// `isStagedAndModified`. The panel does not use the deduped list, and should not:
// a path in both groups is two rows there on purpose.

import type { FileEntry, GitStatus } from "./gitStatus";

/** One navigable file. */
export interface ChangedFile {
  /** Repo-relative path, with forward slashes, exactly as git reports it. */
  path: string;
  /** Rename or copy origin, when git reported one. The HEAD side is read there. */
  origPath?: string;
  /** This path has a record in the staged group. */
  staged: boolean;
  /** This path has a record in the unstaged group, untracked included. */
  modified: boolean;
}

/** Only the two groups, so a store slice and a raw `git_status` both satisfy it. */
export type ChangeGroups = Pick<GitStatus, "staged" | "unstaged">;

/**
 * Every file the diff window can step between, in the order the Status panel
 * lists them: staged first, then unstaged, each in git's own order.
 *
 * Deduped by path, and a shared entry keeps its *staged* position. A file staged
 * and then changed again is two rows in the panel — deliberately, they say
 * different things and offer different actions — but it is one diff: the window
 * shows HEAD against the working tree either way, so stepping through it twice
 * would just look broken.
 *
 * Conflicts are not excluded so much as absent: they are not a parameter. A
 * conflict opens the merge window, a different document with a different close
 * guard, so stepping onto one would mean Next File sometimes changed which window
 * you were in.
 */
export function changedFiles(status: ChangeGroups): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  const add = (entry: FileEntry, group: "staged" | "modified") => {
    const held = byPath.get(entry.path);
    if (held) {
      held[group] = true;
      // Only if the first record did not carry one: git reports the origin on
      // whichever side the rename is recorded, and the staged side is the one
      // that has it in the normal case.
      held.origPath ??= entry.origPath;
      return;
    }
    byPath.set(entry.path, {
      path: entry.path,
      origPath: entry.origPath,
      staged: group === "staged",
      modified: group === "modified",
    });
  };
  for (const entry of status.staged) add(entry, "staged");
  for (const entry of status.unstaged) add(entry, "modified");
  // Insertion order, which is staged-then-unstaged in git's order within each.
  return [...byPath.values()];
}

/** Where `path` sits in the list, or -1 when the list no longer has it. */
export function indexOfPath(files: readonly ChangedFile[], path: string): number {
  return files.findIndex((file) => file.path === path);
}

/**
 * Where the window sits after the list moved underneath it.
 *
 * Returns the current path's index when it is still there. When it is not — the
 * file was committed, reverted, or renamed so git now reports it under another
 * path — it returns `previousIndex` clamped into the new list, so Next from a file
 * that has just vanished lands on whatever now occupies its old slot. That is what
 * someone who has just reverted a file and pressed Next expects, and it is why the
 * window is not closed instead: a diff of a file with no changes is a legitimate
 * thing to be looking at, and closing a window out from under someone is hostile.
 *
 * -1 for an empty list, which is the only case with no sensible answer.
 */
export function reanchor(
  files: readonly ChangedFile[],
  currentPath: string,
  previousIndex: number,
): number {
  if (files.length === 0) return -1;
  const found = indexOfPath(files, currentPath);
  if (found !== -1) return found;
  return Math.max(0, Math.min(previousIndex, files.length - 1));
}

/**
 * The file a step in `delta` should land on, or null when there is none.
 *
 * The delta is *not* simply added to `reanchor`'s answer, and that is the whole
 * reason this is a function rather than one line at the call site. When the shown
 * file is still in the list the two agree — its index plus the delta. When it has
 * gone, `reanchor` returns the slot it used to hold, and that slot is now occupied
 * by a *different* file the user has not seen; adding the delta on top would step
 * straight over it. Showing `[before, a, after]`, committing `a` away for
 * `[before, middle, after]`, Next would give `after` and Previous would give
 * `before`, leaving `middle` unreachable in either direction.
 *
 * So a vanished file is treated as sitting *between* two slots: Next lands on the
 * one that took its place, Previous on the one before it.
 */
export function stepTarget(
  files: readonly ChangedFile[],
  currentPath: string,
  previousIndex: number,
  delta: -1 | 1,
): ChangedFile | null {
  if (files.length === 0) return null;
  const index = indexOfPath(files, currentPath);
  const anchor = reanchor(files, currentPath, previousIndex);
  const target = index === -1 ? (delta === 1 ? anchor : anchor - 1) : index + delta;
  return files[target] ?? null;
}

/**
 * Whether this path is staged and then changed again.
 *
 * The one thing the Status panel shares with this module. It words its "stage the
 * rest of it too?" dialogs from this fact, and the dedupe above turns on it, so
 * having it in one place is what stops the two drifting.
 */
export function isStagedAndModified(status: ChangeGroups, path: string): boolean {
  return (
    status.staged.some((entry) => entry.path === path) &&
    status.unstaged.some((entry) => entry.path === path)
  );
}
