// Scrollbar change map. Monaco's own diff overview ruler knows only "inserted"
// and "removed", so the three colours we want (green added / blue changed / red
// removed) come from our own overview-ruler decorations. This module is the
// pure part: Monaco line changes in, marker ranges out.
//
// Both panes get a marker for every change. They scroll as one and are aligned
// by filler lines, so a mark at the same height in both scrollbars reads as one
// change (this is what JetBrains' diff stripes do); marking only the side that
// happens to hold lines would leave a delete-only file with a blank scrollbar
// on the right.

import type { Theme } from "../theme/themes";

export type MarkerKind = "added" | "modified" | "removed";
export type DiffSide = "original" | "modified";

/**
 * Scrollbar colour per kind: new lines green, changed lines blue, removed lines
 * red, from the active theme. A function rather than a constant because the
 * theme can change while a diff window is open, and Monaco holds the colour it
 * was handed at decoration time.
 *
 * Lives here rather than in the Monaco setup so it can be read without loading
 * Monaco (which does not run under jsdom).
 */
export function markerColors(theme: Theme): Record<MarkerKind, string> {
  return {
    added: theme.tokens.markAdded,
    modified: theme.tokens.markModified,
    removed: theme.tokens.markDeleted,
  };
}

export interface DiffMarker {
  kind: MarkerKind;
  side: DiffSide;
  startLine: number;
  endLine: number;
}

/**
 * The shape of `monaco.editor.ILineChange` we depend on. Declared locally so
 * this module (and its test) never has to load Monaco.
 *
 * Monaco encodes a pure insertion as `originalEndLineNumber === 0` and a pure
 * deletion as `modifiedEndLineNumber === 0`; the start line on the empty side
 * is then the line the change sits *after*, which can be 0 at the top of a file.
 */
export interface LineChangeLike {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** Line numbers are 1-based; an anchor of 0 means "before the first line". */
function anchor(line: number): number {
  return Math.max(1, line);
}

/** Classify each change and place it on both sides. */
export function computeMarkers(changes: readonly LineChangeLike[] | null): DiffMarker[] {
  if (!changes) return [];

  return changes.flatMap((change) => {
    const added = change.originalEndLineNumber === 0;
    const removed = change.modifiedEndLineNumber === 0;
    const kind: MarkerKind = added ? "added" : removed ? "removed" : "modified";

    return [
      {
        kind,
        side: "original" as DiffSide,
        startLine: anchor(change.originalStartLineNumber),
        endLine: added ? anchor(change.originalStartLineNumber) : change.originalEndLineNumber,
      },
      {
        kind,
        side: "modified" as DiffSide,
        startLine: anchor(change.modifiedStartLineNumber),
        endLine: removed ? anchor(change.modifiedStartLineNumber) : change.modifiedEndLineNumber,
      },
    ];
  });
}
