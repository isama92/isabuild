import { describe, expect, it } from "vitest";
import {
  alignPanes,
  lineSpan,
  sameSpacers,
  spacerLines,
  PANES,
  type AlignChunk,
  type Alignment,
} from "./mergeAlign";

// The padding is asserted by *laying the panes out* rather than by reading spacer
// objects: alignment is a claim about which lines end up on which row, and a table
// says that directly where a list of `{line, lines}` needs decoding.
//
// `·` is a padded row. Every test goes through `table`, which also asserts the one
// invariant the shared scroller rests on: the three panes come out the same height.

interface Panes {
  ours: string[];
  result: string[];
  theirs: string[];
}

/** One pane's rows, padding included. */
function laidOut(lines: readonly string[], spacers: Alignment[keyof Alignment]): string[] {
  const rows: string[] = [];
  for (let line = 0; line <= lines.length; line += 1) {
    for (const spacer of spacers.filter((candidate) => candidate.line === line)) {
      for (let n = 0; n < spacer.lines; n += 1) rows.push("·");
    }
    if (line < lines.length) rows.push(lines[line]);
  }
  return rows;
}

/**
 * The three panes as they would be on screen, one row per line: `ours | result |
 * theirs`, padded to a fixed width so the expectation reads as a picture.
 */
function table(panes: Panes, chunks: readonly AlignChunk[]): string {
  const alignment = alignPanes(chunks, {
    ours: panes.ours.length,
    result: panes.result.length,
    theirs: panes.theirs.length,
  });
  const rows = PANES.map((pane) => laidOut(panes[pane], alignment[pane]));
  const heights = rows.map((column) => column.length);
  expect(new Set(heights).size, `panes ended at different heights: ${heights.join(", ")}`).toBe(1);
  return rows[0]
    .map((_, index) => rows.map((column) => column[index].padEnd(16)).join("").trimEnd())
    .join("\n");
}

/** A chunk whose result lines are given, with the side line counts. */
function chunk(
  kind: AlignChunk["kind"],
  ours: number,
  theirs: number,
  lines: string[],
): AlignChunk {
  return { kind, ours, theirs, result: lines.length, lines };
}

