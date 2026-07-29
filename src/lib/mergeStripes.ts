// The change map beside the merge panes: one mark per chunk either side touched,
// coloured by whose it is.
//
// The merge window's kind set, the counterpart of `diffStripes`. It says
// something different from the diff strip and deliberately so: a diff mark says
// which *way* a line moved, and a merge mark says *whose* a chunk is and whether
// it still needs a decision. The geometry is shared, in `lib/overviewStripes`.
//
// The strip only means anything because the panes are aligned: one vertical scale
// describing all three panes is exactly what `lib/mergeAlign` buys.

import { stripeFor, type Stripe, type StripeGeometry } from "./overviewStripes";
import type { ChunkKind } from "./mergeChunks";
import type { Theme } from "../theme/themes";

/**
 * What a mark says.
 *
 * `resolved` is not a chunk kind: it is a conflict whose markers are gone, which
 * makes the strip a progress bar as well as a map. Chunks neither side touched
 * get no mark at all, so an `unchanged` kind never reaches here.
 */
export type MergeMarkKind = "ours" | "theirs" | "agreed" | "conflict" | "resolved";

/** One chunk, as much of it as the strip needs. */
export interface MergeMarkChunk {
  kind: ChunkKind;
  /**
   * The chunk's span in the result buffer **as it is now**, in character
   * offsets: the marks move as the buffer grows and shrinks, so these come from
   * the tracked state field rather than from the model Rust sent.
   */
  from: number;
  to: number;
  /** For a conflict, whether its markers have gone. Ignored for anything else. */
  resolved: boolean;
}

/** What each mark is, for a hover. */
export const MERGE_MARK_LABELS: Record<MergeMarkKind, string> = {
  ours: "changed by you",
  theirs: "changed by them",
  agreed: "changed the same way by both",
  conflict: "conflict, still to decide",
  resolved: "conflict, decided",
};

/**
 * What a chunk's mark should say, or null for no mark.
 *
 * An unchanged chunk gets nothing: it is most of a file, and marking it would
 * leave a strip that is uniformly full and says nothing.
 */
export function mergeMarkKind(chunk: MergeMarkChunk): MergeMarkKind | null {
  switch (chunk.kind) {
    case "unchanged":
      return null;
    case "conflict":
      return chunk.resolved ? "resolved" : "conflict";
    default:
      return chunk.kind;
  }
}

/**
 * Colour per kind, from the active theme. A function rather than a constant
 * because the theme can change while a merge window is open.
 *
 * Ours green and theirs blue is the same split the pane headers and the chunk
 * tints use. A decided conflict goes to the dimmest text token rather than
 * vanishing: a mark that disappears also moves every judgement about how much is
 * left, and "this was a conflict and is dealt with" is worth showing.
 */
export function mergeMarkColors(theme: Theme): Record<MergeMarkKind, string> {
  return {
    ours: theme.tokens.markAdded,
    theirs: theme.tokens.markModified,
    agreed: theme.tokens.textDim,
    conflict: theme.tokens.conflict,
    resolved: theme.tokens.textDisabled,
  };
}

/**
 * One mark per chunk either side touched, in the result pane's coordinates.
 *
 * The result pane is the one to measure because it is the one that changes, and
 * with the three panes aligned its content height is all three of them.
 *
 * Note the index carried in each mark: it is the chunk's index in the model, not
 * its position among the marks, because a click has to seek to a chunk and most
 * chunks have no mark.
 */
export function computeMergeStripes(
  chunks: readonly MergeMarkChunk[],
  geometry: StripeGeometry,
): Stripe<MergeMarkKind>[] {
  if (geometry.contentHeight <= 0) return [];
  const stripes: Stripe<MergeMarkKind>[] = [];
  chunks.forEach((chunk, index) => {
    const kind = mergeMarkKind(chunk);
    if (kind === null) return;
    // A tracked span runs to the start of the line *after* the chunk, so
    // measuring to `to` would make every mark one line too tall. One character
    // back is the newline that ends the chunk's last line, which resolves to that
    // line; an empty span has no line of its own and measures where it sits.
    stripes.push(stripeFor(index, kind, chunk.from, Math.max(chunk.from, chunk.to - 1), geometry));
  });
  return stripes;
}
