// What every overview strip is made of: a mark's position as fractions of the
// content, and the hit test a click on the strip goes through.
//
// Monaco painted this into both scrollbars for free through an overview-ruler
// decoration; CodeMirror has no such thing, so the strip is ours. Two windows
// want one now, and they classify chunks quite differently, so the split is:
// this module owns the geometry, `diffStripes` and `mergeStripes` own a kind set
// each, and `editor/OverviewRuler` owns the DOM.
//
// ## Why geometry is injected rather than measured here
//
// A pane's content height is not a function of its line count: the diff panes
// carry `@codemirror/merge`'s spacer blocks and may have unchanged stretches
// collapsed, and the merge panes carry the spacers `lib/mergeAlign` computes.
// Only the live view knows. Passing the three numbers it can answer keeps the
// positioning and the hit-testing testable with a fake, and confines what jsdom
// cannot do (measure) to the adapter in each pane component.

/** What the live view can answer about where a document position sits. */
export interface StripeGeometry {
  /** Pixels from the top of the scrollable content to the top of `pos`'s line. */
  top: (pos: number) => number;
  /** Pixels to the bottom of `pos`'s line. */
  bottom: (pos: number) => number;
  /** Total scrollable content height, spacers and collapsed blocks included. */
  contentHeight: number;
}

/**
 * One mark, as fractions of the strip's height so the DOM needs no pixels.
 *
 * Generic in the kind so each window keeps its own closed set: the diff strip
 * says added/changed/removed, the merge strip says whose a chunk is. The ruler
 * component takes the loose form, being the one thing both windows share.
 */
export interface Stripe<Kind extends string = string> {
  /** Index into the chunk list this came from, for click-to-scroll. */
  chunk: number;
  kind: Kind;
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
 * One mark, from the two document positions that bound it.
 *
 * `bottomPos` has to be a position *inside* the last line the mark covers, not
 * the start of the line after it: measuring to the line after would make every
 * mark one line too tall, and a two-line file look wholly changed. Each caller
 * derives it from its own chunk model, because the two models express the end of
 * a run differently.
 */
export function stripeFor<Kind extends string>(
  chunk: number,
  kind: Kind,
  topPos: number,
  bottomPos: number,
  geometry: StripeGeometry,
): Stripe<Kind> {
  const start = clamp(geometry.top(topPos) / geometry.contentHeight);
  const end = clamp(geometry.bottom(bottomPos) / geometry.contentHeight);
  return { chunk, kind, top: start, height: Math.max(MIN_HEIGHT, end - start) };
}

/**
 * Whether two change maps would paint the same.
 *
 * Not a nicety: a map is re-measured from an update listener, so without this a
 * new array arrives on every geometry change and re-renders the toolbar beside it.
 */
export function sameStripes(a: readonly Stripe[], b: readonly Stripe[]): boolean {
  return (
    a.length === b.length &&
    a.every((stripe, index) => {
      const other = b[index];
      return (
        stripe.chunk === other.chunk &&
        stripe.kind === other.kind &&
        stripe.top === other.top &&
        stripe.height === other.height
      );
    })
  );
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
