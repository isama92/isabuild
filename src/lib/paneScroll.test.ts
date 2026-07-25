import { describe, expect, it } from "vitest";
import { mirrorScrollTop, scrollTopForLine, worthScrolling } from "./paneScroll";

const pane = (scrollTop: number, scrollHeight: number, clientHeight = 100) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe("mirrorScrollTop", () => {
  it("matches the fraction scrolled, not the pixel offset", () => {
    // The whole reason it is proportional: the three texts have different line
    // counts, so copying scrollTop would put a short pane at its end while a long
    // one is only halfway.
    const source = pane(200, 500); // 200 of 400 scrollable = halfway
    const target = pane(0, 1100); // 1000 scrollable
    expect(mirrorScrollTop(source, target)).toBe(500);
  });

  it("keeps the top and the bottom aligned exactly", () => {
    expect(mirrorScrollTop(pane(0, 500), pane(0, 1100))).toBe(0);
    expect(mirrorScrollTop(pane(400, 500), pane(0, 1100))).toBe(1000);
  });

  it("stays at zero when a pane has nothing to scroll", () => {
    // No division by zero, and no NaN reaching scrollTop.
    expect(mirrorScrollTop(pane(0, 80), pane(0, 1100))).toBe(0);
    expect(mirrorScrollTop(pane(200, 500), pane(0, 80))).toBe(0);
  });

  it("clamps an over-scrolled source rather than overshooting", () => {
    // Momentum scrolling on macOS reports a scrollTop past the end.
    expect(mirrorScrollTop(pane(999, 500), pane(0, 1100))).toBe(1000);
    expect(mirrorScrollTop(pane(-20, 500), pane(0, 1100))).toBe(0);
  });
});

describe("worthScrolling", () => {
  it("ignores a difference smaller than a line", () => {
    // Setting scrollTop fires another scroll event, so mirroring every rounding
    // difference makes three panes bounce off each other indefinitely.
    expect(worthScrolling(500, 503, 18)).toBe(false);
  });

  it("applies a real move", () => {
    expect(worthScrolling(500, 560, 18)).toBe(true);
  });

  it("still has a tolerance when the line height is unknown", () => {
    expect(worthScrolling(500, 500, 0)).toBe(false);
    expect(worthScrolling(500, 502, 0)).toBe(true);
  });
});

describe("scrollTopForLine", () => {
  const metrics = { scrollHeight: 1100, clientHeight: 100 };

  it("leaves a margin above the target line", () => {
    // Flush against the top edge is readable but looks like an accident.
    expect(scrollTopForLine(10, 20, metrics)).toBe(160);
  });

  it("does not scroll past the end for a chunk near the bottom", () => {
    expect(scrollTopForLine(500, 20, metrics)).toBe(1000);
  });

  it("does not scroll above the top for a chunk near the start", () => {
    expect(scrollTopForLine(1, 20, metrics)).toBe(0);
  });
});
