// Presentation helpers for conflicts: what a kind is called, and which
// whole-file resolutions it can offer. Pure functions, like lib/branchView —
// StatusPanel renders, this decides.

import { conflictHasMarkers, type ConflictKind } from "./gitStatus";
import type { PathResolution } from "./gitMerge";

/** How a conflict kind is described in the UI, in the user's terms. */
const KIND_LABEL: Record<ConflictKind, string> = {
  bothModified: "both changed this",
  bothAdded: "both added this",
  bothDeleted: "both deleted this",
  addedByUs: "only you added this",
  addedByThem: "only they added this",
  deletedByUs: "you deleted it, they changed it",
  deletedByThem: "they deleted it, you changed it",
  unknown: "conflicted",
};

export function conflictLabel(kind: ConflictKind): string {
  return KIND_LABEL[kind];
}

/**
 * Whether *our* side — what HEAD holds — has this path at all.
 *
 * Follows from the same `u XY` table the kind was derived from: `X` is our side,
 * so `A` (we added it) and `M`/`U` (we have it and changed it) mean HEAD has the
 * path, while `D` (we deleted it) and a two-sided add mean it does not.
 *
 * Load-bearing for wording, not for a command: rolling a conflicted path back
 * restores HEAD's version, so on `deletedByUs`, `bothDeleted` and `addedByThem`
 * that *deletes* the file. A dialog promising to restore it would be a lie about
 * an irreversible action. `unknown` is an XY git has never documented, so it says
 * so rather than guessing.
 */
export function conflictOurSide(kind: ConflictKind): "present" | "absent" | "unknown" {
  switch (kind) {
    case "bothModified":
    case "addedByUs":
    case "deletedByThem":
      return "present";
    case "bothAdded":
    case "bothDeleted":
    case "addedByThem":
    case "deletedByUs":
      return "absent";
    case "unknown":
      return "unknown";
  }
}

export interface ConflictAction {
  resolution: PathResolution;
  /** Button text. Short: these sit inline in a 22%-wide panel. */
  label: string;
  /** Tooltip spelling out what it does to the file. */
  title: string;
  /** True when it removes the file, so the button can be styled as such. */
  destructive?: boolean;
}

const KEEP_OURS: ConflictAction = {
  resolution: "keepOurs",
  label: "Keep mine",
  title: "Keep my version of this file and mark it resolved",
};

const KEEP_THEIRS: ConflictAction = {
  resolution: "keepTheirs",
  label: "Keep theirs",
  title: "Keep their version of this file and mark it resolved",
};

const DELETE: ConflictAction = {
  resolution: "acceptDeletion",
  label: "Delete it",
  title: "Delete the file and mark it resolved",
  destructive: true,
};

/**
 * The whole-file resolutions worth offering for `kind`.
 *
 * Empty for the kinds that have conflict markers: those are resolved hunk by
 * hunk in the merge window, and offering "keep mine" beside them would invite
 * throwing away the other side by accident.
 *
 * Only the sides that *exist* are offered. A delete/modify conflict has content
 * on one side only, so proposing the other would be a button that can only fail.
 */
export function conflictActions(kind: ConflictKind): ConflictAction[] {
  if (conflictHasMarkers(kind)) return [];
  switch (kind) {
    // They deleted it, we changed it: keep our content, or accept the deletion.
    case "deletedByThem":
      return [KEEP_OURS, DELETE];
    // We deleted it, they changed it: their content is the only content there is.
    case "deletedByUs":
      return [KEEP_THEIRS, DELETE];
    case "addedByUs":
      return [KEEP_OURS, DELETE];
    case "addedByThem":
      return [KEEP_THEIRS, DELETE];
    // Both sides deleted it; agreeing with them is the only resolution.
    case "bothDeleted":
      return [DELETE];
    // An XY git has never documented. Offer everything and let git refuse what
    // does not apply, rather than guessing and offering nothing.
    default:
      return [KEEP_OURS, KEEP_THEIRS, DELETE];
  }
}

/**
 * Whole-file resolutions for a *binary* conflict, where both sides exist but
 * neither can be shown or merged as text. Offered by the merge window, which is
 * the only place that knows a file is binary.
 */
export function binaryConflictActions(): ConflictAction[] {
  return [KEEP_OURS, KEEP_THEIRS];
}
