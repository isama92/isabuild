import { describe, expect, it } from "vitest";
import {
  sameStripes,
  stripeAt,
  stripeFor,
  MIN_HEIGHT,
  type Stripe,
  type StripeGeometry,
} from "./overviewStripes";

/**
 * A geometry over a document of `lines` uniform lines, `lineHeight` each, where a
 * position is simply `line * 10` characters in. Enough to pin the arithmetic
 * without pretending to be a layout engine: the real one comes from the live view,
 * which is the part jsdom cannot do.
 */
function uniform(lines: number, lineHeight = 20): StripeGeometry {
  const lineOf = (pos: number) => Math.min(lines - 1, Math.max(0, Math.floor(pos / 10)));
  return {
    top: (pos) => lineOf(pos) * lineHeight,
    bottom: (pos) => (lineOf(pos) + 1) * lineHeight,
    contentHeight: lines * lineHeight,
  };
}

function stripe(overrides: Partial<Stripe> = {}): Stripe {
  return { chunk: 0, kind: "modified", top: 0.25, height: 0.1, ...overrides };
}

describe("stripeFor", () => {
  it("places a mark at the fraction of the content its lines sit at", () => {
    // Line 5 of 10, 20px lines: 100px into 200px of content, one line tall.
    const mark = stripeFor(3, "conflict", 50, 50, uniform(10));
    expect(mark.chunk).toBe(3);
    expect(mark.kind).toBe("conflict");
    expect(mark.top).toBeCloseTo(0.5);
    expect(mark.height).toBeCloseTo(0.1);
  });

  it("keeps a one-line change visible in a long file", () => {
    // One line in 2,000 is 0.0005 of the strip, which paints as nothing.
    expect(stripeFor(0, "ours", 5000, 5000, uniform(2000)).height).toBe(MIN_HEIGHT);
  });

  it("clamps a mark that runs past the end of the content", () => {
    const mark = stripeFor(0, "ours", 900, 2000, uniform(10));
    expect(mark.top + mark.height).toBeLessThanOrEqual(1);
  });

  it("puts an unmeasured pane's marks at the top rather than at NaN", () => {
    // contentHeight is 0 between construction and the first measure pass. Callers
    // skip that case; dividing by it must still not produce a NaN percentage.
    const mark = stripeFor(0, "ours", 0, 10, { ...uniform(10), contentHeight: 0 });
    expect(mark.top).toBe(0);
    expect(Number.isFinite(mark.height)).toBe(true);
  });
});

describe("stripeAt", () => {
  const stripes = [
    stripeFor(0, "modified", 0, 0, uniform(10)),
    stripeFor(1, "modified", 50, 50, uniform(10)),
  ];

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
    // Dense files push marks up against the minimum height until they overlap;
    // scrolling to the first is predictable, scrolling to whichever came last is
    // not.
    const dense = [
      stripeFor(0, "modified", 0, 0, uniform(500)),
      stripeFor(1, "modified", 10, 10, uniform(500)),
    ];
    expect(stripeAt(dense, 0.002)).toBe(0);
  });

  it("carries the chunk index rather than the mark's position", () => {
    // The merge strip marks only the chunks either side touched, so a click has to
    // seek by the index in the model.
    expect(stripeAt([stripe({ chunk: 7, top: 0, height: 1 })], 0.5)).toBe(7);
  });
});

describe("sameStripes", () => {
  it("recognises a map that would paint the same", () => {
    expect(sameStripes([stripe()], [stripe()])).toBe(true);
  });

  it("sees a mark move, change kind or change height", () => {
    expect(sameStripes([stripe()], [stripe({ top: 0.26 })])).toBe(false);
    expect(sameStripes([stripe()], [stripe({ kind: "added" })])).toBe(false);
    expect(sameStripes([stripe()], [stripe({ height: 0.2 })])).toBe(false);
    expect(sameStripes([stripe()], [stripe({ chunk: 1 })])).toBe(false);
  });

  it("sees a mark appear", () => {
    expect(sameStripes([stripe()], [])).toBe(false);
  });
});
