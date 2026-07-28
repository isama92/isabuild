// The change map beside the diff panes: green for added, blue for changed, red
// for removed, at the height of each change.
//
// Monaco painted this into both scrollbars for free through an overview-ruler
// decoration; CodeMirror has no such thing, so the strip is ours. This module is
// the pure part — chunks and a geometry in, fractions out — and `editor/
// OverviewRuler` is the DOM.
//
// ## Why geometry is injected rather than measured here
//
// A `MergeView` aligns its two documents with spacer blocks and can collapse
// unchanged stretches on request, so a chunk's height on screen is not a function
// of its line count: it depends on spacers above it and on what is collapsed.
// Only the live view knows that. Passing the three numbers it can answer keeps
// the classification, the merging and the hit-testing testable with a fake, and
// confines what jsdom cannot do (measure) to the adapter in the component.

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

/** What the live view can answer about where a document position sits. */
export interface StripeGeometry {
  /** Pixels from the top of the scrollable content to the top of `pos`'s line. */
  top: (pos: number) => number;
  /** Pixels to the bottom of `pos`'s line. */
  bottom: (pos: number) => number;
  /** Total scrollable content height, spacers and collapsed blocks included. */
  contentHeight: number;
}

/** One mark, as fractions of the strip's height so the DOM needs no pixels. */
export interface Stripe {
  /** Index into the chunk list this came from, for click-to-scroll. */
  chunk: number;
  kind: StripeKind;
  /** 0 at the top of the content, 1 at the bottom. */
  top: number;
  /** Fraction of the content's height. Never smaller than [`MIN_HEIGHT`]. */
  height: number;
}

/**
 * Smallest a mark may be, as a fraction of the strip.
 *
 * A one-line change in a two-thousand-line file is 0.0005 of the height, which
 * rounds to nothing and paints as an empty strip. This is the floor that keeps a
 * single changed line visible, and it is the reason the strip cannot be a plain
 * percentage of the line count.
 */
export const MIN_HEIGHT = 0.004;

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
): Stripe[] {
  if (geometry.contentHeight <= 0) return [];
  const stripes: Stripe[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const top = geometry.top(chunk.fromB);
    // `endB` collapses to `fromB` for a deletion, so the mark is the height of
    // the line the deletion is anchored at rather than of nothing.
    const bottom = geometry.bottom(chunk.endB);
    const start = clamp(top / geometry.contentHeight);
    const end = clamp(bottom / geometry.contentHeight);
    stripes.push({
      chunk: index,
      kind: kindOf(chunk),
      top: start,
      height: Math.max(MIN_HEIGHT, end - start),
    });
  }
  return stripes;
}

/**
 * The chunk whose mark covers `fraction`, or null.
 *
 * Used for a click on the strip. Ties go to the first mark, so overlapping marks
 * in a dense diff resolve to the one nearer the top rather than to whichever the
 * iteration order happened to reach last.
 */
export function stripeAt(stripes: readonly Stripe[], fraction: number): number | null {
  for (const stripe of stripes) {
    if (fraction >= stripe.top && fraction <= stripe.top + stripe.height) {
      return stripe.chunk;
    }
  }
  return null;
}

function clamp(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}
