// Presentation and decision helpers for a status-panel row: how its state reads,
// what its context menu offers, what rolling it back would do, and the three
// forms of its path. Pure functions, like lib/conflictView and lib/branchView —
// StatusPanel renders, this decides.

import { conflictLabel, conflictOurSide } from "./conflictView";
import type { ChangeStatus, ConflictEntry, ConflictKind, FileEntry } from "./gitStatus";

/** How a change reads in prose, for tooltips and screen readers. */
const CHANGE_LABEL: Record<ChangeStatus, string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  typeChanged: "type changed",
  untracked: "untracked",
};

export function changeLabel(status: ChangeStatus): string {
  return CHANGE_LABEL[status];
}

/** Which group a row came from. Staged-ness is not a field on the entry. */
export type FileGroup = "staged" | "unstaged" | "conflicts";

/**
 * The row an action is about.
 *
 * A conflict carries `kind` and no `status`; every other row carries `status` and
 * no `kind`. The two are different vocabularies — a conflicted path is not an
 * unstaged change — and both are needed to say what rolling the row back does.
 */
export interface FileTarget {
  path: string;
  /** The rename/copy origin, when git reported one. */
  origPath?: string;
  group: FileGroup;
  status?: ChangeStatus;
  kind?: ConflictKind;
}

/**
 * A row's hover text: `status: path`, prefixed with `staged` for a row in the
 * staged group.
 *
 * Both halves are kept because they are independent facts — a file staged and
 * then modified again is one row in each group, and "staged" alone would not say
 * which. The rename form (`old → new`) is preserved from Part 3.
 */
export function entryTooltip(entry: FileEntry, staged: boolean): string {
  const path = entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path;
  return `${staged ? "staged " : ""}${changeLabel(entry.status)}: ${path}`;
}

/**
 * A conflict row's hover text, in the same `state: path` shape.
 *
 * Reuses `conflictLabel` rather than a second, shorter vocabulary for the same
 * fact: the row already prints that exact phrasing inline beside its resolution
 * buttons, and two wordings for one kind would drift apart.
 */
export function conflictTooltip(entry: ConflictEntry): string {
  return `conflict (${conflictLabel(entry.kind)}): ${entry.path}`;
}

/** What a menu item does. `copy*` are the submenu's leaves. */
export type FileAction =
  | "commit"
  | "rollback"
  | "stage"
  | "unstage"
  | "copyRelative"
  | "copyAbsolute"
  | "copyName";

export type FileMenuItem =
  | {
      kind: "action";
      action: FileAction;
      label: string;
      /** Set when the item cannot be used, and says why. Shown as its title. */
      disabledReason?: string;
      /** True when it destroys uncommitted work, so it can be styled as such. */
      destructive?: boolean;
    }
  | {
      kind: "submenu";
      label: string;
      items: Array<{ action: FileAction; label: string }>;
    };

const COPY_SUBMENU: FileMenuItem = {
  kind: "submenu",
  label: "Copy path",
  items: [
    { action: "copyRelative", label: "Relative path" },
    { action: "copyAbsolute", label: "Absolute path" },
    { action: "copyName", label: "File name" },
  ],
};

/**
 * The menu for one row.
 *
 * `operationInProgress` is true while a merge, rebase, cherry-pick or revert is
 * under way. It only disables Commit, and for git's own reason: a commit limited
 * to a pathspec is refused outright mid-merge, because the commit git is
 * preparing has to include everything the operation touched.
 *
 * A conflicted row gets neither Commit nor Add. Staging a file that still has
 * markers in it marks it resolved with the markers left in the source, which is
 * a trap the merge window exists to avoid.
 *
 * Items that do not apply are omitted rather than disabled, except Commit: a
 * merge ends, so its item comes back, and a menu that changes shape while the
 * repository is mid-merge would be harder to learn than one row greyed out.
 */
export function fileMenuItems(
  target: FileTarget,
  operationInProgress: boolean,
): FileMenuItem[] {
  if (target.group === "conflicts") {
    return [
      {
        kind: "action",
        action: "rollback",
        label: "Rollback…",
        destructive: true,
      },
      COPY_SUBMENU,
    ];
  }
  return [
    {
      kind: "action",
      action: "commit",
      label: "Commit…",
      disabledReason: operationInProgress
        ? "git cannot commit a single file while an operation is in progress"
        : undefined,
    },
    {
      kind: "action",
      action: "rollback",
      label: "Rollback…",
      destructive: true,
    },
    target.group === "staged"
      ? { kind: "action", action: "unstage", label: "Unstage" }
      : { kind: "action", action: "stage", label: "Add (stage)" },
    COPY_SUBMENU,
  ];
}

