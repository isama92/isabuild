import { describe, expect, it } from "vitest";
import { computeMarkers, type LineChangeLike } from "./diffMarkers";

/** Monaco's encoding: `*EndLineNumber === 0` marks the side with no lines. */
function change(
  originalStart: number,
  originalEnd: number,
  modifiedStart: number,
  modifiedEnd: number,
): LineChangeLike {
  return {
    originalStartLineNumber: originalStart,
    originalEndLineNumber: originalEnd,
    modifiedStartLineNumber: modifiedStart,
    modifiedEndLineNumber: modifiedEnd,
  };
}

describe("computeMarkers", () => {
  it("returns nothing for no changes", () => {
    expect(computeMarkers([])).toEqual([]);
    // getLineChanges() returns null while a diff is still computing.
    expect(computeMarkers(null)).toEqual([]);
  });

  it("classifies an insertion as added on both sides", () => {
    const markers = computeMarkers([change(10, 0, 11, 13)]);
    expect(markers).toEqual([
      { kind: "added", side: "original", startLine: 10, endLine: 10 },
      { kind: "added", side: "modified", startLine: 11, endLine: 13 },
    ]);
  });

  it("classifies a deletion as removed on both sides", () => {
    const markers = computeMarkers([change(4, 6, 3, 0)]);
    expect(markers).toEqual([
      { kind: "removed", side: "original", startLine: 4, endLine: 6 },
      { kind: "removed", side: "modified", startLine: 3, endLine: 3 },
    ]);
  });

  it("classifies a replacement as modified with each side's own range", () => {
    const markers = computeMarkers([change(7, 8, 7, 9)]);
    expect(markers).toEqual([
      { kind: "modified", side: "original", startLine: 7, endLine: 8 },
      { kind: "modified", side: "modified", startLine: 7, endLine: 9 },
    ]);
  });

  it("clamps a change anchored before the first line to line 1", () => {
    // Prepending to a file: nothing precedes it, so Monaco reports start 0.
    const markers = computeMarkers([change(0, 0, 1, 2)]);
    expect(markers[0]).toEqual({
      kind: "added",
      side: "original",
      startLine: 1,
      endLine: 1,
    });
  });

  it("maps every change, keeping their order", () => {
    const markers = computeMarkers([change(1, 1, 1, 1), change(20, 0, 21, 21), change(30, 31, 30, 0)]);
    expect(markers.map((marker) => `${marker.side}:${marker.kind}`)).toEqual([
      "original:modified",
      "modified:modified",
      "original:added",
      "modified:added",
      "original:removed",
      "modified:removed",
    ]);
  });
});
