// The chunk model as the panes consume it, plus the buffer arithmetic that has to
// happen on every keystroke.
//
// The model itself is computed in Rust (src-tauri/src/mergechunks.rs) and arrives
// with the stages; these types mirror those structs. What lives here is only what
// the editor needs *between* IPC calls: how many conflicts the buffer still has,
// which chunk to jump to next, and what a chunk's replacement text is.
//
// On the duplicated marker scan: `countConflictMarkers` deliberately re-implements
// a slice of Rust's `parse_conflicts`, because the count updates as the user types
// and an IPC round trip per keystroke would be absurd. The two are not equal
// authorities — the backend re-parses on write and **refuses** to stage a file
// that still has markers, so a drift here can only ever mislabel a button, never
// get a `>>>>>>>` into a commit.

import type { LineRange } from "./gitMerge";

/** Mirrors Rust's `ChunkKind`. */
export type ChunkKind = "unchanged" | "ours" | "theirs" | "agreed" | "conflict";

/**
 * Mirrors Rust's `PlacedChunk`: one run of the file in all four coordinate
 * systems.
 *
 * `result` is where the chunk sits in the buffer **as first loaded**, and it is
 * what makes a chunk actionable: a non-conflicting one has no markers to be found
 * by. The editor maps it through the user's own edits from there, so it goes stale
 * as soon as anything is typed — read it from the editor's state field, never
 * from here, once the buffer has changed.
 */
export interface Chunk {
  kind: ChunkKind;
  base: LineRange;
  ours: LineRange;
  theirs: LineRange;
  result: LineRange;
}

/**
 * A conflict marker line: at least seven of the marker character, then a space or
 * the end of the line.
 *
 * The trailing-space rule is what keeps a marker apart from a line of `<<<<<<<<<<`
 * in someone's lexer fixture, and it is the same rule Rust's `marker_label`
 * applies — if one of the two ever changes, both must.
 */
const MARKER = /^(<{7,}|={7,}|>{7,}|\|{7,})( |$)/;

/** Whether `line` opens a conflict, i.e. is a `<<<<<<<` marker. */
export function isConflictStart(line: string): boolean {
  return /^<{7,}( |$)/.test(line);
}

/** Whether `line` is a conflict marker of any kind, for decorating it. */
export function isMarker(line: string): boolean {
  return MARKER.test(line);
}

/** Which of the four marker lines this is, in the order they appear in a block. */
export type MarkerKind = "start" | "base" | "separator" | "end";

const MARKER_KINDS: ReadonlyArray<readonly [string, MarkerKind]> = [
  ["<", "start"],
  ["|", "base"],
  ["=", "separator"],
  [">", "end"],
];

/**
 * The marker a line is, or null.
 *
 * `base` is git's diff3 style, which this app never writes: Rust's
 * `serialize_result` emits the two-sided form. It is recognised all the same,
 * because the merge window can be opened on the file *git* wrote, and a user with
 * `merge.conflictStyle = diff3` has a `|||||||` section in it.
 */
export function markerKind(line: string): MarkerKind | null {
  if (!MARKER.test(line)) return null;
  const found = MARKER_KINDS.find(([character]) => line.startsWith(character));
  return found ? found[1] : null;
}

/**
 * How many conflicts `text` still contains, counted the way git counts them: one
 * per `<<<<<<<` opener.
 *
 * Openers rather than complete blocks, and that is the cautious direction: a
 * half-edited block with its `>>>>>>>` deleted still reads as one unresolved
 * conflict here, so the file is not offered as finished. The backend agrees — it
 * refuses any text `parse_conflicts` finds a block in.
 */
export function countConflictMarkers(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (isConflictStart(line)) count += 1;
  }
  return count;
}

/** 0-based line numbers of every marker in `text`, for the pane decorations. */
export function markerLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (isMarker(line)) lines.push(index);
  });
  return lines;
}

/** Which sides a chunk can be resolved to, given what it already holds. */
export interface ChunkActions {
  /** Take our side's version of these lines. */
  ours: boolean;
  /** Take their side's version. */
  theirs: boolean;
  /** Go back to the merge base, discarding a change one side made. */
  base: boolean;
  /** Ours followed by theirs — only meaningful where the two differ. */
  both: boolean;
}