describe("alignPanes", () => {
  it("leaves a file both sides agree on untouched", () => {
    const alignment = alignPanes([chunk("unchanged", 2, 2, ["a", "b"])], {
      ours: 2,
      result: 2,
      theirs: 2,
    });
    for (const pane of PANES) expect(alignment[pane]).toEqual([]);
  });

  it("pads the side that did not change a chunk only one side touched", () => {
    // Ours turned one line into two, so the result holds two and theirs still has
    // the one base line. Theirs is the pane with a row to spare.
    const panes: Panes = {
      ours: ["a", "MINE1", "MINE2", "z"],
      result: ["a", "MINE1", "MINE2", "z"],
      theirs: ["a", "b", "z"],
    };
    expect(
      table(panes, [
        chunk("unchanged", 1, 1, ["a"]),
        chunk("ours", 2, 1, ["MINE1", "MINE2"]),
        chunk("unchanged", 1, 1, ["z"]),
      ]),
    ).toBe(
      [
        "a               a               a",
        "MINE1           MINE1           b",
        "MINE2           MINE2           ·",
        "z               z               z",
      ].join("\n"),
    );
  });

  it("puts each side opposite its own half of a conflict block", () => {
    const panes: Panes = {
      ours: ["a", "MINE", "z"],
      result: ["a", "<<<<<<< HEAD", "MINE", "=======", "THEIRS", ">>>>>>> feature", "z"],
      theirs: ["a", "THEIRS", "z"],
    };
    expect(
      table(panes, [
        chunk("unchanged", 1, 1, ["a"]),
        chunk("conflict", 1, 1, [
          "<<<<<<< HEAD",
          "MINE",
          "=======",
          "THEIRS",
          ">>>>>>> feature",
        ]),
        chunk("unchanged", 1, 1, ["z"]),
      ]),
    ).toBe(
      [
        "a               a               a",
        "·               <<<<<<< HEAD    ·",
        "MINE            MINE            ·",
        "·               =======         ·",
        "·               THEIRS          THEIRS",
        "·               >>>>>>> feature ·",
        "z               z               z",
      ].join("\n"),
    );
  });

  it("aligns sides of different lengths inside one block", () => {
    // Two lines against one: the ours section is as tall as the taller side, and
    // the shorter pane pads inside its own half rather than at the end of the chunk.
    const panes: Panes = {
      ours: ["MINE1", "MINE2"],
      result: ["<<<<<<<", "MINE1", "MINE2", "=======", "THEIRS", ">>>>>>>"],
      theirs: ["THEIRS"],
    };
    expect(
      table(panes, [
        chunk("conflict", 2, 1, ["<<<<<<<", "MINE1", "MINE2", "=======", "THEIRS", ">>>>>>>"]),
      ]),
    ).toBe(
      [
        "·               <<<<<<<         ·",
        "MINE1           MINE1           ·",
        "MINE2           MINE2           ·",
        "·               =======         ·",
        "·               THEIRS          THEIRS",
        "·               >>>>>>>         ·",
      ].join("\n"),
    );
  });

  it("keeps an empty side of a conflict in step", () => {
    // "Delete these lines" against an edit: our half of the block has no lines at
    // all, and the ours pane must not borrow a row from their half.
    const panes: Panes = {
      ours: ["a", "z"],
      result: ["a", "<<<<<<<", "=======", "THEIRS", ">>>>>>>", "z"],
      theirs: ["a", "THEIRS", "z"],
    };
    expect(
      table(panes, [
        chunk("unchanged", 1, 1, ["a"]),
        chunk("conflict", 0, 1, ["<<<<<<<", "=======", "THEIRS", ">>>>>>>"]),
        chunk("unchanged", 1, 1, ["z"]),
      ]),
    ).toBe(
      [
        "a               a               a",
        "·               <<<<<<<         ·",
        "·               =======         ·",
        "·               THEIRS          THEIRS",
        "·               >>>>>>>         ·",
        "z               z               z",
      ].join("\n"),
    );
  });

  it("tolerates a diff3 base section, giving it to neither side", () => {
    // git wrote this one, with merge.conflictStyle = diff3. The base lines are
    // context, so both side panes pad across them.
    const panes: Panes = {
      ours: ["MINE"],
      result: ["<<<<<<<", "MINE", "||||||| base", "b", "=======", "THEIRS", ">>>>>>>"],
      theirs: ["THEIRS"],
    };
    expect(
      table(panes, [
        chunk("conflict", 1, 1, [
          "<<<<<<<",
          "MINE",
          "||||||| base",
          "b",
          "=======",
          "THEIRS",
          ">>>>>>>",
        ]),
      ]),
    ).toBe(
      [
        "·               <<<<<<<         ·",
        "MINE            MINE            ·",
        "·               ||||||| base    ·",
        "·               b               ·",
        "·               =======         ·",
        "·               THEIRS          THEIRS",
        "·               >>>>>>>         ·",
      ].join("\n"),
    );
  });

  it("falls back to the chunk as a whole once a block is half deleted", () => {
    // The `=======` is gone, so there is no "their half" to align against and
    // guessing would put their pane opposite our text. Top-aligned instead.
    const panes: Panes = {
      ours: ["MINE"],
      result: ["<<<<<<<", "MINE", "THEIRS", ">>>>>>>"],
      theirs: ["THEIRS"],
    };
    expect(
      table(panes, [chunk("conflict", 1, 1, ["<<<<<<<", "MINE", "THEIRS", ">>>>>>>"])]),
    ).toBe(
      [
        "MINE            <<<<<<<         THEIRS",
        "·               MINE            ·",
        "·               THEIRS          ·",
        "·               >>>>>>>         ·",
      ].join("\n"),
    );
  });

  it("realigns a resolved conflict on the text that replaced it", () => {
    // "Take mine": the markers are gone and the result is our two lines, so ours
    // and the result agree row for row and only theirs pads.
    const panes: Panes = {
      ours: ["MINE1", "MINE2"],
      result: ["MINE1", "MINE2"],
      theirs: ["THEIRS"],
    };
    expect(table(panes, [chunk("conflict", 2, 1, ["MINE1", "MINE2"])])).toBe(
      [
        "MINE1           MINE1           THEIRS",
        "MINE2           MINE2           ·",
      ].join("\n"),
    );
  });

  it("keeps lines typed above and below a block inside the chunk", () => {
    const panes: Panes = {
      ours: ["MINE"],
      result: ["note", "<<<<<<<", "MINE", "=======", "THEIRS", ">>>>>>>", "after"],
      theirs: ["THEIRS"],
    };
    expect(
      table(panes, [
        chunk("conflict", 1, 1, [
          "note",
          "<<<<<<<",
          "MINE",
          "=======",
          "THEIRS",
          ">>>>>>>",
          "after",
        ]),
      ]),
    ).toBe(
      [
        "·               note            ·",
        "·               <<<<<<<         ·",
        "MINE            MINE            ·",
        "·               =======         ·",
        "·               THEIRS          THEIRS",
        "·               >>>>>>>         ·",
        "·               after           ·",
      ].join("\n"),
    );
  });

  it("does not read a marker in a chunk neither side conflicted over", () => {
    // A lexer fixture with `<<<<<<<` in it, unchanged by both sides. Aligning it
    // against a block that is not one would offset the pane by a row.
    const lines = ["<<<<<<<", "=======", ">>>>>>>"];
    const panes: Panes = { ours: lines, result: lines, theirs: lines };
    expect(table(panes, [chunk("unchanged", 3, 3, lines)])).toBe(
      [
        "<<<<<<<         <<<<<<<         <<<<<<<",
        "=======         =======         =======",
        ">>>>>>>         >>>>>>>         >>>>>>>",
      ].join("\n"),
    );
  });

  it("coalesces padding that lands in the same place", () => {
    // For the ours pane the `=======` line, their half and the `>>>>>>>` are three
    // consecutive blocks it spends no lines in. One widget, not three: a spacer per
    // block would make the output differ on every recompute for no reason.
    const alignment = alignPanes(
      [chunk("conflict", 1, 1, ["<<<<<<<", "MINE", "=======", "THEIRS", ">>>>>>>"])],
      { ours: 1, result: 5, theirs: 1 },
    );
    expect(alignment.ours).toEqual([
      { line: 0, lines: 1 },
      { line: 1, lines: 3 },
    ]);
    expect(alignment.theirs).toEqual([
      { line: 0, lines: 3 },
      { line: 1, lines: 1 },
    ]);
    expect(alignment.result).toEqual([]);
  });

  it("levels the panes at the bottom when the chunks do not account for every line", () => {
    // A stale model, or ranges that do not tile a pane exactly. The three
    // documents ending at different heights is the one thing the shared scroller
    // cannot absorb, so the short panes get a closing spacer.
    const alignment = alignPanes([chunk("unchanged", 1, 1, ["a"])], {
      ours: 1,
      result: 4,
      theirs: 2,
    });
    expect(alignment.ours).toEqual([{ line: 1, lines: 3 }]);
    expect(alignment.theirs).toEqual([{ line: 2, lines: 2 }]);
    expect(alignment.result).toEqual([]);
  });

  it("aligns a conflict at chunk level when it was handed no text to read", () => {
    // The caller slices lines for conflicts only. A conflict that arrives without
    // them still has to align, just coarsely.
    const alignment = alignPanes([{ kind: "conflict", ours: 1, theirs: 1, result: 5 }], {
      ours: 1,
      result: 5,
      theirs: 1,
    });
    expect(alignment.ours).toEqual([{ line: 1, lines: 4 }]);
    expect(alignment.theirs).toEqual([{ line: 1, lines: 4 }]);
  });

  it("ignores text whose line count disagrees with the chunk", () => {
    // Two reads of a buffer that moved between them. A marker offset measured
    // against the stale text would land on the wrong line, so the text is dropped
    // rather than trusted.
    const alignment = alignPanes(
      [
        {
          kind: "conflict",
          ours: 1,
          theirs: 1,
          result: 5,
          lines: ["<<<<<<<", "MINE", "=======", ">>>>>>>"],
        },
      ],
      { ours: 1, result: 5, theirs: 1 },
    );
    expect(alignment.ours).toEqual([{ line: 1, lines: 4 }]);
  });

  it("has nothing to say about an empty file", () => {
    const alignment = alignPanes([], { ours: 0, result: 0, theirs: 0 });
    for (const pane of PANES) expect(alignment[pane]).toEqual([]);
  });

  it("adds up a pane's padding", () => {
    expect(
      spacerLines([
        { line: 0, lines: 2 },
        { line: 7, lines: 3 },
      ]),
    ).toBe(5);
  });
});

