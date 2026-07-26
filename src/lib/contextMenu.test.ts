import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./contextMenu";

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 200, height: 160 };

describe("clampMenuPosition", () => {
  it("places the menu at the cursor when it fits", () => {
    expect(clampMenuPosition({ x: 100, y: 100, ...MENU }, VIEWPORT)).toEqual({
      left: 100,
      top: 100,
    });
  });

  it("flips left of the cursor rather than sliding, when it would overflow right", () => {
    // Sliding would put the first item under a cursor the user has not moved.
    expect(clampMenuPosition({ x: 950, y: 100, ...MENU }, VIEWPORT)).toEqual({
      left: 750,
      top: 100,
    });
  });

  it("flips above the cursor when it would overflow the bottom", () => {
    expect(clampMenuPosition({ x: 100, y: 780, ...MENU }, VIEWPORT)).toEqual({
      left: 100,
      top: 620,
    });
  });

  it("flips both ways in the far corner", () => {
    expect(clampMenuPosition({ x: 995, y: 795, ...MENU }, VIEWPORT)).toEqual({
      left: 795,
      top: 635,
    });
  });

  it("keeps a margin from the near edges when even the flip does not fit", () => {
    // A click near the top-left with a tall menu: flipping would go negative.
    const position = clampMenuPosition({ x: 2, y: 2, ...MENU }, VIEWPORT, 8);
    expect(position).toEqual({ left: 8, top: 8 });
  });

  it("pins a menu taller than the viewport to the top, losing its far end", () => {
    // The head of the menu is what the user needs to see; starting off-screen
    // would hide the first items instead of the last.
    const position = clampMenuPosition(
      { x: 100, y: 400, width: 200, height: 900 },
      VIEWPORT,
    );
    expect(position.top).toBe(4);
  });
});
