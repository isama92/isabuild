import { describe, expect, it } from "vitest";
import {
  computeMergeStripes,
  mergeMarkColors,
  mergeMarkKind,
  MERGE_MARK_LABELS,
  type MergeMarkChunk,
} from "./mergeStripes";
import type { StripeGeometry } from "./overviewStripes";
import { DEFAULT_THEME, themeById } from "../theme/themes";

/**
 * A geometry over a document of `lines` uniform lines, 20px each, where a position
 * is `line * 10` characters in. The real one comes from the live result pane, which
 * is the part jsdom cannot do.
 */
function uniform(lines: number): StripeGeometry {
  const lineOf = (pos: number) => Math.min(lines - 1, Math.max(0, Math.floor(pos / 10)));
  return {
    top: (pos) => lineOf(pos) * 20,
    bottom: (pos) => (lineOf(pos) + 1) * 20,
    contentHeight: lines * 20,
  };
}

function chunk(overrides: Partial<MergeMarkChunk> = {}): MergeMarkChunk {
  return { kind: "conflict", from: 0, to: 10, resolved: false, ...overrides };
}

describe("mergeMarkKind", () => {
  it("marks nothing for a chunk neither side touched", () => {
    // Most of a file. Marking it would leave a strip that is uniformly full and
    // says nothing about where the work is.
    expect(mergeMarkKind(chunk({ kind: "unchanged" }))).toBeNull();
  });

  it("says whose a one-sided chunk is", () => {
    expect(mergeMarkKind(chunk({ kind: "ours" }))).toBe("ours");
    expect(mergeMarkKind(chunk({ kind: "theirs" }))).toBe("theirs");
    expect(mergeMarkKind(chunk({ kind: "agreed" }))).toBe("agreed");
  });

  it("distinguishes a conflict still to decide from one already decided", () => {
    expect(mergeMarkKind(chunk({ kind: "conflict", resolved: false }))).toBe("conflict");
    expect(mergeMarkKind(chunk({ kind: "conflict", resolved: true }))).toBe("resolved");
  });

  it("ignores the resolved flag on anything that was never a conflict", () => {
    // Nothing sets it there, and a kind that changed with it would be a second
    // meaning for the same word.
    expect(mergeMarkKind(chunk({ kind: "ours", resolved: true }))).toBe("ours");
  });
});

describe("computeMergeStripes", () => {
  it("marks the chunks either side touched, in the result's coordinates", () => {
    const stripes = computeMergeStripes(
      [
        chunk({ kind: "unchanged", from: 0, to: 20 }),
        chunk({ kind: "conflict", from: 20, to: 40 }),
        chunk({ kind: "unchanged", from: 40, to: 100 }),
      ],
      uniform(10),
    );
    expect(stripes).toHaveLength(1);
    expect(stripes[0].kind).toBe("conflict");
    expect(stripes[0].top).toBeCloseTo(0.2);
    expect(stripes[0].height).toBeCloseTo(0.2);
  });

  it("carries the chunk's own index, not the mark's", () => {
    // Most chunks have no mark, and a click has to seek to a chunk.
    const stripes = computeMergeStripes(
      [
        chunk({ kind: "unchanged" }),
        chunk({ kind: "unchanged" }),
        chunk({ kind: "theirs", from: 20, to: 30 }),
      ],
      uniform(10),
    );
    expect(stripes.map((stripe) => stripe.chunk)).toEqual([2]);
  });

  it("does not stretch a mark onto the line after its chunk", () => {
    // A tracked span runs to the start of the *next* chunk's line, so measuring to
    // `to` would make every mark a line too tall.
    const stripes = computeMergeStripes([chunk({ from: 0, to: 20 })], uniform(10));
    expect(stripes[0].height).toBeCloseTo(0.2);
  });

  it("gives a chunk with nothing left in the result the height of where it sits", () => {
    // An ours-only deletion: its span in the result is empty, and a zero-height mark
    // would leave the strip blank where a whole run of lines went.
    const stripes = computeMergeStripes([chunk({ kind: "ours", from: 50, to: 50 })], uniform(10));
    expect(stripes[0].top).toBeCloseTo(0.5);
    expect(stripes[0].height).toBeGreaterThan(0);
  });

  it("returns nothing before the pane has been measured", () => {
    const geometry = { ...uniform(10), contentHeight: 0 };
    expect(computeMergeStripes([chunk()], geometry)).toEqual([]);
  });

  it("returns nothing for a file with no chunks at all", () => {
    expect(computeMergeStripes([], uniform(10))).toEqual([]);
  });
});

describe("mergeMarkColors", () => {
  it("reads every kind from the theme", () => {
    const colors = mergeMarkColors(DEFAULT_THEME);
    const tokens = DEFAULT_THEME.tokens;
    expect(colors.ours).toBe(tokens.markAdded);
    expect(colors.theirs).toBe(tokens.markModified);
    expect(colors.conflict).toBe(tokens.conflict);
    expect(colors.agreed).toBe(tokens.textDim);
    expect(colors.resolved).toBe(tokens.textDisabled);
  });

  it("follows a theme change, so an open window repaints", () => {
    const light = themeById("vscode-light");
    expect(mergeMarkColors(light).conflict).toBe(light.tokens.conflict);
    expect(mergeMarkColors(light).conflict).not.toBe(DEFAULT_THEME.tokens.conflict);
  });

  it("keeps a colour and a label for every kind", () => {
    // A kind with no entry would paint as nothing and hover as its own id.
    expect(Object.keys(mergeMarkColors(DEFAULT_THEME)).sort()).toEqual(
      Object.keys(MERGE_MARK_LABELS).sort(),
    );
  });
});
