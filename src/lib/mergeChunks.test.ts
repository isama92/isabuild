import { describe, expect, it } from "vitest";
import {
  actionsFor,
  chunkAtOffset,
  countConflictMarkers,
  isConflictStart,
  isMarker,
  linesFor,
  lineAlignedEdit,
  markerLines,
  nextConflictLine,
  previousConflictLine,
  sideChunkLines,
  trackedRanges,
  type Chunk,
} from "./mergeChunks";

/** A chunk whose only interesting part is where it sits in the buffer. */
const placed = (start: number, end: number, kind: Chunk["kind"] = "conflict"): Chunk => ({
  kind,
  base: { start: 0, end: 0 },
  ours: { start: 0, end: 0 },
  theirs: { start: 0, end: 0 },
  result: { start, end },
});

const TEXTS = {
  base: ["a", "b", "c", ""],
  ours: ["a", "OURS", "c", ""],
  theirs: ["a", "THEIRS", "c", ""],
};

const CONFLICT: Chunk = {
  kind: "conflict",
  base: { start: 1, end: 2 },
  ours: { start: 1, end: 2 },
  theirs: { start: 1, end: 2 },
  result: { start: 1, end: 2 },
};

describe("marker recognition", () => {
  it("needs seven or more of the character, then a space or the line end", () => {
    expect(isConflictStart("<<<<<<< HEAD")).toBe(true);
    expect(isConflictStart("<<<<<<<")).toBe(true);
    expect(isConflictStart("<<<<<<<<<<<<< long run")).toBe(true);
    expect(isConflictStart("<<<<<< HEAD")).toBe(false);
  });

  it("does not mistake marker-like content for a marker", () => {
    // The rule that keeps a lexer fixture from reading as a conflict: git always
    // separates its label with a single space and never glues anything else on.
    expect(isConflictStart("<<<<<<<<<<x")).toBe(false);
    expect(isMarker("=======no space")).toBe(false);
  });

  it("recognises every marker character for decoration", () => {
    for (const line of ["<<<<<<< a", "=======", ">>>>>>> b", "||||||| base"]) {
      expect(isMarker(line)).toBe(true);
    }
    expect(isMarker("ordinary code")).toBe(false);
  });

  it("reports the line numbers of every marker", () => {
    const text = "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> f\nb";
    expect(markerLines(text)).toEqual([1, 3, 5]);
  });
});

describe("countConflictMarkers", () => {
  it("counts one per opener", () => {
    const text = "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> f\nmid\n<<<<<<< HEAD\nz\n=======\nw\n>>>>>>> f";
    expect(countConflictMarkers(text)).toBe(2);
  });

  it("is zero for a resolved buffer", () => {
    expect(countConflictMarkers("just\nsome\ncode\n")).toBe(0);
  });

  it("still counts a half-edited block, so the file is not offered as finished", () => {
    // The cautious direction: the `>>>>>>>` is gone, but an opener without a
    // terminator is still unresolved work. The backend agrees and refuses the write.
    expect(countConflictMarkers("<<<<<<< HEAD\nx\n=======\ny\n")).toBe(1);
  });

  it("does not count a stray terminator as a conflict", () => {
    // A lone `>>>>>>>` opens nothing. Counting it would leave the user with a
    // count they can never get to zero.
    expect(countConflictMarkers("code\n>>>>>>> f\nmore\n")).toBe(0);
  });
});

describe("actionsFor", () => {
  it("offers all four choices on a real conflict", () => {
    expect(actionsFor("conflict")).toEqual({
      ours: true,
      theirs: true,
      base: true,
      both: true,
    });
  });

  it("never offers a chunk the side it already holds", () => {
    // Otherwise the button would be a no-op that looks like it did something.
    expect(actionsFor("ours").ours).toBe(false);
    expect(actionsFor("theirs").theirs).toBe(false);
  });

  it("lets an auto-applied change be reverted or swapped", () => {
    // The reason non-conflicting chunks get arrows at all: reviewing the whole
    // merge, not just the parts git could not decide.
    expect(actionsFor("ours")).toMatchObject({ base: true, theirs: true });
    expect(actionsFor("theirs")).toMatchObject({ base: true, ours: true });
  });

  it("offers nothing on an unchanged chunk", () => {
    expect(actionsFor("unchanged")).toEqual({
      ours: false,
      theirs: false,
      base: false,
      both: false,
    });
  });

  it("offers only the base on an agreed chunk", () => {
    // Both sides wrote the same text, so ours and theirs are the same answer.
    expect(actionsFor("agreed")).toEqual({
      ours: false,
      theirs: false,
      base: true,
      both: false,
    });
  });
});

