// The two-pane diff editor: HEAD on the left, the working tree on the right.
//
// `@codemirror/merge`'s MergeView gives most of what Part 4 asks for — two panes,
// per-pane line numbers, character-level highlighting, an editable right side, and
// the `»` that copies a block from HEAD into the working file (`revertControls`).
// Three things it does not give, which is most of what is below: a change map, a
// draggable divider, and any bound on how long the diff may take.
//
// Content flows one way: `left`/`right` are what to *display*, and edits are
// reported through `onRightChange`. The parent deliberately does not feed the
// buffer back down as `right` — that would fight the user's typing.
//
// Two structural facts about a MergeView worth knowing before changing anything
// here, because both are surprising:
//
// - **The editors do not scroll; the MergeView container does.** The package
//   forces `height: auto` and `overflow-y: visible` on each editor and scrolls its
//   own wrapper, which is how it keeps the two sides aligned. So there is one
//   scroller for both panes, and `mergeViewRef.current.dom` is it.
// - **The panes are aligned with spacer blocks**, which are widgets in the
//   editors' own content. That is why the change map can measure one side and
//   describe both: `contentHeight` already includes the other side's insertions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { languageForPath } from "../lib/cmLanguage";
import { currentAppearance, onAppearance } from "../lib/appearance";
import { useWindowKeybindings } from "../hooks/useWindowKeybindings";
import { DEFAULT_THEME } from "../theme/themes";
import {
  computeStripes,
  markerColors,
  stripeAt,
  type Stripe,
  type StripeGeometry,
} from "../lib/diffStripes";
import {
  editableExtension,
  editableTransaction,
  PANE_KEYMAP,
  paneExtensions,
  readOnlyFocusableExtensions,
  searchExtensions,
  themeTransaction,
} from "../editor/codemirror";
import { EditorToolbar, type ToolbarItem } from "../editor/EditorToolbar";
import { OverviewRuler } from "../editor/OverviewRuler";
import { useViewOptions } from "../editor/useViewOptions";
import { viewOptionItems } from "../editor/viewOptions";

/**
 * How long the diff may spend before it settles for a coarse answer.
 *
 * `@codemirror/merge` computes the diff inline, on the thread that is trying to
 * paint the window, and unbounded it is genuinely dangerous: two unrelated
 * 6,000-line files took over five minutes to compare. Its own default —
 * `scanLimit: 500` — is worse than no bound at all, because the limit is counted
 * in *characters*, so any residual range over 16,000 of them returns a single
 * chunk covering the whole file, by a path that still reports `precise: true`.
 *
 * `timeout` is the bound that behaves: it falls back to the package's coarse
 * matcher, and that one does set `precise: false`, so `onImprecise` can say so.
 * At 250 ms a realistic file is well under the budget and still exact (19 ms for
 * fifty scattered edits in 2,300 lines), and the pathological cases land around
 * half a second instead of minutes.
 */
const DIFF_TIMEOUT_MS = 250;

/** Neither pane may be squeezed below this fraction of the width. */
const MIN_PANE = 0.15;

/**
 * Whether two change maps would paint the same.
 *
 * Not a nicety: the map is re-measured from an update listener, so without this a
 * new array arrives on every geometry change and re-renders the toolbar with it.
 */
function sameStripes(a: readonly Stripe[], b: readonly Stripe[]): boolean {
  return (
    a.length === b.length &&
    a.every((stripe, index) => {
      const other = b[index];
      return (
        stripe.chunk === other.chunk &&
        stripe.kind === other.kind &&
        stripe.top === other.top &&
        stripe.height === other.height
      );
    })
  );
}

export interface DiffPaneProps {
  /** HEAD side. Empty string for a file that is not in HEAD yet. */
  left: string;
  /** Working-tree side. Empty string for a deleted file. */
  right: string;
  /**
   * Increments whenever `right` is a fresh read from disk that should replace
   * the buffer. `right` cannot be that signal on its own: the parent freezes it
   * at an older value while it protects unsaved typing, so a later read that
   * lands back on that same string would look unchanged and leave this editor
   * holding content nobody asked it to keep.
   */
  rightRevision: number;
  /** Repo-relative path; drives syntax highlighting for both panes. */
  path: string;
  /** False for a deleted file: nothing to edit, and a save must not recreate it. */
  rightEditable: boolean;
  onRightChange: (value: string) => void;
  /**
   * Where the divider between the panes now sits, in pixels from the left edge,
   * reported on mount and whenever it moves, so the two headers stay lined up
   * with the panes they describe.
   */
  onSplitAt: (x: number) => void;
  /**
   * Whether the diff had to settle for a coarse answer. The window says so rather
   * than letting an approximate diff pass for an exact one.
   */
  onImprecise?: (imprecise: boolean) => void;
}

