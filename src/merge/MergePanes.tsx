// The three-pane merge editor: ours | result | theirs.
//
// The counterpart of diff/DiffPane. Both build their editors from editor/codemirror
// and put their buttons through editor/EditorToolbar; what differs is that this one
// resolves a conflict from git's index stages while that one shows a diff, so the
// chunk model here is git's rather than a computed one.
//
// Four things worth knowing:
//
// - **The result buffer is real text, markers included.** An undecided conflict is
//   a `<<<<<<<` block the user can type over, which keeps one definition of
//   "resolved" in play: no markers left, git's own definition, enforced by the
//   backend at write time.
// - **Chunk positions are tracked, not recomputed.** Rust hands over each chunk's
//   span in the buffer as first loaded; from there a StateField maps them through
//   every transaction, so an arrow still hits the right lines after the user has
//   typed above them. What is *not* remembered is where the newline goes — see
//   `lineAlignedEdit`.
// - **The three panes are one scroll box.** There is no scroll sync: the editors
//   are laid out at their natural height and a single container scrolls them, the
//   way a `MergeView` scrolls its container rather than its editors. Alignment is
//   what makes that legitimate, and it comes from block spacer widgets computed by
//   `lib/mergeAlign` — our own, because `@codemirror/merge`'s aligner is private to
//   a class that is strictly two documents. Everything about *where* the padding
//   goes is in that module; what is here is the widget, the recompute and the one
//   number the arithmetic needs from the DOM (a line's height).
// - **This component is remounted, not updated, when the file is reloaded.** The
//   window keys it on the stages' revision, and only ever hands over new stages it
//   has decided to adopt — so a reload it declined, to protect a touched buffer,
//   leaves these editors alone entirely.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { languageForPath } from "../lib/cmLanguage";
import { currentAppearance, onAppearance } from "../lib/appearance";
import { useWindowKeybindings } from "../hooks/useWindowKeybindings";
import { DEFAULT_THEME } from "../theme/themes";
import {
  alignPanes,
  lineSpan,
  sameSpacers,
  PANES,
  type AlignChunk,
  type Alignment,
  // The pane union comes from the alignment module rather than being declared again
  // here: the two would be the same three names in two places, and `PANES` is
  // already imported from it.
  type PaneName,
  type Spacer,
} from "../lib/mergeAlign";
import {
  computeMergeStripes,
  mergeMarkColors,
  MERGE_MARK_LABELS,
  type MergeMarkChunk,
} from "../lib/mergeStripes";
import { sameStripes, stripeAt, type Stripe } from "../lib/overviewStripes";
import { OverviewRuler } from "../editor/OverviewRuler";
import {
  actionsFor,
  chunkAtOffset,
  chunkLabel,
  countConflictMarkers,
  isConflictStart,
  isMarker,
  lineAlignedEdit,
  linesFor,
  nextConflictLine,
  previousConflictLine,
  sideChunkLines,
  trackedRanges,
  type Chunk,
  type ChunkSide,
  type TrackedChunk,
} from "../lib/mergeChunks";
import {
  PANE_KEYMAP,
  paneExtensions,
  readOnlyExtensions,
  themeTransaction,
} from "../editor/codemirror";
import { EditorToolbar, type ToolbarItem } from "../editor/EditorToolbar";
import { Icons } from "../editor/icons";
import { iconElement, type IconName } from "../editor/iconElement";
import { useViewOptions } from "../editor/useViewOptions";
import { viewOptionItems } from "../editor/viewOptions";
import type { ConflictStages } from "../lib/gitMerge";

export interface MergePanesProps {
  path: string;
  stages: ConflictStages;
  /** The result buffer's text. */
  value: string;
  onChange: (text: string) => void;
  /**
   * Whether a write is in flight.
   *
   * Disables the toolbar's chunk actions only. Typing and the gutter arrows stay
   * live, deliberately: the buffer is the user's throughout, and `MergeWindow`'s
   * `commit` is where that decision is paid for.
   */
  busy: boolean;
}

type SideName = "ours" | "theirs";

/**
 * The chunk spans, mapped through every edit.
 *
 * A bias of -1 on the start and 1 on the end keeps a span greedy at its own
 * boundaries, so text typed on a conflict's last line stays inside that conflict
 * rather than escaping into the next chunk.
 */
