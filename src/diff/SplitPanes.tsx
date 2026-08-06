// The two-pane diff: HEAD on the left, the working tree on the right.
//
// `@codemirror/merge`'s MergeView gives most of what this needs — two panes,
// per-pane line numbers, character-level highlighting, an editable right side,
// and the control that copies a block from HEAD into the working file
// (`revertControls`). Three things it does not give, which is most of what is
// below: a change map, a draggable divider, and any bound on how long the diff
// may take.
//
// Content flows one way: `left`/`right` are what to *display*, and edits are
// reported through `onRightChange`. Nothing feeds the buffer back down as
// `right` — that would fight the user's typing.
//
// Two structural facts about a MergeView worth knowing before changing anything
// here, because both are surprising:
//
// - **The editors do not scroll; the MergeView container does.** The package
//   forces `height: auto` and `overflow-y: visible` on each editor and scrolls
//   its own wrapper, which is how it keeps the two sides aligned. So there is one
//   scroller for both panes, and `mergeRef.current.dom` is it.
// - **The panes are aligned with spacer blocks**, which are widgets in the
//   editors' own content. That is why the change map can measure one side and
//   describe both: `contentHeight` already includes the other side's insertions.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { StateEffect } from "@codemirror/state";
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
  readOnlyFocusableExtensions,
  searchExtensions,
  themeTransaction,
} from "../editor/codemirror";
import { iconElement } from "../editor/iconElement";
import { clampTo, DIFF_TIMEOUT_MS, type DiffViewProps } from "./diffView";

/** Neither pane may be squeezed below this fraction of the width. */
const MIN_PANE = 0.15;

export interface SplitPanesProps extends DiffViewProps {
  /**
   * Where the divider sat when this pane was last torn down, as a fraction of
   * the width, or null for the package's default. A drag writes `flexGrow` onto
   * the MergeView's own DOM nodes, so it does not survive a remount — and this
   * pane is remounted every time the view mode changes or the window loads
   * another file. Without carrying it, a dragged divider would snap back to the
   * middle on every one of those.
   */
  splitFraction: number | null;
  onSplitFraction: (fraction: number) => void;
}