export function DiffPane({
  left,
  right,
  rightRevision,
  path,
  rightEditable,
  onRightChange,
  onSplitAt,
  onImprecise,
}: DiffPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const [stripes, setStripes] = useState<readonly Stripe[]>([]);
  /** Where to draw the drag handle, in pixels from the host's left edge. */
  const [sashX, setSashX] = useState<number | null>(null);
  const [theme, setTheme] = useState(() => currentAppearance()?.theme ?? DEFAULT_THEME);
  const { state: options, toggle } = useViewOptions();
  const collapse = options["collapse-unchanged"] ?? false;

  // Values that only seed the editors, and callbacks their own listeners reach
  // for, read through refs so they are not effect dependencies that would tear the
  // MergeView down and rebuild it — which would re-run the diff and lose the
  // scroll position mid-review. Same shape as MergePanes.
  const seedRef = useRef({ left, right, rightEditable, collapse });
  const changeRef = useRef(onRightChange);
  const splitRef = useRef(onSplitAt);
  const impreciseRef = useRef(onImprecise);

  // Declared before the construction effect so it always runs first.
  useEffect(() => {
    changeRef.current = onRightChange;
    splitRef.current = onSplitAt;
    impreciseRef.current = onImprecise;
  }, [onImprecise, onRightChange, onSplitAt]);

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
    setStripes((previous) => {
      const next = computeStripes(merge.chunks, geometry);
      return sameStripes(previous, next) ? previous : next;
    });

    // Reported from here rather than once at construction: `precise` is a property
    // of the *current* diff, and the diff is recomputed on every edit and on every
    // side replaced. Said once at mount it would go stale in both directions — a
    // warning left up after the file was edited back down to a small diff, or, worse,
    // absent on a coarse diff that arrived through a reload.
    impreciseRef.current?.(merge.chunks.some((chunk) => !chunk.precise));

    const origin = host.getBoundingClientRect().left;
    // The right editor's left edge is where the header should split: it puts the
    // revert column on the HEAD side, which is the side its `»` restores from.
    splitRef.current(merge.b.dom.getBoundingClientRect().left - origin);
    // The handle sits on the seam between the left pane and the revert column, so
    // dragging it never lands on a `»`. With no revert column it is the seam
    // between the panes.
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

  // --- construction ---------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const seed = seedRef.current;
    const startTheme = currentAppearance()?.theme ?? DEFAULT_THEME;

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
          ...paneExtensions(startTheme),
          ...readOnlyFocusableExtensions(),
          ...searchExtensions(),
        ],
      },
      b: {
        doc: seed.right,
        extensions: [
          ...paneExtensions(startTheme),
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
            // Fires for typing, for a `»` click, and for our own adoption of a
            // reload; the parent decides which of those is worth saving.
            if (update.docChanged) changeRef.current(update.state.doc.toString());
            if (update.docChanged || update.geometryChanged) remeasure();
          }),
        ],
      },
      // Part 4's `»`, restoring a block from HEAD into the working file. The
      // package positions the button and owns the click; only the glyph is ours.
      revertControls: "a-to-b",
      renderRevertControl: () => {
        const button = document.createElement("button");
        button.textContent = "»";
        button.setAttribute("aria-label", "Restore this block from HEAD");
        button.setAttribute("title", "Restore this block from HEAD");
        return button;
      },
      highlightChanges: true,
      // The line numbers already mark the changed lines' position, and a second
      // gutter stripe beside them is what Part 4 did without.
      gutter: false,
      collapseUnchanged: seed.collapse ? {} : undefined,
      diffConfig: { timeout: DIFF_TIMEOUT_MS },
    });
    mergeRef.current = merge;

    // Synchronously for the first pass, so the headers are not a frame late.
    measureNow();

    // The MergeView measures itself on an animation frame, and its spacers do not
    // exist until it has: measuring the map before that would place every mark
    // against an unspaced height. A second pass once the frame has run is the
    // cheapest way to be right without reaching into its internals.
    const frame = requestAnimationFrame(measureNow);

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
      // Ends a drag that is still in progress: the listeners are on `window`, so
      // without this they would outlive the panes they are resizing.
      endDragRef.current?.();
      merge.destroy();
      mergeRef.current = null;
    };
  }, [measureNow, remeasure]);

  // --- following the props --------------------------------------------------

  // A new commit, or an external edit the parent decided to adopt. Guarded by an
  // equality check so a re-render with unchanged content never resets the cursor,
  // the scroll position or the undo stack — and never re-runs the diff.
  useEffect(() => {
    const view = mergeRef.current?.a;
    if (!view || view.state.doc.toString() === left) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: left } });
  }, [left]);

  // Keyed on the revision as well as the content — see the prop's doc comment: an
  // adopt can hand back a string this editor was already shown, and the revision
  // is what makes that visible here. The value guard still stands, so a revision
  // bump whose content the editor already holds resets nothing.
  useEffect(() => {
    const view = mergeRef.current?.b;
    if (!view || view.state.doc.toString() === right) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: right } });
  }, [right, rightRevision]);

  useEffect(() => {
    mergeRef.current?.b.dispatch(editableTransaction(rightEditable));
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
  // compiled into CodeMirror's own stylesheet. The change map holds the colour it
  // was handed, so it re-renders from the new theme too.
  useEffect(
    () =>
      onAppearance((appearance) => {
        setTheme(appearance.theme);
        const merge = mergeRef.current;
        if (!merge) return;
        const spec = themeTransaction(appearance.theme);
        for (const view of [merge.a, merge.b]) {
          view.dispatch(spec);
          view.requestMeasure();
        }
        remeasure();
      }),
    [remeasure],
  );

  // --- navigation and the divider ------------------------------------------

  const goToChange = useCallback((direction: "next" | "previous") => {
    const view = mergeRef.current?.b;
    if (!view) return;
    const command = direction === "next" ? goToNextChunk : goToPreviousChunk;
    command(view);
    view.focus();
  }, []);

  useWindowKeybindings("diff", {
    "next-change": () => goToChange("next"),
    "previous-change": () => goToChange("previous"),
  });

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

  const chunkAt = useCallback((fraction: number) => stripeAt(stripes, fraction), [stripes]);

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
      const wrapA = merge.a.dom.parentElement;
      const wrapB = merge.b.dom.parentElement;
      if (!wrapA || !wrapB) return;

      event.preventDefault();
      const box = host.getBoundingClientRect();

      const move = (pointer: PointerEvent) => {
        const fraction = Math.min(
          1 - MIN_PANE,
          Math.max(MIN_PANE, (pointer.clientX - box.left) / box.width),
        );
        wrapA.style.flexGrow = String(fraction);
        wrapB.style.flexGrow = String(1 - fraction);
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

  // --- toolbar --------------------------------------------------------------

  const items = useMemo<ToolbarItem[]>(
    () => [
      {
        kind: "group",
        id: "navigate",
        items: [
          {
            kind: "button",
            id: "previous-change",
            label: "◂ Previous",
            tooltip: "Go to the previous change",
            disabled: stripes.length === 0,
            onSelect: () => goToChange("previous"),
          },
          {
            kind: "button",
            id: "next-change",
            label: "Next ▸",
            tooltip: "Go to the next change",
            disabled: stripes.length === 0,
            onSelect: () => goToChange("next"),
          },
        ],
      },
      {
        kind: "status",
        id: "count",
        text:
          stripes.length === 0
            ? "No changes in this file"
            : `${stripes.length} ${stripes.length === 1 ? "change" : "changes"}`,
      },
      ...viewOptionItems("diff", options, toggle),
    ],
    [goToChange, options, stripes.length, toggle],
  );

  return (
    <div className="diff-panes">
      <EditorToolbar items={items} label="Diff view" />
      <div className="diff-editor-row">
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
        <OverviewRuler
          stripes={stripes}
          colors={markerColors(theme)}
          onSeek={seek}
          chunkAt={chunkAt}
        />
      </div>
    </div>
  );
}
