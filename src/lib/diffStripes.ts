// The change map beside the diff panes: green for added, blue for changed, red
// for removed, at the height of each change.
//
// The diff window's kind set and nothing else. `lib/overviewStripes` owns the
// geometry both windows' strips share, and `editor/OverviewRuler` owns the DOM.

import { stripeFor, type Stripe, type StripeGeometry } from "./overviewStripes";
import type { Theme } from "../theme/themes";

export type StripeKind = "added" | "modified" | "removed";

/**
 * The shape of `@codemirror/merge`'s `Chunk` this module depends on. Declared
 * locally so the module and its test never load CodeMirror.
 *
 * A chunk is empty on a side when that side's `from` equals its `to`: a pure
 * insertion is empty in A, a pure deletion empty in B.
 *
 * `endB` matters as much as the rest. `toB` points *one past* the end of the last
 * changed line — which is the start of the next line, and may be past the end of
 * the document entirely — so measuring to it would make every mark one line too
 * tall. `endB` is the package's own answer: `fromB` when the chunk is empty in B,
 * and the end of its last line otherwise.
 */
export interface ChunkLike {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  endB: number;
}

/** What each mark is, for a hover. */
export const DIFF_MARK_LABELS: Record<StripeKind, string> = {
  added: "added",
  modified: "changed",
  removed: "removed",
};

/**
 * Classify a chunk.
 *
 * Empty in A means those lines exist only in the working tree — added. Empty in
 * B means they exist only in HEAD — removed. Anything else is a replacement,
 * which is what "modified" means and what the blue mark says.
 */
export function kindOf(chunk: ChunkLike): StripeKind {
  if (chunk.fromA === chunk.toA) return "added";
  if (chunk.fromB === chunk.toB) return "removed";
  return "modified";
}

/**
 * Colour per kind, from the active theme. A function rather than a constant
 * because the theme can change while a diff window is open.
 */
export function markerColors(theme: Theme): Record<StripeKind, string> {
  return {
    added: theme.tokens.markAdded,
    modified: theme.tokens.markModified,
    removed: theme.tokens.markDeleted,
  };
}

/**
 * One mark per chunk, positioned in the *aligned* content the two panes share.
 *
 * Positions come from side B, the working tree. With the panes aligned by spacer
 * blocks the two sides have the same content height, so one strip describes both
 * — and B is the side that always exists, where A is empty for a file that is
 * not in HEAD yet. A chunk empty in B still gets a mark, at the point the
 * deletion sits, which is what keeps a delete-only diff from showing a blank
 * strip.
 */
export function computeStripes(
  chunks: readonly ChunkLike[],
  geometry: StripeGeometry,
): Stripe<StripeKind>[] {
  if (geometry.contentHeight <= 0) return [];
  // `endB` collapses to `fromB` for a deletion, so the mark is the height of the
  // line the deletion is anchored at rather than of nothing.
  return chunks.map((chunk, index) =>
    stripeFor(index, kindOf(chunk), chunk.fromB, chunk.endB, geometry),
  );
}