describe("lineSpan", () => {
  /** A document of fixed-width lines, the shape CodeMirror's `Text` answers with. */
  function doc(text: string): Parameters<typeof lineSpan>[0] {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") starts.push(index + 1);
    }
    return {
      length: text.length,
      lines: starts.length,
      lineAt: (pos: number) => {
        let line = 0;
        while (line + 1 < starts.length && starts[line + 1] <= pos) line += 1;
        return { from: starts[line], number: line + 1 };
      },
    };
  }

  it("stops a span at the line before the boundary it ends on", () => {
    // Chunk spans tile the buffer, so `to` is the next chunk's first line.
    expect(lineSpan(doc("a\nb\nc\nd"), 2, 6)).toEqual({ first: 1, last: 2 });
  });

  it("includes the last line of a span that ends mid-line", () => {
    expect(lineSpan(doc("a\nb\nc\nd"), 2, 5)).toEqual({ first: 1, last: 2 });
  });

  it("keeps the empty line a trailing newline leaves behind", () => {
    // The one that put a phantom spacer at the bottom of every file ending in a
    // newline: the final empty line begins exactly at `doc.length`, so half-open
    // arithmetic drops it and the result pane measures a line short of itself.
    const text = "a\nb\n";
    expect(lineSpan(doc(text), 2, text.length)).toEqual({ first: 1, last: 2 });
  });

  it("covers the last line of a file with no trailing newline", () => {
    const text = "a\nb";
    expect(lineSpan(doc(text), 2, text.length)).toEqual({ first: 1, last: 1 });
  });

  it("answers null for a span that covers nothing", () => {
    // A chunk whose lines have all been deleted: an insertion point, not a run.
    expect(lineSpan(doc("a\nb"), 2, 2)).toBeNull();
  });

  it("clamps a span that starts past the end", () => {
    expect(lineSpan(doc("a\nb"), 99, 99)).toBeNull();
  });
});

describe("sameSpacers", () => {
  const spacers = [
    { line: 0, lines: 1 },
    { line: 4, lines: 2 },
  ];

  it("recognises padding that would paint the same", () => {
    expect(sameSpacers(spacers, [...spacers.map((spacer) => ({ ...spacer }))])).toBe(true);
  });

  it("sees a height change", () => {
    expect(sameSpacers(spacers, [{ line: 0, lines: 1 }, { line: 4, lines: 3 }])).toBe(false);
  });

  it("sees a move", () => {
    expect(sameSpacers(spacers, [{ line: 0, lines: 1 }, { line: 5, lines: 2 }])).toBe(false);
  });

  it("sees one appearing", () => {
    expect(sameSpacers(spacers, spacers.slice(0, 1))).toBe(false);
  });
});
