// The padding that makes ours | result | theirs start every chunk on the same
// screen row.
//
// `@codemirror/merge` does this for the diff window with spacer widgets, but its
// aligner is a private function inside the `MergeView` class and a `MergeView` is
// strictly two documents, so a three-pane editor cannot borrow it. This is our
// version of the same idea, and the arithmetic is deliberately all that lives
// here: `merge/MergePanes` turns what comes out into block widgets.
//
// ## Lines, where the package counts pixels
//
// `updateSpacers` measures `lineBlockAt(pos).top` on each side, because a
// `MergeView` cannot assume anything about its editors' geometry. These three
// panes can: wrapping is off (see editor/codemirror's theme) and all three read
// one theme, so every line in every pane is exactly one line high and a line
// count converts to pixels by a single multiplication the caller does. That is
// what keeps this module pure, and testable in jsdom, which cannot measure at all.
//
// ## One idea: the block
//
// A *block* is a stretch of the file the three panes must occupy the same rows
// for, described by how many real lines each pane spends in it. Its height is the
// tallest of the three, and each pane's padding is the difference. Chunk-level
// alignment is one block per chunk; marker-aware alignment inside a conflict is
// seven. Both go through the same walk, so the fallback needs no second code path.

import { markerKind, type ChunkKind } from "./mergeChunks";

/** The three panes, in the order they are on screen. */
export const PANES = ["ours", "result", "theirs"] as const;

export type PaneName = (typeof PANES)[number];

/** One chunk, as much of it as the alignment needs. */
export interface AlignChunk {
  /**
   * Only `conflict` is looked at, and only to decide whether to go looking for
   * marker lines. A file whose *content* happens to contain `<<<<<<<`, a lexer
   * fixture say, would otherwise get its unchanged lines aligned against a block
   * that is not one.
   */
  kind: ChunkKind;
  /** Lines this chunk covers in our pane. */
  ours: number;
  /** Lines this chunk covers in their pane. */
  theirs: number;
  /** Lines this chunk covers in the result pane, as the buffer is *now*. */
  result: number;
  /**
   * Those lines' text, needed only to find the marker block inside a conflict,
   * and read from the buffer as it is now rather than as it was loaded: the user
   * can type a marker in or delete one out, and where the side panes belong has
   * to follow the text that is actually there.
   *
   * Left out everywhere else on purpose, so a recompute on every keystroke does
   * not slice a whole document's worth of strings it will not read. A count that
   * disagrees with the text is treated as no text at all: the two coming from
   * different reads is exactly when a marker offset would land on the wrong line.
   */
  lines?: readonly string[];
}

/**
 * Padding for one pane: `lines` blank lines' worth of height immediately before
 * `line` (0-based). A `line` equal to the pane's line count is the very end of
 * the document.
 */
export interface Spacer {
  line: number;
  lines: number;
}

export type Alignment = Record<PaneName, Spacer[]>;

/** How many lines each pane spends in one block. */
type Block = Record<PaneName, number>;

/** The part of CodeMirror's `Text` that [`lineSpan`] needs. */
export interface LineSpanDoc {
  length: number;
  lines: number;
  lineAt(pos: number): { from: number; number: number };
}

/**
 * The lines an offset span covers, as 0-based inclusive bounds, or null for a span
 * that covers none.
 *
 * The caller has offsets because that is what survives an edit (see
 * `trackedRanges`), and the alignment counts lines, so this conversion sits
 * between them. Two edges, both of which have produced a visibly wrong layout:
 *
 * - **A span ending exactly on a line boundary** stops at the line before it.
 *   Chunk spans tile the buffer, so `to` is normally the *next* chunk's first
 *   line, and counting it would give every chunk one line too many.
 * - **A span reaching the end of the buffer covers the buffer's last line**, even
 *   when that line is the empty one a trailing newline leaves behind. An offset
 *   span cannot express it otherwise: the empty final line begins exactly at
 *   `doc.length`, so half-open arithmetic drops it, and the result pane then
 *   measures one line short of the document it is. That put a phantom spacer at
 *   the bottom of both side panes for every file that ends in a newline, which is
 *   nearly all of them.
 */
export function lineSpan(
  doc: LineSpanDoc,
  from: number,
  to: number,
): { first: number; last: number } | null {
  const first = doc.lineAt(Math.max(0, Math.min(from, doc.length))).number - 1;
  if (to <= from) return null;
  if (to >= doc.length) return { first, last: doc.lines - 1 };
  const line = doc.lineAt(to);
  return { first, last: line.number - 1 - (line.from === to ? 1 : 0) };
}

/**
 * Where each pane needs padding for the three to line up.
 *
 * `totals` is each pane's own line count, and it is not redundant: the chunk
 * ranges are expected to tile each pane exactly, but a stale model or a range
 * that outruns a text does happen, and the three documents ending at different
 * heights is the one failure the shared scroller cannot absorb. A closing spacer
 * on the short panes is the cheap insurance, and it is what
 * `@codemirror/merge` does at its own document end too.
 */