/**
 * The actions worth offering for a chunk.
 *
 * An already-applied one-sided change gets arrows too (the user chose "every chunk
 * is actionable"): taking `base` is how you reject a change git applied for you,
 * and taking the *other* side is how you replace it. What is never offered is the
 * option a chunk already holds, so no button is a no-op.
 */
export function actionsFor(kind: ChunkKind): ChunkActions {
  switch (kind) {
    case "unchanged":
      // Nothing happened here. Offering "take ours" would be offering the base
      // again under another name.
      return { ours: false, theirs: false, base: false, both: false };
    case "ours":
      return { ours: false, theirs: true, base: true, both: false };
    case "theirs":
      return { ours: true, theirs: false, base: true, both: false };
    case "agreed":
      // Both sides wrote the same text, so ours and theirs are the same answer and
      // only reverting to base says anything new.
      return { ours: false, theirs: false, base: true, both: false };
    case "conflict":
      return { ours: true, theirs: true, base: true, both: true };
  }
}

/** Which of the three texts a chunk's lines come from. */
export type ChunkSide = "ours" | "theirs" | "base" | "both";

/**
 * The lines a chunk becomes when resolved to `side`.
 *
 * `both` is ours then theirs, in that order, and never includes the base: the
 * base is context explaining the conflict, not a third version anyone wants.
 */
export function linesFor(
  chunk: Chunk,
  side: ChunkSide,
  texts: { base: string[]; ours: string[]; theirs: string[] },
): string[] {
  const slice = (range: LineRange, from: string[]) =>
    from.slice(range.start, Math.min(range.end, from.length));
  switch (side) {
    case "ours":
      return slice(chunk.ours, texts.ours);
    case "theirs":
      return slice(chunk.theirs, texts.theirs);
    case "base":
      return slice(chunk.base, texts.base);
    case "both":
      return [...slice(chunk.ours, texts.ours), ...slice(chunk.theirs, texts.theirs)];
  }
}

/**
 * The next conflict marker at or after `fromLine`, wrapping to the top.
 *
 * Wrapping rather than stopping at the end: "next conflict" pressed repeatedly
 * should cycle the outstanding work, and a dead button at the last conflict reads
 * as broken.
 */
export function nextConflictLine(text: string, fromLine: number): number | null {
  const starts = conflictStartLines(text);
  if (starts.length === 0) return null;
  return starts.find((line) => line > fromLine) ?? starts[0];
}

/** The previous conflict marker before `fromLine`, wrapping to the bottom. */
export function previousConflictLine(text: string, fromLine: number): number | null {
  const starts = conflictStartLines(text);
  if (starts.length === 0) return null;
  const earlier = starts.filter((line) => line < fromLine);
  return earlier.length > 0 ? earlier[earlier.length - 1] : starts[starts.length - 1];
}

/**
 * A chunk's span in the buffer, as character offsets, ready to be mapped through
 * the user's edits.
 *
 * Offsets rather than line numbers because that is what CodeMirror's `mapPos`
 * takes: a line number stops meaning anything the moment a line is added above it.
 */
export interface TrackedChunk {
  /** Index into the chunk array this came from. */
  index: number;
  from: number;
  to: number;
}

/** Character offset of the start of every line in `text`. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/**
 * Convert every chunk's line span in `text` into an offset span.
 *
 * Done once, against the buffer as loaded; from then on the editor maps these
 * through its own transactions. Spans are clamped, so a chunk model that has got
 * ahead of the text degrades to a no-op edit rather than throwing inside a click
 * handler.
 */
export function trackedRanges(text: string, chunks: readonly Chunk[]): TrackedChunk[] {
  const starts = lineStarts(text);
  const lineCount = starts.length;
  return chunks.map((chunk, index) => {
    const start = Math.min(chunk.result.start, lineCount);
    const end = Math.min(Math.max(chunk.result.end, start), lineCount);
    return {
      index,
      from: start < lineCount ? starts[start] : text.length,
      // Up to the start of the line after the span, so consecutive spans tile the
      // buffer exactly and each one carries the newline that terminates it.
      to: end < lineCount ? starts[end] : text.length,
    };
  });
}

