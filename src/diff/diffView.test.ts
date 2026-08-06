// The pure half of the diff panes' shared contract.
//
// `clampTo` is small enough to look self-evident, which is exactly why it is
// tested: it exists because CodeMirror *throws* on an out-of-range selection
// rather than clamping, and the only way to reach that is a document that shrank
// between a pane's teardown and the next one's construction. Nothing in the panes
// can assert it — a mode switch under jsdom never produces the collision — so the
// arithmetic is checked here, which is what CLAUDE.md's rule about geometry asks
// for.

import { describe, expect, it } from "vitest";
import { clampTo, DIFF_TIMEOUT_MS } from "./diffView";

describe("clampTo", () => {
  it("leaves a position the document still has", () => {
    expect(clampTo(3, "one\ntwo\n")).toBe(3);
  });

  it("holds the very end", () => {
    expect(clampTo(8, "one\ntwo\n")).toBe(8);
  });

  it("pulls a position past the end back to it", () => {
    // The case it exists for: an adopt from disk landed in the same commit as a
    // mode switch, replacing the document with a shorter one.
    expect(clampTo(99, "one\n")).toBe(4);
  });

  it("pulls a negative position up to the start", () => {
    expect(clampTo(-1, "one\n")).toBe(0);
  });

  it("answers zero for an empty document", () => {
    // A file deleted under the window, which is a real state — `rightEditable`
    // goes false and the pane keeps showing an empty right side.
    expect(clampTo(5, "")).toBe(0);
  });
});

describe("DIFF_TIMEOUT_MS", () => {
  it("is a bound both panes can actually reach", () => {
    // Not a value test so much as a tripwire. The comment on it explains that
    // @codemirror/merge's own default is worse than no bound at all, and that a
    // pathological pair of files takes minutes unbounded; anything that quietly
    // raised this into seconds would be a hang.
    expect(DIFF_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DIFF_TIMEOUT_MS).toBeLessThanOrEqual(1000);
  });
});