function trackedField(initial: TrackedChunk[]) {
  return StateField.define<TrackedChunk[]>({
    create: () => initial,
    update: (ranges, transaction) => {
      if (!transaction.docChanged) return ranges;
      return ranges.map((range) => ({
        ...range,
        from: transaction.changes.mapPos(range.from, -1),
        to: transaction.changes.mapPos(range.to, 1),
      }));
    },
  });
}

/** Line tints for one side's pane, in that side's own coordinates. */
function sideDecorations(chunks: readonly Chunk[], side: SideName, doc: Text): DecorationSet {
  const marks = [];
  for (const chunk of chunks) {
    if (chunk.kind === "unchanged") continue;
    const range = chunk[side];
    for (let line = range.start; line < range.end; line += 1) {
      // A chunk range can outrun a text a reload has since shortened.
      if (line + 1 > doc.lines) break;
      marks.push(
        Decoration.line({ class: `isabuild-chunk-${chunk.kind}` }).range(doc.line(line + 1).from),
      );
    }
  }
  return Decoration.set(marks, true);
}

/** Decorations for one read-only side pane. Its document never changes. */
function sideDecorationField(chunks: readonly Chunk[], side: SideName) {
  return StateField.define<DecorationSet>({
    create: (state) => sideDecorations(chunks, side, state.doc),
    update: (value) => value,
    provide: (field) => EditorView.decorations.from(field),
  });
}

function markerDecorations(doc: Text): DecorationSet {
  const marks = [];
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    if (isMarker(line.text)) {
      marks.push(Decoration.line({ class: "isabuild-marker" }).range(line.from));
    }
  }
  return Decoration.set(marks, true);
}

/**
 * Marker-line highlighting for the result pane.
 *
 * Recomputed from the document, not from the chunk model: the user can type a
 * marker in or delete one out, and the highlighting has to follow the text that is
 * actually there rather than the text we started from.
 */
const markerHighlight = StateField.define<DecorationSet>({
  create: (state) => markerDecorations(state.doc),
  update: (value, transaction) =>
    transaction.docChanged ? markerDecorations(transaction.state.doc) : value,
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Alignment padding, as a block widget.
 *
 * The height is what the pane needs to keep step with the tallest of the three,
 * and `estimatedHeight` matters as much as the style: CodeMirror asks for it when
 * the widget is outside the viewport, and without it a spacer below the fold would
 * be guessed at and the alignment would jump as you scrolled into it.
 *
 * `data-lines` carries the arithmetic's own answer. It is the only part of a
 * spacer a jsdom test can read, because pixel heights come from a measured line
 * and jsdom measures nothing.
 */
class SpacerWidget extends WidgetType {
  constructor(
    private readonly lines: number,
    private readonly height: number,
  ) {
    super();
  }

  override eq(other: SpacerWidget) {
    return other.lines === this.lines && other.height === this.height;
  }

  override toDOM() {
    const element = document.createElement("div");
    element.className = "isabuild-spacer";
    this.paint(element);
    return element;
  }

  override updateDOM(dom: HTMLElement) {
    this.paint(dom);
    return true;
  }

  override get estimatedHeight() {
    return this.height;
  }

  /** Clicks land on the pane behind rather than being swallowed by the padding. */
  override ignoreEvent() {
    return false;
  }

  private paint(element: HTMLElement) {
    element.style.height = `${this.height}px`;
    element.dataset.lines = String(this.lines);
  }
}

/**
 * The whole of a pane's padding, replaced at once.
 *
 * One effect carrying the finished set, rather than incremental edits, because
 * the alignment is a function of the three documents together: there is no such
 * thing as adjusting one spacer correctly on its own. Mapped through changes so a
 * spacer stays put in the transaction that arrives before the next recompute.
 */
const setSpacers = StateEffect.define<DecorationSet>({
  map: (value, mapping) => value.map(mapping),
});

const spacerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (spacers, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setSpacers)) return effect.value;
    }
    return spacers.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** One pane's padding as decorations, in that pane's own coordinates. */
function spacerDecorations(
  view: EditorView,
  spacers: readonly Spacer[],
  lineHeight: number,
): DecorationSet {
  const doc = view.state.doc;
  const ranges = spacers.map((spacer) => {
    // A spacer at the pane's line count is the closing one, and the end of the
    // document has no following line to sit in front of.
    const atEnd = spacer.line >= doc.lines;
    const position = atEnd ? doc.length : doc.line(spacer.line + 1).from;
    return Decoration.widget({
      widget: new SpacerWidget(spacer.lines, spacer.lines * lineHeight),
      block: true,
      side: atEnd ? 1 : -1,
    }).range(position);
  });
  return Decoration.set(ranges, true);
}