/** The subset of CodeMirror's `Text` that [`lineAlignedEdit`] needs. */
export interface DocLines {
  length: number;
  lineAt(pos: number): { from: number; to: number };
}

/**
 * The document change that replaces whichever whole lines `[from, to)` touches with
 * `lines`.
 *
 * **Computed from the document as it is now, deliberately.** An earlier version
 * captured "which side does the newline go on" alongside the span and mapped it
 * through edits, which is wrong: resolving a neighbouring chunk can delete the very
 * newline the span was going to borrow, and the captured answer then joins two
 * lines into one. Nothing about a separator survives an edit, so nothing about it
 * is remembered.
 *
 * Three cases, all of which have corrupted a file in testing:
 *
 * - **A replacement** takes the lines' own extent, excluding the newline that ends
 *   the last of them — so the surrounding structure is untouched.
 * - **A deletion** (`lines` empty) has to consume one newline as well, or it leaves
 *   a blank line where the chunk was. The trailing one if there is a line after,
 *   else the leading one.
 * - **An empty span** is an insertion point, not a replacement: the new lines need
 *   a separator on whichever side has text against them. At the end of a buffer
 *   with no trailing newline that side is the *front*, which is the case that
 *   turned "a" + "b" into "ab".
 */
export function lineAlignedEdit(
  doc: DocLines,
  from: number,
  to: number,
  lines: readonly string[],
): { from: number; to: number; insert: string } {
  const lo = Math.max(0, Math.min(from, doc.length));
  const hi = Math.max(lo, Math.min(to, doc.length));
  const joined = lines.join("\n");

  if (lo === hi) {
    if (lines.length === 0) return { from: lo, to: hi, insert: "" };
    const atLineStart = doc.lineAt(lo).from === lo;
    return { from: lo, to: hi, insert: atLineStart ? `${joined}\n` : `\n${joined}` };
  }

  const first = doc.lineAt(lo);
  // A span ending exactly on a line boundary stops at the line before it.
  const endsOnBoundary = doc.lineAt(hi).from === hi;
  const last = doc.lineAt(endsOnBoundary ? hi - 1 : hi);
  if (lines.length > 0) {
    return { from: first.from, to: last.to, insert: joined };
  }
  if (last.to < doc.length) {
    return { from: first.from, to: last.to + 1, insert: "" };
  }
  return { from: Math.max(0, first.from - 1), to: last.to, insert: "" };
}

/**
 * The chunk the cursor is in.
 *
 * Spans are contiguous and half-open, so a boundary offset belongs to the chunk
 * that starts there. An offset past the last span — the very end of the document —
 * falls back to the last chunk rather than to nothing, so the toolbar never goes
 * blank with the cursor at the end of the file.
 */
export function chunkAtOffset(
  tracked: readonly TrackedChunk[],
  offset: number,
): TrackedChunk | null {
  const hit = tracked.find((range) => offset >= range.from && offset < range.to);
  return hit ?? tracked[tracked.length - 1] ?? null;
}

/**
 * Line number (0-based) → chunk index, for one side's gutter.
 *
 * Keyed on the chunk's first line on that side. A chunk with nothing on this side
 * (the other side added these lines) still gets an entry at the point where its
 * lines would be, so "take my empty side" is still reachable.
 */
export function sideChunkLines(
  chunks: readonly Chunk[],
  side: "ours" | "theirs",
): Map<number, number> {
  const lines = new Map<number, number>();
  chunks.forEach((chunk, index) => {
    // First entry wins: two chunks can start on the same line where one of them
    // is empty on this side, and the earlier one is the one the arrow means.
    if (!lines.has(chunk[side].start)) lines.set(chunk[side].start, index);
  });
  return lines;
}

/** How a chunk kind is described in the toolbar, in the user's terms. */
export function chunkLabel(kind: ChunkKind): string {
  switch (kind) {
    case "unchanged":
      return "unchanged by both sides";
    case "ours":
      return "changed by you only";
    case "theirs":
      return "changed by them only";
    case "agreed":
      return "changed the same way by both";
    case "conflict":
      return "changed differently by both";
  }
}

function conflictStartLines(text: string): number[] {
  const starts: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (isConflictStart(line)) starts.push(index);
  });
  return starts;
}
