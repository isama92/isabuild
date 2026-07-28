import { describe, expect, it } from "vitest";
import {
  computeStripes,
  kindOf,
  markerColors,
  MIN_HEIGHT,
  stripeAt,
  type ChunkLike,
  type StripeGeometry,
} from "./diffStripes";
import { DEFAULT_THEME } from "../theme/themes";

/**
 * A geometry over a document of `lines` uniform lines, `lineHeight` each, where a
 * position is simply `line * 10` characters in. Enough to pin the arithmetic
 * without pretending to be a layout engine — the real one comes from the live
 * view, which is the part jsdom cannot do.
 */
function uniform(lines: number, lineHeight = 20): StripeGeometry {
  const lineOf = (pos: number) => Math.min(lines - 1, Math.max(0, Math.floor(pos / 10)));
  return {
    top: (pos) => lineOf(pos) * lineHeight,
    bottom: (pos) => (lineOf(pos) + 1) * lineHeight,
    contentHeight: lines * lineHeight,
  };
}

/**
 * `endB` is derived the way the package derives it — `fromB` when B is empty, and
 * otherwise the end of the last changed line, which in this fixture's ten-character
 * lines is one before `toB`.
 */
function chunk(fromA: number, toA: number, fromB: number, toB: number): ChunkLike {
  return { fromA, toA, fromB, toB, endB: fromB === toB ? fromB : toB - 1 };
}

describe("kindOf", () => {
  it("calls a chunk with nothing on the HEAD side added", () => {
    expect(kindOf(chunk(40, 40, 40, 80))).toBe("added");
  });

  it("calls a chunk with nothing on the working-tree side removed", () => {
    expect(kindOf(chunk(40, 80, 40, 40))).toBe("removed");
  });

  it("calls a chunk with lines on both sides modified", () => {
    expect(kindOf(chunk(40, 80, 40, 90))).toBe("modified");
  });

  it("prefers added over removed when both sides are empty", () => {
    // Not a chunk @codemirror/merge produces, but a classification has to come
    // out of one rather than a crash.
    expect(kindOf(chunk(40, 40, 40, 40))).toBe("added");
  });
});

describe("computeStripes", () => {
  it("places a mark at the fraction of the content its chunk sits at", () => {
    // One line, line 5 of 10, 20px lines: 100px into 200px of content, 20px tall.
    const stripes = computeStripes([chunk(50, 60, 50, 60)], uniform(10));
    expect(stripes).toHaveLength(1);
    expect(stripes[0].top).toBeCloseTo(0.5);
    expect(stripes[0].height).toBeCloseTo(0.1);
  });

  it("does not stretch a mark onto the line after the chunk", () => {
    // `toB` is one past the last changed line, so measuring to *its* line would
    // make every mark a line too tall and a two-line file look wholly changed.
    const twoLines = computeStripes([chunk(0, 20, 0, 20)], uniform(10));
    expect(twoLines[0].height).toBeCloseTo(0.2);
  });

  it("carries each chunk's index, so a click can find it again", () => {
    const stripes = computeStripes(
      [chunk(0, 10, 0, 10), chunk(50, 60, 50, 60), chunk(90, 100, 90, 100)],
      uniform(10),
    );
    expect(stripes.map((stripe) => stripe.chunk)).toEqual([0, 1, 2]);
  });

  it("gives a deletion the height of the line it is anchored at", () => {
    // fromB === toB, so there is no last line to measure to: without the special
    // case this would be a zero-height mark, and a delete-only diff would show an
    // empty strip.
    const stripes = computeStripes([chunk(50, 90, 50, 50)], uniform(10));
    expect(stripes[0].top).toBeCloseTo(0.5);
    expect(stripes[0].height).toBeCloseTo(0.1);
    expect(stripes[0].kind).toBe("removed");
  });

  it("keeps a one-line change visible in a long file", () => {
    // One line in 2,000 is 0.0005 of the strip, which paints as nothing.
    const stripes = computeStripes([chunk(500, 510, 500, 510)], uniform(2000));
    expect(stripes[0].height).toBe(MIN_HEIGHT);
  });

  it("clamps a chunk that runs past the end of the content", () => {
    // `Chunk.toB` may point one past the last line; the fraction must not exceed 1.
    const stripes = computeStripes([chunk(0, 10, 90, 200)], uniform(10));
    expect(stripes[0].top + stripes[0].height).toBeLessThanOrEqual(1);
  });

  it("returns nothing before the view has been measured", () => {
    // contentHeight is 0 between construction and the first measure pass, and
    // dividing by it would put every mark at NaN.
    const geometry = { ...uniform(10), contentHeight: 0 };
    expect(computeStripes([chunk(0, 10, 0, 10)], geometry)).toEqual([]);
  });

  it("returns nothing for a file with no changes", () => {
    expect(computeStripes([], uniform(10))).toEqual([]);
  });
});

describe("stripeAt", () => {
  const stripes = computeStripes(
    [chunk(0, 10, 0, 10), chunk(50, 60, 50, 60)],
    uniform(10),
  );

  it("finds the chunk under a click", () => {
    expect(stripeAt(stripes, 0.55)).toBe(1);
  });

  it("counts a click exactly on an edge as inside", () => {
    expect(stripeAt(stripes, 0.5)).toBe(1);
  });

  it("answers null for a click on empty strip", () => {
    expect(stripeAt(stripes, 0.8)).toBeNull();
  });

  it("resolves overlapping marks to the higher one", () => {
    // Dense diffs push marks up against the minimum height until they overlap;
    // scrolling to the first is predictable, scrolling to whichever came last is
    // not.
    const dense = computeStripes(
      [chunk(0, 10, 0, 10), chunk(10, 20, 10, 20)],
      uniform(500),
    );
    expect(stripeAt(dense, 0.002)).toBe(0);
  });
});

describe("markerColors", () => {
  it("reads the three marks from the theme", () => {
    const colors = markerColors(DEFAULT_THEME);
    expect(colors.added).toBe(DEFAULT_THEME.tokens.markAdded);
    expect(colors.modified).toBe(DEFAULT_THEME.tokens.markModified);
    expect(colors.removed).toBe(DEFAULT_THEME.tokens.markDeleted);
  });
});
