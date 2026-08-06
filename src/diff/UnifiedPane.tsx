// The one-pane diff: the working tree, with HEAD's lines shown above each change.
//
// A completely different CodeMirror object from `SplitPanes`, despite doing the
// same job. `unifiedMergeView` is an *extension* on a single `EditorView` whose
// document is the working tree; HEAD is not a second editor and not text in the
// document, it is a `StateField` rendered as uneditable block widgets. Almost
// everything surprising below follows from that.
//
// Four properties of the package that had to be checked rather than assumed,
// because each of them is a silent wrong answer rather than an error:
//
// - **A compartment reconfigure re-initialises the original document.** The
//   fields `unifiedMergeView` returns are `.init()`ed from the `original` in the
//   array it is given, and a fresh init spec forces a re-create. So every
//   reconfigure has to pass the HEAD this pane currently believes in, which is
//   why `headRef` exists. Pass a stale one and it quietly rewrites what HEAD said.
// - **`rejectChunk` dispatches straight past `EditorState.readOnly`.** `readOnly`
//   is a facet commands consult, and `view.dispatch` does not. A deleted file
//   therefore gets no controls at all rather than disabled ones.
// - **`mergeControls: true` renders an Accept face**, which dispatches
//   `updateOriginalDoc` — it edits the in-memory copy of HEAD so the chunk stops
//   being highlighted. Against a git blob that is a lie, undone by the next
//   `repo://changed` refresh, so the function form renders the accept face as
//   nothing and only reject survives. Reject is the gesture the split view spells
//   with its own chevron: restore this block from HEAD.
// - **A new commit must arrive as `originalDocChangeEffect`.** It carries no
//   document change, so `docChanged` is false and the window cannot mistake a
//   commit for an edit — the same guarantee the split view gets for free by
//   having two editors.
//
// One capability is genuinely missing here, and it is not worth working around:
// Ctrl+F searches the working tree only, because there is no second editor for it
// to reach. Split remains the default view.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  getOriginalDoc,
  originalDocChangeEffect,
  unifiedMergeView,
} from "@codemirror/merge";
import { ChangeSet, Compartment, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { languageForPath } from "../lib/cmLanguage";
import { computeStripes } from "../lib/diffStripes";
import { sameStripes, type StripeGeometry } from "../lib/overviewStripes";
import {
  editableExtension,
  editableTransaction,
  PANE_KEYMAP,
  paneExtensions,
  searchExtensions,
  themeTransaction,
} from "../editor/codemirror";
import { iconElement } from "../editor/iconElement";
import { clampTo, DIFF_TIMEOUT_MS, type DiffViewProps } from "./diffView";

/** How far down the viewport a sought chunk is placed. Matches `SplitPanes`. */
const SEEK_LEAD_IN = 3;

export function UnifiedPane({
  left,
  right,
  rightRevision,
  path,
  rightEditable,
  collapse,
  theme,
  onRightChange,
  onMeasure,
  onLayout,
  onReady,
  takeHandoff,
  onHandoff,
}: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // `useState` rather than `useRef(...).current`, which cannot be read during
  // render, and rather than `useMemo`, whose cache React is allowed to discard —
  // a discarded compartment would leave every later reconfigure addressing an
  // extension slot the editor no longer has.
  const [mergeCompartment] = useState(() => new Compartment());

  /** The HEAD every reconfigure must carry. See the header comment. */
  const headRef = useRef(left);
  /** The revision already taken from disk. See `SplitPanes` for why it is seeded. */
  const adoptedRef = useRef(rightRevision);

  /**
   * Read by the lazy-language effect, which rebuilds the merge extension and so
   * has to pass the current values — but must not re-run when either of them
   * moves, or it would reload the language and rebuild the widgets all over again.
   */
  const collapseRef = useRef(collapse);
  const editableRef = useRef(rightEditable);

  const seedRef = useRef({ left, right, rightEditable, collapse, theme });
  const changeRef = useRef(onRightChange);
  const measureRef = useRef(onMeasure);
  const layoutRef = useRef(onLayout);
  const takeHandoffRef = useRef(takeHandoff);
  const handoffRef = useRef(onHandoff);
  const stripesRef = useRef<ReturnType<typeof computeStripes>>([]);
  const measureFrameRef = useRef<number | null>(null);

  // Declared before the construction effect so it always runs first.
  useEffect(() => {
    changeRef.current = onRightChange;
    measureRef.current = onMeasure;
    layoutRef.current = onLayout;
    takeHandoffRef.current = takeHandoff;
    handoffRef.current = onHandoff;
    collapseRef.current = collapse;
    editableRef.current = rightEditable;
  }, [collapse, onHandoff, onLayout, onMeasure, onRightChange, rightEditable, takeHandoff]);

  const measureNow = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;

    const { chunks } = getChunks(view.state) ?? { chunks: [] };
    const clamp = (pos: number) => Math.min(Math.max(pos, 0), view.state.doc.length);
    // The same adapter the split view uses, and it is correct here for a reason
    // worth writing down: a deletion is a zero-length *block* widget at `fromB`,
    // and CodeMirror joins an adjacent block widget into that line's block. So
    // `lineBlockAt(fromB).top` is already the top of the deleted lines rather than
    // of the surviving line below them, and `lib/diffStripes` needs no variant.
    const geometry: StripeGeometry = {
      top: (pos) => view.lineBlockAt(clamp(pos)).top,
      bottom: (pos) => view.lineBlockAt(clamp(pos)).bottom,
      contentHeight: view.contentHeight,
    };
    const next = computeStripes(chunks, geometry);
    if (!sameStripes(stripesRef.current, next)) stripesRef.current = next;

    measureRef.current({
      changeCount: chunks.length,
      imprecise: chunks.some((chunk) => !chunk.precise),
      stripes: stripesRef.current,
    });
  }, []);

  const remeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measureNow();
    });
  }, [measureNow]);

  /** The merge extension, rebuilt whenever one of its three inputs moves. */
  const mergeExtension = useCallback(
    (head: string, collapseUnchanged: boolean, editable: boolean): Extension =>
      unifiedMergeView({
        original: head,
        // The function form, never `true`. See the header comment for what the
        // accept face would do to a git blob.
        mergeControls: editable
          ? (type, action) => {
              if (type === "accept") {
                const hidden = document.createElement("span");
                hidden.hidden = true;
                return hidden;
              }
              const button = document.createElement("button");
              button.appendChild(iconElement("chevrons-right"));
              button.setAttribute("aria-label", "Restore this block from HEAD");
              button.setAttribute("title", "Restore this block from HEAD");
              button.onmousedown = action;
              return button;
            }
          : false,
        highlightChanges: true,
        // The line numbers already mark the changed lines, as in the split view.
        gutter: false,
        syntaxHighlightDeletions: true,
        collapseUnchanged: collapseUnchanged ? {} : undefined,
        diffConfig: { timeout: DIFF_TIMEOUT_MS },
      }),
    [],
  );

  // --- navigation -----------------------------------------------------------

  const goToChange = useCallback((direction: "next" | "previous") => {
    const view = viewRef.current;
    if (!view) return;
    (direction === "next" ? goToNextChunk : goToPreviousChunk)(view);
    view.focus();
  }, []);

  const seek = useCallback((index: number) => {
    const view = viewRef.current;
    if (!view) return;
    const chunk = getChunks(view.state)?.chunks[index];
    if (!chunk) return;
    // `lineBlockAt(fromB)` is the joined block, so this scrolls to the top of the
    // deleted lines rather than to the first surviving one below them.
    const top = view.lineBlockAt(Math.min(chunk.fromB, view.state.doc.length)).top;
    view.scrollDOM.scrollTop = Math.max(0, top - view.scrollDOM.clientHeight / SEEK_LEAD_IN);
  }, []);

  // --- construction ---------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const seed = seedRef.current;
    const handoff = takeHandoffRef.current();
    const startingDoc = handoff?.doc ?? seed.right;

    const view = new EditorView({
      parent: host,
      doc: startingDoc,
      selection: handoff
        ? {
            anchor: clampTo(handoff.anchor, startingDoc),
            head: clampTo(handoff.head, startingDoc),
          }
        : undefined,
      extensions: [
        ...paneExtensions(seed.theme),
        ...searchExtensions(),
        editableExtension(seed.rightEditable),
        history(),
        keymap.of([...PANE_KEYMAP, ...historyKeymap, indentWithTab]),
        mergeCompartment.of(mergeExtension(seed.left, seed.collapse, seed.rightEditable)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changeRef.current(update.state.doc.toString());
          if (update.docChanged || update.geometryChanged) remeasure();
        }),
      ],
    });
    viewRef.current = view;

    // One document, so there is no divider for the header to track.
    layoutRef.current({ mode: "unified" });
    // Unlike a MergeView, the chunk field is filled synchronously at
    // `EditorState.create`, so this first pass already has real chunks.
    measureNow();
    const frame = requestAnimationFrame(() => {
      measureNow();
      if (handoff) {
        view.scrollDOM.scrollTop = view.lineBlockAt(clampTo(handoff.topPos, startingDoc)).top;
      }
    });

    const observer = new ResizeObserver(remeasure);
    observer.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = null;
      observer.disconnect();
      const selection = view.state.selection.main;
      handoffRef.current({
        doc: view.state.doc.toString(),
        anchor: selection.anchor,
        head: selection.head,
        topPos: view.lineBlockAtHeight(view.scrollDOM.scrollTop).from,
        revision: adoptedRef.current,
      });
      view.destroy();
      viewRef.current = null;
    };
  }, [measureNow, mergeCompartment, mergeExtension, remeasure]);

  useLayoutEffect(() => {
    onReady({ goToChange, seek });
    return () => onReady(null);
  }, [goToChange, onReady, seek]);

  // --- following the props --------------------------------------------------

  // A new commit. The original is state, not an editor, so this is an effect on a
  // transaction rather than a dispatch into a second view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = getOriginalDoc(view.state);
    if (current.toString() === left) return;
    headRef.current = left;
    // `originalDocChangeEffect` rather than `updateOriginalDoc`: it is the only
    // thing that guarantees the new document and the ChangeSet describe the same
    // edit, and the chunk update consumes both. Hand it a mismatched pair and the
    // chunk list silently diverges from the widgets on screen.
    const changes = ChangeSet.of(
      { from: 0, to: current.length, insert: left },
      current.length,
    );
    view.dispatch({ effects: originalDocChangeEffect(view.state, changes) });
    // Explicitly, for the same reason the split view does it: this transaction
    // carries no document change, so the update listener sees neither
    // `docChanged` nor reliably `geometryChanged`, and only the chunks moved.
    remeasure();
  }, [left, remeasure]);

  useEffect(() => {
    if (adoptedRef.current === rightRevision) return;
    adoptedRef.current = rightRevision;
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === right) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: right } });
  }, [right, rightRevision]);

  // Collapsing and editability both live inside the merge extension, so both are
  // reconfigures — and both must carry the current HEAD. See the header comment.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: mergeCompartment.reconfigure(
        mergeExtension(headRef.current, collapse, rightEditable),
      ),
    });
    remeasure();
  }, [collapse, mergeCompartment, mergeExtension, remeasure, rightEditable]);

  useEffect(() => {
    viewRef.current?.dispatch(editableTransaction(rightEditable));
  }, [rightEditable]);

  // Highlighting, loaded lazily — and then the merge extension is rebuilt, which
  // is not busywork: the deleted-line widgets bake their highlighting in when they
  // are built and cache it, so without a rebuild HEAD's lines would stay plain for
  // the rest of the session while the working tree's were coloured.
  useEffect(() => {
    let cancelled = false;
    const descriptor = languageForPath(path, languages);
    if (!descriptor) return;
    void descriptor.load().then((support) => {
      const view = viewRef.current;
      if (cancelled || !view) return;
      view.dispatch({ effects: StateEffect.appendConfig.of(support.extension) });
      view.dispatch({
        effects: mergeCompartment.reconfigure(
          mergeExtension(headRef.current, collapseRef.current, editableRef.current),
        ),
      });
      remeasure();
    });
    return () => {
      cancelled = true;
    };
  }, [mergeCompartment, mergeExtension, path, remeasure]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(themeTransaction(theme));
    view.requestMeasure();
    remeasure();
  }, [remeasure, theme]);

  return (
    <div className="diff-editor diff-editor--unified" ref={hostRef} data-testid="diff-editor" />
  );
}