export function SplitPanes({
  left,
  right,
  rightRevision,
  path,
  rightEditable,
  collapse,
  theme,
  splitFraction,
  onRightChange,
  onMeasure,
  onLayout,
  onReady,
  takeHandoff,
  onHandoff,
  onSplitFraction,
}: SplitPanesProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  /** Where to draw the drag handle, in pixels from the host's left edge. */
  const [sashX, setSashX] = useState<number | null>(null);

  // Values that only seed the editors, and callbacks their own listeners reach
  // for, read through refs so they are not effect dependencies that would tear
  // the MergeView down and rebuild it — which would re-run the diff and lose the
  // scroll position mid-review. Same shape as MergePanes.
  const seedRef = useRef({ left, right, rightEditable, collapse, theme, splitFraction });
  const changeRef = useRef(onRightChange);
  const measureRef = useRef(onMeasure);
  const layoutRef = useRef(onLayout);
  const fractionRef = useRef(onSplitFraction);
  const takeHandoffRef = useRef(takeHandoff);
  const handoffRef = useRef(onHandoff);

  /**
   * The revision this pane has already taken from disk.
   *
   * Seeded rather than started at -1, so the follow-`right` effect below does
   * nothing on mount. It has to be inert there: a pane mounted from a handoff
   * holds an unsaved edit, while `right` is the older content the window froze to
   * protect it, and a mount-time adopt would push that older content straight
   * over the edit.
   */
  const adoptedRef = useRef(rightRevision);

  // Declared before the construction effect so it always runs first.
  useEffect(() => {
    changeRef.current = onRightChange;
    measureRef.current = onMeasure;
    layoutRef.current = onLayout;
    fractionRef.current = onSplitFraction;
    takeHandoffRef.current = takeHandoff;
    handoffRef.current = onHandoff;
  }, [onHandoff, onLayout, onMeasure, onRightChange, onSplitFraction, takeHandoff]);

  /**
   * Re-measure the change map, and report the divider's position.
   *
   * Both answers come from the live view rather than from the line counts: with
   * spacer blocks above a chunk and unchanged stretches possibly collapsed below
   * it, a chunk's height on screen is not a function of its line numbers. See
   * `lib/diffStripes` for why the arithmetic still lives outside this file.
   */
  const measureFrameRef = useRef<number | null>(null);
  /** Ends a divider drag that is still in progress. See `startDrag`. */
  const endDragRef = useRef<(() => void) | null>(null);
  /** The last stripes reported, so an unchanged map is not sent again. */
  const stripesRef = useRef<ReturnType<typeof computeStripes>>([]);

  const measureNow = useCallback(() => {
    const merge = mergeRef.current;
    const host = hostRef.current;
    if (!merge || !host) return;

    const view = merge.b;
    const clamp = (pos: number) => Math.min(Math.max(pos, 0), view.state.doc.length);
    const geometry: StripeGeometry = {
      top: (pos) => view.lineBlockAt(clamp(pos)).top,
      bottom: (pos) => view.lineBlockAt(clamp(pos)).bottom,
      contentHeight: view.contentHeight,
    };
    // Replaced only when it actually differs: this runs from an update listener,
    // and a fresh array every time would re-render the toolbar on every scroll.
    const next = computeStripes(merge.chunks, geometry);
    if (!sameStripes(stripesRef.current, next)) stripesRef.current = next;

    // `imprecise` is reported from here rather than once at construction:
    // `precise` is a property of the *current* diff, and the diff is recomputed
    // on every edit and on every side replaced. Said once at mount it would go
    // stale in both directions — a warning left up after the file was edited back
    // down to a small diff, or, worse, absent on a coarse diff that arrived
    // through a reload.
    measureRef.current({
      changeCount: merge.chunks.length,
      imprecise: merge.chunks.some((chunk) => !chunk.precise),
      stripes: stripesRef.current,
    });

    const origin = host.getBoundingClientRect().left;
    // The right editor's left edge is where the header should split: it puts the
    // revert column on the HEAD side, which is the side its control restores from.
    layoutRef.current({
      mode: "split",
      splitAt: merge.b.dom.getBoundingClientRect().left - origin,
    });
    // The handle sits on the seam between the left pane and the revert column, so
    // dragging it never lands on a revert control. With no revert column it is the
    // seam between the panes. This runs from an update listener, so it is a
    // setState per scroll frame — but React bails out on an unchanged number, and
    // the seam only moves when the layout does.
    const revert = host.querySelector(".cm-merge-revert") ?? merge.b.dom;
    setSashX(revert.getBoundingClientRect().left - origin);
  }, []);

  /**
   * Ask for a re-measure on the next frame.
   *
   * Coalesced because the caller is often CodeMirror's own update listener, and
   * three `getBoundingClientRect` calls there force a synchronous layout in the
   * middle of the update cycle — on every keystroke, in a pane that auto-saves.
   * One frame's delay costs the change map nothing.
   */
  const remeasure = useCallback(() => {
    if (measureFrameRef.current !== null) return;
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measureNow();
    });
  }, [measureNow]);

  // --- navigation -----------------------------------------------------------

  const goToChange = useCallback((direction: "next" | "previous") => {
    const view = mergeRef.current?.b;
    if (!view) return;
    const command = direction === "next" ? goToNextChunk : goToPreviousChunk;
    command(view);
    view.focus();
  }, []);

  /** Scroll a chunk into view without moving the cursor, for a click on the map. */
  const seek = useCallback((index: number) => {
    const merge = mergeRef.current;
    const chunk = merge?.chunks[index];
    if (!merge || !chunk) return;
    const top = merge.b.lineBlockAt(Math.min(chunk.fromB, merge.b.state.doc.length)).top;
    // The container is the scroller, not the editor — see the note at the top.
    // A third of a screen of lead-in, so the change is not flush against the edge.
    merge.dom.scrollTop = Math.max(0, top - merge.dom.clientHeight / 3);
  }, []);

  // --- construction ---------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const seed = seedRef.current;
    // What the previous pane held, which is not always what the window last read
    // from disk. See `DiffHandoff`.
    const handoff = takeHandoffRef.current();
    // The revision the handed-over document belongs to, not this render's prop.
    // They differ when an adopt from disk lands in the same commit as a mode
    // switch: the incoming pane then holds pre-adopt content, and seeding from the
    // prop would tell it the adopt had already been taken, leaving it on stale
    // content until the next revision moved.
    if (handoff) adoptedRef.current = handoff.revision;
    const startingDoc = handoff?.doc ?? seed.right;

    const merge = new MergeView({
      parent: host,
      orientation: "a-b",
      // The left side is a git blob: it can be read, never written. `readOnly`
      // stops commands and typing while leaving the pane focusable, which is what
      // lets Ctrl+F and a copy work in it — a keystroke never reaches a pane that
      // cannot take focus. A dispatch from this component still applies, which is
      // how a new commit reaches it.
      a: {
        doc: seed.left,
        extensions: [
          ...paneExtensions(seed.theme),
          ...readOnlyFocusableExtensions(),
          ...searchExtensions(),
        ],
      },
      b: {
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
          // Deliberately short of a full editor: no autocompletion, no
          // auto-closing brackets. Language-aware indent on a new line comes
          // with the loaded language, and that is the depth this window is for.
          // PANE_KEYMAP rather than `defaultKeymap`: see its comment for the
          // keystroke that would otherwise reorder this file behind your back.
          keymap.of([...PANE_KEYMAP, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            // Fires for typing, for a revert click, and for our own adoption of a
            // reload; the window decides which of those is worth saving.
            if (update.docChanged) changeRef.current(update.state.doc.toString());
            if (update.docChanged || update.geometryChanged) remeasure();
          }),
        ],
      },
      // Restores a block from HEAD into the working file. The package positions
      // the button and owns the click; only the glyph is ours.
      //
      // Withheld entirely for a deleted file rather than disabled, for the reason
      // `UnifiedPane` withholds its own: the package's `revertClicked` ends in a
      // plain `dest.dispatch({ changes })`, and `EditorState.readOnly` is a facet
      // *commands* consult, not `dispatch`. So the insert would land, the update
      // listener would report it, `handleRightChange` would drop it on
      // `right === null`, and the user would watch a block reappear that is never
      // written and is wiped by the next refresh, with no error anywhere.
      revertControls: seed.rightEditable ? "a-to-b" : undefined,
      renderRevertControl: () => {
        const button = document.createElement("button");
        button.appendChild(iconElement("chevrons-right"));
        button.setAttribute("aria-label", "Restore this block from HEAD");
        button.setAttribute("title", "Restore this block from HEAD");
        return button;
      },
      highlightChanges: true,
      // The line numbers already mark the changed lines' position, and a second
      // gutter stripe beside them is what this window does without.
      gutter: false,
      collapseUnchanged: seed.collapse ? {} : undefined,
      diffConfig: { timeout: DIFF_TIMEOUT_MS },
    });
    mergeRef.current = merge;
    applyFraction(merge, seed.splitFraction);

    // Synchronously for the first pass, so the headers are not a frame late.
    measureNow();

    // The MergeView measures itself on an animation frame, and its spacers do not
    // exist until it has: measuring the map before that would place every mark
    // against an unspaced height. A second pass once the frame has run is the
    // cheapest way to be right without reaching into its internals. Restoring the
    // scroll waits for the same frame, and for the same reason — before it, every
    // line is at zero.
    const frame = requestAnimationFrame(() => {
      measureNow();
      if (handoff) {
        merge.dom.scrollTop = merge.b.lineBlockAt(clampTo(handoff.topPos, startingDoc)).top;
      }
    });

    // Both the window resizing and the divider moving change where the split is
    // and how tall the content is.
    const observer = new ResizeObserver(remeasure);
    observer.observe(host);
    observer.observe(merge.a.dom);

    return () => {
      cancelAnimationFrame(frame);
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = null;
      observer.disconnect();
      // Before `destroy`, or there is nothing left to read it from.
      const selection = merge.b.state.selection.main;
      handoffRef.current({
        doc: merge.b.state.doc.toString(),
        anchor: selection.anchor,
        head: selection.head,
        topPos: merge.b.lineBlockAtHeight(merge.dom.scrollTop).from,
        revision: adoptedRef.current,
      });
      // Ends a drag that is still in progress: the listeners are on `window`, so
      // without this they would outlive the panes they are resizing.
      endDragRef.current?.();
      merge.destroy();
      mergeRef.current = null;
    };
  }, [measureNow, remeasure]);

  // Handed up in a layout effect so the shell has it before the first paint, and
  // withdrawn on unmount so a toolbar click can never reach a destroyed view.
  useLayoutEffect(() => {
    onReady({ goToChange, seek });
    return () => onReady(null);
  }, [goToChange, onReady, seek]);

  // The *shape* before the first paint, ahead of the construction effect that
  // measures where the divider actually is. React runs layout effects before it
  // paints and passive effects after, so reporting this only from the measure
  // would give the header one frame describing the pane that just went — a single
  // unified header over two panes, or two halves and a border over one document.
  useLayoutEffect(() => {
    layoutRef.current({ mode: "split", splitAt: null });
  }, []);

  // --- following the props --------------------------------------------------

  // A new commit, or an external edit the window decided to adopt. Guarded by an
  // equality check so a re-render with unchanged content never resets the cursor,
  // the scroll position or the undo stack — and never re-runs the diff.
  useEffect(() => {
    const view = mergeRef.current?.a;
    if (!view || view.state.doc.toString() === left) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: left } });
    // Re-measure explicitly, because nothing else will. A change to *this* side
    // reaches the other one as a bare `setChunks` effect — MergeView's `dispatch`
    // gives the non-target pane `other.update([…])` with no changes in it — so the
    // update listener sees neither `docChanged` nor, unless the spacers happened
    // to move, `geometryChanged`. Without this the strip keeps painting chunks a
    // new HEAD no longer has.
    remeasure();
  }, [left, remeasure]);

  // Driven by the revision *moving*, not by the props differing — see the prop's
  // doc comment: an adopt can hand back a string this editor was already shown,
  // and the revision is what makes that visible. Checking the movement rather than
  // the value is also what keeps this inert on mount, which matters because a pane
  // mounted from a handoff holds an edit that `right` is deliberately older than.
  // The value guard still stands, so a bump whose content the editor already holds
  // resets nothing.
  useEffect(() => {
    if (adoptedRef.current === rightRevision) return;
    adoptedRef.current = rightRevision;
    const view = mergeRef.current?.b;
    if (!view || view.state.doc.toString() === right) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: right } });
  }, [right, rightRevision]);

  useEffect(() => {
    const merge = mergeRef.current;
    if (!merge) return;
    merge.b.dispatch(editableTransaction(rightEditable));
    // And withdraw the revert controls with it: a watcher refresh can delete the
    // file under an editable pane, and a control left behind would restore a block
    // that is then silently dropped. See the construction call for why.
    merge.reconfigure({ revertControls: rightEditable ? "a-to-b" : undefined });
  }, [rightEditable]);

  // Collapsing is a MergeView option rather than an extension, so it is a
  // reconfigure. Cheap: it does not rebuild the editors or recompute the diff.
  useEffect(() => {
    const merge = mergeRef.current;
    if (!merge) return;
    merge.reconfigure({ collapseUnchanged: collapse ? {} : undefined });
    // The bands it inserts or removes change every height below them.
    remeasure();
  }, [collapse, remeasure]);

  // Highlighting, loaded lazily. A file with no matching language stays plain
  // text, which is a perfectly good answer for a `.txt` diff.
  useEffect(() => {
    let cancelled = false;
    const descriptor = languageForPath(path, languages);
    if (!descriptor) return;
    void descriptor.load().then((support) => {
      const merge = mergeRef.current;
      if (cancelled || !merge) return;
      for (const view of [merge.a, merge.b]) {
        view.dispatch({ effects: StateEffect.appendConfig.of(support.extension) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Appearance reaches the panes two ways, as in the merge window: the font
  // through the CSS custom properties the theme reads, needing only a re-measure;
  // the colours through a compartment reconfigure, because a highlight style is
  // compiled into CodeMirror's own stylesheet.
  useEffect(() => {
    const merge = mergeRef.current;
    if (!merge) return;
    const spec = themeTransaction(theme);
    for (const view of [merge.a, merge.b]) {
      view.dispatch(spec);
      view.requestMeasure();
    }
    remeasure();
  }, [remeasure, theme]);

  // --- the divider ----------------------------------------------------------

  /**
   * Drag the divider.
   *
   * MergeView lays its two editors out as flex children with `flex-basis: 0`, so
   * their widths are their `flex-grow` values in proportion, and moving the
   * divider is setting those. Safe to do behind the package's back because line
   * wrapping is off in these panes: width cannot change any line's height, so
   * nothing it has measured for the alignment goes stale.
   */
  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      const merge = mergeRef.current;
      if (!host || !merge) return;

      event.preventDefault();
      const box = host.getBoundingClientRect();
      let latest: number | null = null;

      const move = (pointer: PointerEvent) => {
        latest = Math.min(
          1 - MIN_PANE,
          Math.max(MIN_PANE, (pointer.clientX - box.left) / box.width),
        );
        applyFraction(merge, latest);
      };

      // Three ways a drag ends, and only one of them is the obvious one:
      // `pointerup`, the OS cancelling the pointer (a touch or pen gesture, a
      // window losing the device), and the panes going away underneath — a refresh
      // that finds the file binary unmounts them mid-drag. All three run this, and
      // the construction effect's cleanup holds it for the third.
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        endDragRef.current = null;
        // Reported once at the end rather than on every pointer move: the shell
        // only needs it to survive a remount, and a setState per frame of a drag
        // would re-render the toolbar for nothing.
        if (latest !== null) fractionRef.current(latest);
        // The ResizeObserver reports the new widths, but the panes' content
        // height can change with them, so ask for a fresh measure either way.
        remeasure();
      };

      endDragRef.current?.();
      endDragRef.current = stop;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [remeasure],
  );

  return (
    <>
      <div className="diff-editor" ref={hostRef} data-testid="diff-editor" />
      {sashX !== null && (
        <div
          className="diff-sash"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panes"
          style={{ left: `${sashX}px` }}
          onPointerDown={startDrag}
        />
      )}
    </>
  );
}

/** Set the panes' widths, in proportion. See `startDrag` for why this works. */
function applyFraction(merge: MergeView, fraction: number | null): void {
  if (fraction === null) return;
  const wrapA = merge.a.dom.parentElement;
  const wrapB = merge.b.dom.parentElement;
  if (!wrapA || !wrapB) return;
  wrapA.style.flexGrow = String(fraction);
  wrapB.style.flexGrow = String(1 - fraction);
}