export function alignPanes(
  chunks: readonly AlignChunk[],
  totals: Record<PaneName, number>,
): Alignment {
  const out: Alignment = { ours: [], result: [], theirs: [] };
  const at: Record<PaneName, number> = { ours: 0, result: 0, theirs: 0 };

  for (const chunk of chunks) {
    for (const block of blocksFor(chunk)) {
      const height = Math.max(block.ours, block.result, block.theirs);
      for (const pane of PANES) {
        at[pane] += block[pane];
        const padding = height - block[pane];
        if (padding > 0) pad(out[pane], at[pane], padding);
      }
    }
  }

  const heights = PANES.map((pane) => totals[pane] + spacerLines(out[pane]));
  const bottom = Math.max(...heights);
  PANES.forEach((pane, index) => {
    const short = bottom - heights[index];
    if (short > 0) pad(out[pane], totals[pane], short);
  });

  return out;
}

/** Total padding a pane has, in lines. */
export function spacerLines(spacers: readonly Spacer[]): number {
  return spacers.reduce((total, spacer) => total + spacer.lines, 0);
}

/**
 * Whether two runs of padding would paint the same.
 *
 * Not a nicety: the alignment is recomputed on every document change, and
 * dispatching a transaction that changes nothing means a fresh state field value
 * per keystroke and a re-render of every pane behind it. `@codemirror/merge`
 * compares its own spacers for the same reason.
 */
export function sameSpacers(a: readonly Spacer[], b: readonly Spacer[]): boolean {
  return (
    a.length === b.length &&
    a.every((spacer, index) => spacer.line === b[index].line && spacer.lines === b[index].lines)
  );
}

/**
 * Add padding, merging it into the spacer already at that line.
 *
 * Two blocks in a row can pad the same pane at the same place: for the ours pane
 * the `=======` line, their section and the `>>>>>>>` line are three consecutive
 * blocks it spends no lines in. One widget of the combined height is what those
 * mean, and coalescing here is also what makes the output comparable, so a
 * recompute that changes nothing dispatches nothing.
 */
function pad(spacers: Spacer[], line: number, lines: number): void {
  const last = spacers[spacers.length - 1];
  if (last !== undefined && last.line === line) last.lines += lines;
  else spacers.push({ line, lines });
}

function blocksFor(chunk: AlignChunk): Block[] {
  const lines = chunk.lines !== undefined && chunk.lines.length === chunk.result ? chunk.lines : [];
  const sections = chunk.kind === "conflict" ? conflictSections(lines) : null;
  // No block to align against: one block for the whole chunk, so the three panes
  // start together and each pads at its own bottom. This is the resolved case, the
  // half-edited case, and every non-conflicting chunk.
  if (sections === null) {
    return [{ ours: chunk.ours, result: chunk.result, theirs: chunk.theirs }];
  }
  const blocks: Block[] = [];
  const resultOnly = (lines: number) => {
    if (lines > 0) blocks.push({ ours: 0, result: lines, theirs: 0 });
  };
  resultOnly(sections.lead);
  resultOnly(1); // `<<<<<<<`
  blocks.push({ ours: chunk.ours, result: sections.ours, theirs: 0 });
  // The diff3 base section, `|||||||` included: it belongs to neither side pane,
  // so both of them pad across it.
  resultOnly(sections.base === null ? 0 : sections.base + 1);
  resultOnly(1); // `=======`
  blocks.push({ ours: 0, result: sections.theirs, theirs: chunk.theirs });
  resultOnly(1); // `>>>>>>>`
  resultOnly(sections.trail);
  return blocks;
}

/** A marker block's parts, as line counts. */
interface Sections {
  /** Lines before the `<<<<<<<`, which the user typed into the chunk. */
  lead: number;
  ours: number;
  /** Lines of the diff3 base section, or null when there is none. */
  base: number | null;
  theirs: number;
  /** Lines after the `>>>>>>>`. */
  trail: number;
}

/**
 * The marker block in a conflict chunk's result lines, or null if there is not a
 * complete one.
 *
 * Strict about the order, and that is the point: a half-deleted block is exactly
 * when marker-aware alignment would put a side pane against the wrong text, so
 * "no complete block" has to be an answer rather than a best guess. Padding then
 * degrades to the chunk as a whole, which is never wrong, only coarser.
 */
function conflictSections(lines: readonly string[]): Sections | null {
  const start = find(lines, 0, "start");
  if (start === null) return null;
  const separator = find(lines, start + 1, "separator");
  if (separator === null) return null;
  const end = find(lines, separator + 1, "end");
  if (end === null) return null;
  const base = find(lines, start + 1, "base");
  const baseAt = base !== null && base < separator ? base : null;
  return {
    lead: start,
    ours: (baseAt ?? separator) - start - 1,
    base: baseAt === null ? null : separator - baseAt - 1,
    theirs: end - separator - 1,
    trail: lines.length - end - 1,
  };
}

function find(lines: readonly string[], from: number, kind: string): number | null {
  for (let index = from; index < lines.length; index += 1) {
    if (markerKind(lines[index]) === kind) return index;
  }
  return null;
}
