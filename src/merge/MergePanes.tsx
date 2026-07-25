// The three-pane merge editor: ours | result | theirs, and the only module that
// touches CodeMirror.
//
// The counterpart of diff/DiffPane, which is likewise the only module that touches
// Monaco. Keeping each editor library behind exactly one component is what let
// Part 4's Monaco window and this one coexist without either's setup leaking into
// the other's tests.
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
// - **Panes are synchronised proportionally, not aligned.** No filler blocks are
//   inserted (see the plan's known limits), so the panes drift apart in a long
//   file — which is what makes next/previous conflict the primary way to move.
// - **This component is remounted, not updated, when the file is reloaded.** The
//   window keys it on the stages' revision, and only ever hands over new stages it
//   has decided to adopt — so a reload it declined, to protect a touched buffer,
//   leaves these editors alone entirely.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EditorState,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { languageForPath } from "../lib/cmLanguage";
import { currentAppearance, onAppearance } from "../lib/appearance";
import { DEFAULT_THEME } from "../theme/themes";
import { mirrorScrollTop, worthScrolling } from "../lib/paneScroll";
import {
  actionsFor,
  chunkAtOffset,
  chunkLabel,
  countConflictMarkers,
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
import { paneExtensions, readOnlyExtensions, themeTransaction } from "./codemirrorSetup";
import type { ConflictStages } from "../lib/gitMerge";

export interface MergePanesProps {
  path: string;
  stages: ConflictStages;
  /** The result buffer's text. */
  value: string;
  onChange: (text: string) => void;
  /** Disables every action while a write is in flight. */
  busy: boolean;
}

type PaneName = "ours" | "result" | "theirs";
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

class ArrowMarker extends GutterMarker {
  constructor(private readonly glyph: string) {
    super();
  }

  override elementClass = "isabuild-arrow";

  override toDOM() {
    return document.createTextNode(this.glyph);
  }
}

/** `»` applies our side rightwards into the result; `«` brings theirs leftwards. */
const ARROWS: Record<SideName, GutterMarker> = {
  ours: new ArrowMarker("»"),
  theirs: new ArrowMarker("«"),
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

  // --- scroll sync --------------------------------------------------------
  // A flag rather than a debounce: assigning scrollTop fires another scroll event,
  // so without it three panes bounce off each other indefinitely. paneScroll's
  // own tolerance stops most events ever reaching this far.
  const syncing = useRef(false);
  const mirrorFrom = useCallback((source: PaneName) => {
    if (syncing.current) return;
    const from = views.current[source]?.scrollDOM;
    if (!from) return;
    syncing.current = true;
    try {
      for (const name of ["ours", "result", "theirs"] as PaneName[]) {
        const target = views.current[name]?.scrollDOM;
        if (name === source || !target) continue;
        const next = mirrorScrollTop(from, target);
        if (worthScrolling(target.scrollTop, next, lineHeightOf(from))) {
          target.scrollTop = next;
        }
      }
    } finally {
      syncing.current = false;
    }
  }, []);

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
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      view.focus();
      // The other two follow proportionally — the best that can be done without
      // filler blocks to align on.
      mirrorFrom("result");
    },
    [mirrorFrom],
  );

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
      return new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            ...paneExtensions(currentAppearance()?.theme ?? DEFAULT_THEME),
            ...readOnlyExtensions(),
            sideDecorationField(model, side),
            gutter({
              class: "isabuild-arrow-gutter",
              lineMarker: (view, line) =>
                chunkFor(view, line.from) === null ? null : ARROWS[side],
              // The arrows follow the chunk model, which never changes for the
              // life of a read-only pane.
              lineMarkerChange: () => false,
              domEventHandlers: {
                mousedown: (view, line) => {
                  const index = chunkFor(view, line.from);
                  if (index === null) return false;
                  apply(index, side);
                  return true;
                },
              },
            }),
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
          markerHighlight,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
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

    // Scroll listeners go on each scroller directly: `scroll` does not bubble, so
    // CodeMirror's own domEventHandlers (which register on the editor root) never
    // see it.
    const detach = (["ours", "result", "theirs"] as PaneName[]).map((name) => {
      const scroller = views.current[name]?.scrollDOM;
      const listener = () => mirrorFrom(name);
      scroller?.addEventListener("scroll", listener, { passive: true });
      return () => scroller?.removeEventListener("scroll", listener);
    });

    return () => {
      for (const remove of detach) remove();
      for (const view of live) view.destroy();
      views.current = {};
      tracked.current = null;
    };
  }, [apply, mirrorFrom]);

  // Appearance changes reach the panes two different ways.
  //
  // The *font* arrives through CSS custom properties (see codemirrorSetup's
  // theme), so it needs no transaction at all — but CodeMirror caches the
  // character width it measured at startup, and a stale cache puts the cursor,
  // the chunk gutter arrows and the scroll sync at the wrong offsets, so each
  // view is asked to re-measure.
  //
  // The *colours* cannot come from CSS: the highlight style is compiled into
  // CodeMirror's own stylesheet and the chunk tints are theme rules, so both
  // compartments are reconfigured in one transaction per view.
  useEffect(
    () =>
      onAppearance((appearance) => {
        const spec = themeTransaction(appearance.theme);
        for (const view of Object.values(views.current)) {
          if (!view) continue;
          view.dispatch(spec);
          view.requestMeasure();
        }
      }),
    [],
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

  return (
    <div className="merge-panes">
      <div className="merge-toolbar">
        <div className="merge-toolbar-group">
          <button
            type="button"
            className="merge-choice"
            disabled={remaining === 0}
            title="Scroll to the previous conflict"
            onClick={() => goToConflict("previous")}
          >
            ◂ Previous
          </button>
          <button
            type="button"
            className="merge-choice"
            disabled={remaining === 0}
            title="Scroll to the next conflict"
            onClick={() => goToConflict("next")}
          >
            Next ▸
          </button>
        </div>

        <span className="merge-toolbar-current">
          {chunk
            ? `Chunk ${(currentChunk ?? 0) + 1} of ${chunks.length} — ${chunkLabel(chunk.kind)}`
            : "No chunk selected"}
        </span>

        {/* Every chunk is actionable, not only conflicts: taking the base is how a
            change git applied for you gets rejected, and taking the other side is
            how it gets replaced. A side the chunk already holds is never offered. */}
        <div className="merge-toolbar-group">
          <button
            type="button"
            className="merge-choice"
            disabled={busy || !actions?.ours}
            title="Replace this chunk with your version"
            onClick={() => currentChunk !== null && apply(currentChunk, "ours")}
          >
            Take mine
          </button>
          <button
            type="button"
            className="merge-choice"
            disabled={busy || !actions?.theirs}
            title="Replace this chunk with their version"
            onClick={() => currentChunk !== null && apply(currentChunk, "theirs")}
          >
            Take theirs
          </button>
          <button
            type="button"
            className="merge-choice"
            disabled={busy || !actions?.both}
            title="Keep your lines followed by theirs"
            onClick={() => currentChunk !== null && apply(currentChunk, "both")}
          >
            Take both
          </button>
          <button
            type="button"
            className="merge-choice"
            disabled={busy || !actions?.base}
            title="Discard both sides' changes to this chunk"
            onClick={() => currentChunk !== null && apply(currentChunk, "base")}
          >
            Revert to base
          </button>
        </div>
      </div>

      <div className="merge-grid">
        <section className="merge-pane">
          {/* git's own marker label, shown verbatim and never interpreted. */}
          <header className="merge-pane-header merge-pane-header--ours">
            {stages.oursLabel || "ours"} (mine)
          </header>
          <div className="merge-pane-editor" ref={oursHost} data-testid="pane-ours" />
        </section>
        <section className="merge-pane">
          <header className="merge-pane-header merge-pane-header--result">Result</header>
          <div className="merge-pane-editor" ref={resultHost} data-testid="pane-result" />
        </section>
        <section className="merge-pane">
          <header className="merge-pane-header merge-pane-header--theirs">
            {stages.theirsLabel || "theirs"} (theirs)
          </header>
          <div className="merge-pane-editor" ref={theirsHost} data-testid="pane-theirs" />
        </section>
      </div>
    </div>
  );
}

/** Line height in pixels, for the scroll tolerance. Falls back to a sane guess. */
function lineHeightOf(scroller: HTMLElement): number {
  const parsed = Number.parseFloat(getComputedStyle(scroller).lineHeight);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
}