describe("linesFor", () => {
  it("takes the lines from the side that was chosen", () => {
    expect(linesFor(CONFLICT, "ours", TEXTS)).toEqual(["OURS"]);
    expect(linesFor(CONFLICT, "theirs", TEXTS)).toEqual(["THEIRS"]);
    expect(linesFor(CONFLICT, "base", TEXTS)).toEqual(["b"]);
  });

  it("puts ours before theirs for both, and never the base", () => {
    expect(linesFor(CONFLICT, "both", TEXTS)).toEqual(["OURS", "THEIRS"]);
  });

  it("clamps a range against a text that has since got shorter", () => {
    // A stale chunk model against a reloaded file: a short slice renders wrong, an
    // out-of-range one throws inside a render.
    const stale: Chunk = { ...CONFLICT, ours: { start: 1, end: 99 } };
    expect(linesFor(stale, "ours", TEXTS)).toEqual(["OURS", "c", ""]);
  });

  it("returns nothing for an empty side, which is a real resolution", () => {
    const deletion: Chunk = { ...CONFLICT, ours: { start: 1, end: 1 } };
    expect(linesFor(deletion, "ours", TEXTS)).toEqual([]);
  });
});

describe("trackedRanges", () => {
  const text = "a\nb\nc\n";

  it("turns a line span into the offsets of those lines, newline included", () => {
    const [range] = trackedRanges(text, [placed(1, 2)]);
    expect(text.slice(range.from, range.to)).toBe("b\n");
  });

  it("tiles the buffer exactly when given the whole chunk list", () => {
    // Every offset belongs to one span, so no click can fall between two chunks.
    const ranges = trackedRanges(text, [placed(0, 1), placed(1, 2), placed(2, 4)]);
    expect(ranges[0].from).toBe(0);
    expect(ranges[0].to).toBe(ranges[1].from);
    expect(ranges[1].to).toBe(ranges[2].from);
    expect(ranges[2].to).toBe(text.length);
  });

  it("handles an empty span as an insertion point", () => {
    // A chunk one side deleted entirely has no lines in the buffer at all.
    const [range] = trackedRanges(text, [placed(1, 1)]);
    expect(range.from).toBe(range.to);
    expect(range.from).toBe(2);
  });

  it("puts an empty span past the last line at the end of the buffer", () => {
    const [range] = trackedRanges("a", [placed(1, 1)]);
    expect(range.from).toBe(1);
    expect(range.to).toBe(1);
  });

  it("clamps a span that runs past the buffer instead of throwing", () => {
    // A chunk model that has got ahead of the text must degrade to a harmless
    // edit, not blow up inside a click handler.
    const [range] = trackedRanges("short", [placed(40, 90)]);
    expect(range.from).toBe(5);
    expect(range.to).toBe(5);
  });
});