class ArrowMarker extends GutterMarker {
  constructor(
    private readonly icon: IconName,
    private readonly title: string,
  ) {
    super();
  }

  override elementClass = "isabuild-arrow";

  override toDOM() {
    const element = iconElement(this.icon);
    // A `title` rather than an `aria-label`: CodeMirror marks the whole gutter
    // `aria-hidden`, so nothing here reaches a screen reader whatever it is
    // labelled. The toolbar's Take mine / Take theirs are the accessible route to
    // the same actions, as the change strip's marks are to the same chunks.
    element.setAttribute("title", this.title);
    return element;
  }
}

/**
 * An arrow points from the side it takes towards the result, and each gutter is
 * placed on the seam between those two panes — see the note in `sidePane`.
 */
const ARROWS: Record<SideName, GutterMarker> = {
  ours: new ArrowMarker("chevrons-right", "Replace this chunk with your version"),
  theirs: new ArrowMarker("chevrons-left", "Replace this chunk with their version"),
};

export function MergePanes({ path, stages, value, onChange, busy }: MergePanesProps) {
  // Three separate refs rather than one object holding them: the react-hooks lint
  // rule reads any property access on such an object as touching a ref during
  // render, and it is not wrong to be strict about that.
  const oursHost = useRef<HTMLDivElement>(null);
  const resultHost = useRef<HTMLDivElement>(null);
  const theirsHost = useRef<HTMLDivElement>(null);
  const views = useRef<Partial<Record<PaneName, EditorView>>>({});
  const tracked = useRef<StateField<TrackedChunk[]> | null>(null);
  const [currentChunk, setCurrentChunk] = useState<number | null>(null);
  const [stripes, setStripes] = useState<readonly Stripe[]>([]);
  const [theme, setTheme] = useState(() => currentAppearance()?.theme ?? DEFAULT_THEME);
  const { state: viewOptions, set: setViewOption } = useViewOptions();

  // Values that only seed the editors, and callbacks their own listeners reach
  // for, read through refs so they are not effect dependencies that would tear an
  // editor down and rebuild it mid-edit. Same shape as DiffPane.
  //
  // `stages` goes through a ref for a sharper reason than tidiness. If it were a
  // dependency of `apply`, and `apply` a dependency of the construction effect
  // below, then *a new stages object of identical content* would destroy all three
  // editors and rebuild them from `seed` — a ref frozen at first render. The
  // window's watcher reload produces exactly such an object, and the user's
  // half-finished resolution would silently revert to the pristine marker text
  // while the buffer state still said otherwise.
  const seed = useRef({ value, stages });
  const modelRef = useRef(stages);
  const changeRef = useRef(onChange);
  useEffect(() => {
    modelRef.current = stages;
    changeRef.current = onChange;
  }, [onChange, stages]);

  const chunks = stages.chunks;

  // --- alignment and the change map ---------------------------------------
  //
  // Both come out of one pass over the chunk model, because both need the same
  // thing: where every chunk is in the result buffer *now*. The padding follows
  // from `lib/mergeAlign`, the marks from `lib/mergeStripes`, and the only number
  // taken from the DOM is how tall a line is.
  /** The last padding dispatched, so a recompute that changes nothing dispatches nothing. */
  const alignedRef = useRef<{ lineHeight: number; alignment: Alignment } | null>(null);
  const pendingRef = useRef(false);

  const measureNow = useCallback(() => {
    const result = views.current.result;
    const field = tracked.current;
    if (!result || !field) return;
    const model = modelRef.current.chunks;
    const spans = result.state.field(field);
    const doc = result.state.doc;
    const lineHeight = result.defaultLineHeight;

    const alignChunks: AlignChunk[] = [];
    const markChunks: MergeMarkChunk[] = [];
    model.forEach((chunk, index) => {
      const span = spans[index];
      const from = Math.min(span?.from ?? 0, doc.length);
      const to = Math.min(Math.max(span?.to ?? from, from), doc.length);
      const covered = lineSpan(doc, from, to);
      const first = covered?.first ?? doc.lineAt(from).number - 1;
      // An empty span covers no line, which is `last` one before `first`.
      const last = covered?.last ?? first - 1;
      const lines =
        chunk.kind === "conflict"
          ? // Sliced for conflicts only: that is the one kind whose *text* decides
            // where the padding goes, and slicing every chunk would mean a
            // document's worth of strings on every keystroke.
            Array.from({ length: last - first + 1 }, (_, offset) => doc.line(first + offset + 1).text)
          : undefined;
      alignChunks.push({
        kind: chunk.kind,
        ours: chunk.ours.end - chunk.ours.start,
        theirs: chunk.theirs.end - chunk.theirs.start,
        result: last - first + 1,
        lines,
      });
      markChunks.push({
        kind: chunk.kind,
        from,
        to,
        // A conflict counts as decided once its opener is gone, which is git's own
        // definition and the one the toolbar count and the write path both use.
        resolved: lines !== undefined && !lines.some(isConflictStart),
      });
    });

    const alignment = alignPanes(alignChunks, {
      ours: views.current.ours?.state.doc.lines ?? 0,
      result: doc.lines,
      theirs: views.current.theirs?.state.doc.lines ?? 0,
    });

    // The line height is part of what is compared, not just the padding: a font
    // change moves every spacer without moving a single line.
    const previous = alignedRef.current;
    const remeasured = previous === null || previous.lineHeight !== lineHeight;
    for (const pane of PANES) {
      const view = views.current[pane];
      if (!view) continue;
      if (!remeasured && sameSpacers(previous.alignment[pane], alignment[pane])) continue;
      view.dispatch({
        effects: setSpacers.of(spacerDecorations(view, alignment[pane], lineHeight)),
      });
    }
    alignedRef.current = { lineHeight, alignment };

    // Measured after the padding is in, so the marks describe the aligned content.
    // The dispatch above changes the geometry, which asks for another pass through
    // the update listener; that one finds nothing to change and settles.
    const geometry = {
      top: (position: number) => result.lineBlockAt(position).top,
      bottom: (position: number) => result.lineBlockAt(position).bottom,
      contentHeight: result.contentHeight,
    };
    setStripes((current) => {
      const next = computeMergeStripes(markChunks, geometry);
      return sameStripes(current, next) ? current : next;
    });
  }, []);

  /**
   * Ask for a recompute, once, as soon as the current update has finished.
   *
   * A microtask rather than an animation frame, which is what `DiffPane` uses and
   * what `@codemirror/merge` uses for its own spacers, and the difference is
   * deliberate:
   *
   * - It has to leave the update cycle. The recompute dispatches into all three
   *   editors, and doing that from inside one of their update listeners is not
   *   allowed.
   * - It must not wait for a frame. The padding would then be one frame behind the
   *   text, so the side panes would sit visibly out of step by however many lines
   *   were just typed, which is exactly what this part exists to stop.
   * - Nothing here forces a layout. The three numbers it reads — the default line
   *   height, the content height, a line block's top — come from CodeMirror's
   *   height map rather than the DOM, so there is no `getBoundingClientRect` cost
   *   to amortise onto a frame, which is the reason the diff window's map waits for
   *   one. When a font change *does* need a fresh measurement, it reaches this
   *   through `geometryChanged` once CodeMirror has taken it.
   */
  const remeasure = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    queueMicrotask(() => {
      pendingRef.current = false;
      // A recompute queued just before unmount finds no views and does nothing.
      measureNow();
    });
  }, [measureNow]);

  /** Replace a chunk's span in the result buffer with one side's lines. */
  const apply = useCallback((chunkIndex: number, side: ChunkSide) => {
    const view = views.current.result;
    const field = tracked.current;
    const model = modelRef.current;
    const chunk = model.chunks[chunkIndex];
    if (!view || !field || !chunk) return;
    const range = view.state.field(field)[chunkIndex];
    if (!range) return;
    const lines = linesFor(chunk, side, model);
    // Resolved against the live document, never against remembered geometry: see
    // lineAlignedEdit's comment for the newline bug that taught us why.
    const change = lineAlignedEdit(view.state.doc, range.from, range.to, lines);
    view.dispatch({
      changes: change,
      // Leave the cursor where the change landed, so the toolbar follows the work
      // instead of describing a chunk the user has moved on from.
      selection: { anchor: change.from },
    });
    view.focus();
  }, []);

  /**
   * `apply` against whatever chunk the cursor is in.
   *
   * A named handler rather than an arrow inside the toolbar's item list: `apply`
   * reads refs, and the lint rule cannot tell a callback stored in a data structure
   * from one called during render. Closing over `currentChunk` here keeps the
   * distinction visible instead of suppressed.
   */
  const applyToCurrent = useCallback(
    (side: ChunkSide) => {
      if (currentChunk === null) return;
      apply(currentChunk, side);
    },
    [apply, currentChunk],
  );

  const goToConflict = useCallback(
    (direction: "next" | "previous") => {
      const view = views.current.result;
      if (!view) return;
      const text = view.state.doc.toString();
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      const target =
        direction === "next"
          ? nextConflictLine(text, cursorLine)
          : previousConflictLine(text, cursorLine);
      if (target === null) return;
      const line = view.state.doc.line(Math.min(target + 1, view.state.doc.lines));
      // The other two panes need no telling: one container scrolls all three, and
      // CodeMirror walks up to it for `scrollIntoView` itself.
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      view.focus();
    },
    [],
  );

  /**
   * Scroll a chunk into view without moving the cursor, for a click on the map.
   *
   * Through CodeMirror's own effect rather than by assigning `scrollTop`: the
   * scroller is an ancestor of the editor here, and `scrollIntoView` is what knows
   * how to walk up to it. The margin keeps the chunk off the top edge, under the
   * sticky pane headers.
   */
  const seek = useCallback((index: number) => {
    const view = views.current.result;
    const field = tracked.current;
    if (!view || !field) return;
    const span = view.state.field(field)[index];
    if (!span) return;
    const position = Math.min(span.from, view.state.doc.length);
    view.dispatch({ effects: EditorView.scrollIntoView(position, { y: "start", yMargin: 24 }) });
  }, []);

  const chunkAt = useCallback((fraction: number) => stripeAt(stripes, fraction), [stripes]);

  // --- editor construction ------------------------------------------------
  useEffect(() => {
    const nodes = {
      ours: oursHost.current,
      result: resultHost.current,
      theirs: theirsHost.current,
    };
    if (!nodes.ours || !nodes.result || !nodes.theirs) return;

    const initial = seed.current;
    const model = initial.stages.chunks;
    const field = trackedField(trackedRanges(initial.value, model));
    tracked.current = field;
    const live: EditorView[] = [];

    const sidePane = (host: HTMLDivElement, side: SideName, doc: string) => {
      const chunkOfLine = sideChunkLines(model, side);
      // Only the chunk the line *starts* is actionable from that line, and only
      // for a side the chunk does not already hold — so no arrow is a no-op.
      const chunkFor = (view: EditorView, from: number): number | null => {
        const line = view.state.doc.lineAt(from).number - 1;
        const index = chunkOfLine.get(line);
        if (index === undefined) return null;
        return actionsFor(model[index].kind)[side] ? index : null;
      };
      /**
       * The arrow column, placed on the seam between this pane and the result.
       *
       * A gutter defaults to `side: "before"`, which is its own pane's *left*
       * edge — and the panes are ours | result | theirs, so that put the ours `»`
       * at the far left of the whole window, pointing right at a pane three
       * columns away, while the theirs `«` sat behind its own line numbers. An
       * arrow belongs between the side it takes from and the side it goes to.
       *
       * So ours goes `after`, flush against the ours/result seam, and theirs stays
       * `before` but is raised above `lineNumbers()` so it renders ahead of them
       * rather than inside the pane. `Prec.high` is what does the raising:
       * `activeGutters` is ordered by extension precedence, and `paneExtensions`
       * contributes the line numbers first.
       *
       * No new grid column and no absolute positioning: `.cm-gutters-after` is
       * positioned by CodeMirror's own base theme, and `lib/mergeAlign` is purely
       * vertical, so none of this can disturb the alignment.
       */
      const arrows = gutter({
        class: "isabuild-arrow-gutter",
        side: side === "ours" ? "after" : "before",
        lineMarker: (view, line) => (chunkFor(view, line.from) === null ? null : ARROWS[side]),
        // The arrows follow the chunk model, which never changes for the life of a
        // read-only pane.
        lineMarkerChange: () => false,
        domEventHandlers: {
          mousedown: (view, line) => {
            const index = chunkFor(view, line.from);
            if (index === null) return false;
            apply(index, side);
            return true;
          },
        },
      });

      return new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            side === "theirs" ? Prec.high(arrows) : arrows,
            ...paneExtensions(currentAppearance()?.theme ?? DEFAULT_THEME),
            ...readOnlyExtensions(),
            spacerField,
            sideDecorationField(model, side),
          ],
        }),
      });
    };

    views.current.ours = sidePane(nodes.ours, "ours", initial.stages.ours.join("\n"));
    views.current.theirs = sidePane(nodes.theirs, "theirs", initial.stages.theirs.join("\n"));
    views.current.result = new EditorView({
      parent: nodes.result,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          ...paneExtensions(currentAppearance()?.theme ?? DEFAULT_THEME),
          field,
          spacerField,
          markerHighlight,
          history(),
          // Not `defaultKeymap`: see PANE_KEYMAP for the keystroke that would
          // otherwise reorder the result buffer instead of moving between conflicts.
          keymap.of([...PANE_KEYMAP, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              changeRef.current(update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet) {
              const at = chunkAtOffset(
                update.state.field(field),
                update.state.selection.main.head,
              );
              setCurrentChunk(at?.index ?? null);
            }
            // Every edit moves a chunk boundary, and every geometry change moves
            // the marks. Both are asked for rather than done here: the recompute
            // dispatches into all three editors, which is not something to do from
            // inside one of their update cycles. See `remeasure` for why that is a
            // microtask and not a frame.
            if (update.docChanged || update.geometryChanged) remeasure();
          }),
        ],
      }),
    });
    live.push(views.current.ours, views.current.theirs, views.current.result);

    // The update listener only fires on a change or a selection move, so without
    // this the toolbar would read "No chunk selected" until the user clicked
    // something — describing nothing while the cursor is plainly in chunk 1.
    setCurrentChunk(
      chunkAtOffset(
        views.current.result.state.field(field),
        views.current.result.state.selection.main.head,
      )?.index ?? null,
    );

    // Aligned before the first paint, so the panes are never seen out of step. The
    // line height is an estimate until CodeMirror has measured the font; when the
    // measurement disagrees, its own update carries `geometryChanged` and the
    // listener above asks for the correction.
    measureNow();

    return () => {
      pendingRef.current = false;
      alignedRef.current = null;
      for (const view of live) view.destroy();
      views.current = {};
      tracked.current = null;
    };
  }, [apply, measureNow, remeasure]);

  // Conflict navigation from the keyboard. Registered here rather than in the
  // window because `goToConflict` needs the live result view, and the window
  // has no handle on it.
  useWindowKeybindings("merge", {
    "next-conflict": () => goToConflict("next"),
    "previous-conflict": () => goToConflict("previous"),
  });

  // Appearance changes reach the panes two different ways.
  //
  // The *font* arrives through CSS custom properties (see editor/codemirror's
  // theme), so it needs no transaction at all — but CodeMirror caches the
  // character width it measured at startup, and a stale cache puts the cursor and
  // the chunk gutter arrows at the wrong offsets, so each view is asked to
  // re-measure. A font *size* change also changes how tall a line is, which is the
  // one number the alignment takes from the DOM, hence the recompute.
  //
  // The *colours* cannot come from CSS: the highlight style is compiled into
  // CodeMirror's own stylesheet and the chunk tints are theme rules, so both
  // compartments are reconfigured in one transaction per view. The change map
  // holds the colours it was handed, so it re-renders from the new theme too.
  useEffect(
    () =>
      onAppearance((appearance) => {
        setTheme(appearance.theme);
        const spec = themeTransaction(appearance.theme);
        for (const view of Object.values(views.current)) {
          if (!view) continue;
          view.dispatch(spec);
          view.requestMeasure();
        }
        remeasure();
      }),
    [remeasure],
  );

  // Adopt text the window decided to push in — a reload it judged safe, or the
  // buffer being reset. Guarded on inequality so a re-render never resets the
  // cursor or the undo history.
  useEffect(() => {
    const view = views.current.result;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  // Highlighting, loaded lazily. A file with no matching language stays plain
  // text, which is a perfectly good answer for a `.txt` conflict.
  useEffect(() => {
    let cancelled = false;
    const descriptor = languageForPath(path, languages);
    if (!descriptor) return;
    void descriptor.load().then((support) => {
      if (cancelled) return;
      for (const view of Object.values(views.current)) {
        view?.dispatch({ effects: StateEffect.appendConfig.of(support.extension) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const chunk = currentChunk === null ? null : chunks[currentChunk];
  const actions = chunk ? actionsFor(chunk.kind) : null;
  const remaining = useMemo(() => countConflictMarkers(value), [value]);

  /**
   * The toolbar, as items for the shared component.
   *
   * Built here rather than by the window because every one of them needs the live
   * result view — the same reason the conflict keybindings are registered here.
   * `viewOptionItems` is what a shared button would come in through; the merge
   * window offers none yet, so it contributes nothing and the array is just the
   * chunk actions.
   *
   * One `react-hooks/refs` suppression below, on the line that needs it. `apply`
   * reads the live views out of refs, which is correct — they are not render inputs
   * — and the rule cannot tell a callback *stored* in a data structure from one
   * *called* during render. It does not fire on DiffPane's equivalent item list, so
   * an item list is not by itself what trips it; reaching a ref through two hops
   * inside a `.map()` callback is.
   */
  const items = useMemo<ToolbarItem[]>(
    () => [
      {
        kind: "group",
        id: "navigate",
        items: [
          {
            kind: "button",
            id: "previous-conflict",
            label: "Previous conflict",
            tooltip: "Scroll to the previous conflict",
            icon: Icons.previousChange,
            disabled: remaining === 0,
            onSelect: () => goToConflict("previous"),
          },
          {
            kind: "button",
            id: "next-conflict",
            label: "Next conflict",
            tooltip: "Scroll to the next conflict",
            icon: Icons.nextChange,
            disabled: remaining === 0,
            onSelect: () => goToConflict("next"),
          },
        ],
      },
      {
        kind: "status",
        id: "current",
        text: chunk
          ? `Chunk ${(currentChunk ?? 0) + 1} of ${chunks.length} — ${chunkLabel(chunk.kind)}`
          : "No chunk selected",
      },
      // The status stops growing where it ends, so this is what pins the actions
      // to the right edge.
      { kind: "spacer", id: "gap" },
      // Every chunk is actionable, not only conflicts: taking the base is how a
      // change git applied for you gets rejected, and taking the other side is how
      // it gets replaced. A side the chunk already holds is never offered.
      {
        kind: "group",
        id: "resolve",
        items: (
          [
            ["ours", "Take mine", "Replace this chunk with your version"],
            ["theirs", "Take theirs", "Replace this chunk with their version"],
            ["both", "Take both", "Keep your lines followed by theirs"],
            ["base", "Revert to base", "Discard both sides' changes to this chunk"],
          ] as const
        ).map(([side, label, tooltip]) => ({
          kind: "button" as const,
          id: side,
          label,
          tooltip,
          disabled: busy || !actions?.[side],
          // eslint-disable-next-line react-hooks/refs -- a click handler, not a render-time read
          onSelect: () => applyToCurrent(side),
        })),
      },
      ...viewOptionItems("merge", viewOptions, setViewOption, { disabled: busy }),
    ],
    [
      actions,
      applyToCurrent,
      busy,
      chunk,
      chunks.length,
      currentChunk,
      goToConflict,
      remaining,
      setViewOption,
      viewOptions,
    ],
  );

  return (
    <div className="merge-panes">
      <EditorToolbar items={items} label="Conflict actions" />

      <div className="merge-editor-row">
        {/* One scroller around all three panes, which is what "aligned" means
            here: there is no sync to get wrong because there is one scroll
            position. The headers are sticky rows of the same grid, so they stay
            over their own column however wide the window is. */}
        <div className="merge-scroll" data-testid="merge-scroll">
          <div className="merge-grid">
            {/* git's own marker labels, shown verbatim and never interpreted. */}
            <header className="merge-pane-header merge-pane-header--ours">
              {stages.oursLabel || "ours"} (mine)
            </header>
            <header className="merge-pane-header merge-pane-header--result">Result</header>
            <header className="merge-pane-header merge-pane-header--theirs">
              {stages.theirsLabel || "theirs"} (theirs)
            </header>
            <div className="merge-pane-editor" ref={oursHost} data-testid="pane-ours" />
            <div className="merge-pane-editor" ref={resultHost} data-testid="pane-result" />
            <div className="merge-pane-editor" ref={theirsHost} data-testid="pane-theirs" />
          </div>
        </div>
        <OverviewRuler
          stripes={stripes}
          colors={mergeMarkColors(theme)}
          labels={MERGE_MARK_LABELS}
          onSeek={seek}
          chunkAt={chunkAt}
        />
      </div>
    </div>
  );
}