/**
 * Whether rolling this row back **deletes** the file rather than restoring it.
 *
 * Mirrors the one question the backend asks git — does the current commit have an
 * entry at this path? — from the row alone, because the two answers need
 * different words and a different button on an irreversible action. A path that
 * was never committed cannot be restored, so agreeing with HEAD removes it.
 *
 * Deliberately not "is the file new": a `deletedByUs` conflict and a `bothDeleted`
 * one are both absent from HEAD too, which is why the conflict kind is consulted
 * rather than assumed. `unknown` is treated as a restore, and
 * `rollbackDescription` says out loud that it could go either way.
 */
export function rollbackDeletes(target: FileTarget): boolean {
  if (target.group === "conflicts") {
    return target.kind !== undefined && conflictOurSide(target.kind) === "absent";
  }
  // `copied` is a new path too: HEAD has the origin, not the copy.
  return (
    target.status === "untracked" || target.status === "added" || target.status === "copied"
  );
}

/**
 * What rolling this row back would actually do, for the confirmation.
 *
 * "Your current commit" rather than "your last commit" throughout, and that is
 * not pedantry: mid-rebase, mid-cherry-pick and mid-revert, HEAD is the commit
 * being replayed onto, not the newest thing the user wrote.
 */
export function rollbackDescription(target: FileTarget): string {
  const { path, origPath, status, kind } = target;
  if (target.group === "conflicts") {
    const side = kind === undefined ? "unknown" : conflictOurSide(kind);
    const outcome =
      side === "absent"
        ? `${path} is deleted, because your current commit does not have it`
        : side === "present"
          ? `your committed version of ${path} is restored`
          : `${path} is put back the way your current commit has it — which deletes it if that commit does not have it`;
    return `Abandon the merge for ${path}? Its conflict is resolved by taking your side: ${outcome}. This cannot be undone.`;
  }
  if (status === "untracked") {
    // An untracked directory arrives as one collapsed row, so this one click can
    // remove a whole subtree. Say so.
    return path.endsWith("/")
      ? `Delete ${path} and everything in it? None of it is in git, so this cannot be undone.`
      : `Delete ${path}? It is not in git, so this cannot be undone.`;
  }
  if (status === "renamed" && origPath) {
    return `Roll this rename back? ${origPath} is restored and ${path} is deleted. This cannot be undone.`;
  }
  if (status === "copied" && origPath) {
    return `Delete the copy ${path}? ${origPath} is left alone. This cannot be undone.`;
  }
  if (status === "added") {
    return `Discard ${path}? It has never been committed, so the file is deleted. This cannot be undone.`;
  }
  return `Discard your changes to ${path} and restore it from your current commit? This cannot be undone.`;
}

/** The three forms of a row's path that Copy path offers. */
export interface PathValues {
  relative: string;
  absolute: string;
  name: string;
}

/**
 * A path in the forms worth pasting somewhere.
 *
 * The trailing slash git puts on a collapsed untracked directory is trimmed
 * first: it is noise in all three, and it would leave `name` empty.
 *
 * `relative` stays exactly as git reports it — forward slashes on every OS —
 * because that is what git commands, code and PR comments want. `absolute` gets
 * native separators, because it is for Explorer, a file manager or a shell.
 */
export function copyValues(repoRoot: string, path: string): PathValues {
  const relative = path.replace(/\/+$/, "");
  const root = repoRoot.replace(/[/\\]+$/, "");
  const joined = `${root}/${relative}`;
  return {
    relative,
    absolute: isWindowsPath(repoRoot) ? joined.replace(/\//g, "\\") : joined,
    name: relative.slice(relative.lastIndexOf("/") + 1),
  };
}

/**
 * Whether these paths are Windows paths, from the shape of the repo root: a
 * drive prefix (`C:/...`) or a UNC share (`\\server\share`).
 *
 * The root's shape rather than `navigator.userAgent` on purpose. It is the thing
 * being joined, it makes this function pure and testable, and `git rev-parse
 * --show-toplevel` reports forward slashes on Windows too — so the separator
 * cannot be sniffed from the path body.
 */
function isWindowsPath(repoRoot: string): boolean {
  return /^[A-Za-z]:/.test(repoRoot) || repoRoot.startsWith("\\\\");
}