describe("lineAlignedEdit", () => {
  /** The slice of CodeMirror's Text the function needs, over a plain string. */
  function doc(text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
    return {
      length: text.length,
      lineAt(pos: number) {
        let index = 0;
        while (index + 1 < starts.length && starts[index + 1] <= pos) index += 1;
        const from = starts[index];
        const next = text.indexOf("\n", from);
        return { from, to: next === -1 ? text.length : next };
      },
    };
  }

  /** Apply the computed change, so the assertions read as before/after. */
  function applied(text: string, from: number, to: number, lines: string[]): string {
    const change = lineAlignedEdit(doc(text), from, to, lines);
    return text.slice(0, change.from) + change.insert + text.slice(change.to);
  }

  it("replaces the lines a span covers and leaves the structure alone", () => {
    expect(applied("a\nb\nc\n", 2, 4, ["B"])).toBe("a\nB\nc\n");
    expect(applied("a\nb\nc\n", 2, 4, ["B1", "B2"])).toBe("a\nB1\nB2\nc\n");
  });

  it("removes the line outright when a side has no lines", () => {
    // Not a blank line where the chunk was: taking a side that deleted these lines
    // has to delete them.
    expect(applied("a\nb\nc\n", 2, 4, [])).toBe("a\nc\n");
  });

  it("takes the leading newline when deleting the last line", () => {
    // There is no trailing newline to consume, so it has to consume the one in
    // front or the file gains a blank final line.
    expect(applied("a\nb", 2, 3, [])).toBe("a");
  });

  it("replaces the last line of a buffer with no trailing newline", () => {
    expect(applied("a\nb", 2, 3, ["B"])).toBe("a\nB");
  });

  it("appends after the last line without joining onto it", () => {
    // The file-corrupting case this function was rewritten for. A buffer with no
    // trailing newline whose final chunk is empty on the side being taken — one side
    // deleted the last line — gives an empty span at the very end. Reading that as a
    // plain insertion produced "ab" from "a" and "b", which then had no markers and
    // was written and staged silently.
    expect(applied("a", 1, 1, ["b"])).toBe("a\nb");
  });

  it("inserts a whole line at a line boundary", () => {
    expect(applied("a\nb\n", 2, 2, ["x"])).toBe("a\nx\nb\n");
  });

  it("does nothing for an empty span and no lines", () => {
    expect(applied("a\nb\n", 2, 2, [])).toBe("a\nb\n");
  });

  it("replaces the whole buffer when the span covers it", () => {
    expect(applied("a\nb\nc\n", 0, 6, ["X"])).toBe("X\n");
  });

  it("survives a span whose neighbour has already been deleted", () => {
    // The reason nothing about the separator is remembered. Delete the middle
    // chunk, then act on the last one: its mapped span no longer has the newline in
    // front of it that a captured answer would have counted on.
    const first = lineAlignedEdit(doc("a\nb\nc"), 2, 4, []);
    const after = "a\nb\nc".slice(0, first.from) + first.insert + "a\nb\nc".slice(first.to);
    expect(after).toBe("a\nc");
    // The last chunk's span, mapped through that deletion, is now [2, 3).
    expect(applied(after, 2, 3, ["C"])).toBe("a\nC");
  });

  it("clamps offsets outside the document", () => {
    expect(applied("a\nb", 99, 200, ["X"])).toBe("a\nb\nX");
  });
});

describe("chunkAtOffset", () => {
  const ranges = trackedRanges("a\nb\nc\n", [placed(0, 1), placed(1, 2), placed(2, 3)]);

  it("finds the chunk containing the cursor", () => {
    expect(chunkAtOffset(ranges, 0)?.index).toBe(0);
    expect(chunkAtOffset(ranges, 3)?.index).toBe(1);
  });

  it("gives a boundary to the chunk that starts there", () => {
    expect(chunkAtOffset(ranges, 2)?.index).toBe(1);
  });

  it("falls back to the last chunk at the very end of the document", () => {
    // Otherwise the toolbar goes blank with the cursor at the end of the file.
    expect(chunkAtOffset(ranges, 999)?.index).toBe(2);
  });

  it("is null when there are no chunks", () => {
    expect(chunkAtOffset([], 0)).toBeNull();
  });
});

describe("sideChunkLines", () => {
  it("maps a side's first line to its chunk", () => {
    const chunks: Chunk[] = [
      { ...placed(0, 1, "ours"), ours: { start: 0, end: 2 } },
      { ...placed(1, 2, "theirs"), ours: { start: 2, end: 2 } },
    ];
    const lines = sideChunkLines(chunks, "ours");
    expect(lines.get(0)).toBe(0);
    expect(lines.get(2)).toBe(1);
  });

  it("keeps the earlier chunk when two start on the same line", () => {
    // Happens where one of them is empty on this side; the earlier one is what
    // the arrow at that line means.
    const chunks: Chunk[] = [
      { ...placed(0, 1), ours: { start: 3, end: 3 } },
      { ...placed(1, 2), ours: { start: 3, end: 4 } },
    ];
    expect(sideChunkLines(chunks, "ours").get(3)).toBe(0);
  });
});

describe("conflict navigation", () => {
  const text = "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> f\nb\n<<<<<<< HEAD\nz\n=======\nw\n>>>>>>> f";

  it("finds the next conflict after the cursor", () => {
    expect(nextConflictLine(text, 0)).toBe(1);
    expect(nextConflictLine(text, 1)).toBe(7);
  });

  it("wraps to the top rather than dying at the last conflict", () => {
    // A dead "next" button at the last conflict reads as broken.
    expect(nextConflictLine(text, 7)).toBe(1);
  });

  it("finds the previous conflict and wraps to the bottom", () => {
    expect(previousConflictLine(text, 8)).toBe(7);
    expect(previousConflictLine(text, 1)).toBe(7);
  });

  it("has nowhere to go in a resolved buffer", () => {
    expect(nextConflictLine("clean\ncode", 0)).toBeNull();
    expect(previousConflictLine("clean\ncode", 0)).toBeNull();
  });
});
