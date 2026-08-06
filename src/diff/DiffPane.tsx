// The diff editor's shell: the pane showing the diff, plus everything that is not
// about how it is laid out.
//
// The pane renders its editors and nothing else. The toolbar, the change map, the
// view options, the theme subscription and the keybindings are all here, built
// once, from what the pane reports through `onMeasure` — so a second pane with a
// different layout is a component that satisfies `DiffViewProps`, not a second
// copy of the chrome. `diffView.ts` is the contract between the two halves.
//
// Which pane is mounted is a view option, so the choice persists and reaches every
// open diff window through `settings://changed`. Switching is a full teardown:
// React unmounts one component and mounts the other, so the editor is destroyed
// and rebuilt and the diff runs again. What survives is the working-tree text, the
// cursor and roughly the scroll position, all through `DiffHandoff`; what does not
// is the undo history and any open find panel, because a CodeMirror state cannot
// be moved between two editors with different extensions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentAppearance, onAppearance } from "../lib/appearance";
import { useWindowKeybindings } from "../hooks/useWindowKeybindings";
import { DEFAULT_THEME } from "../theme/themes";
import { markerColors, DIFF_MARK_LABELS } from "../lib/diffStripes";
import { stripeAt } from "../lib/overviewStripes";
import { EditorToolbar, type ToolbarItem } from "../editor/EditorToolbar";
import { Icons } from "../editor/icons";
import { OverviewRuler } from "../editor/OverviewRuler";
import { useViewOptions } from "../editor/useViewOptions";
import { viewOptionItems } from "../editor/viewOptions";
import { SplitPanes } from "./SplitPanes";
import { UnifiedPane } from "./UnifiedPane";
import type {
  DiffHandoff,
  DiffHeaderLayout,
  DiffMeasurement,
  DiffPaneHandle,
  DiffViewProps,
} from "./diffView";

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
  /** Repo-relative path; drives syntax highlighting. */
  path: string;
  /** False for a deleted file: nothing to edit, and a save must not recreate it. */
  rightEditable: boolean;
  onRightChange: (value: string) => void;
  /**
   * How the window should divide its header, reported on mount and whenever it
   * changes, so the header stays lined up with the panes it describes.
   */
  onLayout: (layout: DiffHeaderLayout) => void;
  /**
   * Whether the diff had to settle for a coarse answer. The window says so rather
   * than letting an approximate diff pass for an exact one.
   */
  onImprecise?: (imprecise: boolean) => void;
}

const NOTHING: DiffMeasurement = { changeCount: 0, imprecise: false, stripes: [] };

export function DiffPane({
  left,
  right,
  rightRevision,
  path,
  rightEditable,
  onRightChange,
  onLayout,
  onImprecise,
}: DiffPaneProps) {
  const [measurement, setMeasurement] = useState<DiffMeasurement>(NOTHING);
  const [theme, setTheme] = useState(() => currentAppearance()?.theme ?? DEFAULT_THEME);
  const [splitFraction, setSplitFraction] = useState<number | null>(null);
  const handleRef = useRef<DiffPaneHandle | null>(null);
  const { state: options, set: setOption } = useViewOptions();
  const collapse = options["collapse-unchanged"] ?? false;
  const unified = options["unified-view"] ?? false;

  /**
   * What the pane being replaced left behind.
   *
   * Written in the outgoing pane's teardown and read in the incoming one's
   * construction, both of which are effects — so this is never touched during
   * render, and the two panes never have to know about each other.
   */
  const handoffRef = useRef<DiffHandoff | null>(null);
  const takeHandoff = useCallback(() => handoffRef.current, []);
  const putHandoff = useCallback((handoff: DiffHandoff) => {
    handoffRef.current = handoff;
  }, []);

  const handleMeasure = useCallback(
    (next: DiffMeasurement) => {
      setMeasurement((previous) =>
        previous.changeCount === next.changeCount &&
        previous.imprecise === next.imprecise &&
        previous.stripes === next.stripes
          ? previous
          : next,
      );
      onImprecise?.(next.imprecise);
    },
    [onImprecise],
  );

  const handleReady = useCallback((handle: DiffPaneHandle | null) => {
    handleRef.current = handle;
  }, []);

  // Subscribed once, here rather than in each pane: the strip needs the theme to
  // colour its marks, and the panes need it to reconfigure their highlight
  // compartment. One subscription, passed down, so the two cannot disagree.
  useEffect(() => onAppearance((appearance) => setTheme(appearance.theme)), []);

  const goToChange = useCallback((direction: "next" | "previous") => {
    handleRef.current?.goToChange(direction);
  }, []);

  useWindowKeybindings("diff", {
    "next-change": () => goToChange("next"),
    "previous-change": () => goToChange("previous"),
  });

  const seek = useCallback((index: number) => handleRef.current?.seek(index), []);
  const chunkAt = useCallback(
    (fraction: number) => stripeAt(measurement.stripes, fraction),
    [measurement.stripes],
  );

  const { changeCount, stripes } = measurement;

  const paneProps: DiffViewProps = {
    left,
    right,
    rightRevision,
    path,
    rightEditable,
    collapse,
    theme,
    onRightChange,
    onMeasure: handleMeasure,
    onLayout,
    onReady: handleReady,
    takeHandoff,
    onHandoff: putHandoff,
  };

  const items = useMemo<ToolbarItem[]>(
    () => [
      {
        kind: "group",
        id: "navigate",
        items: [
          {
            kind: "button",
            id: "previous-change",
            label: "Previous change",
            tooltip: "Go to the previous change",
            icon: Icons.previousChange,
            disabled: changeCount === 0,
            onSelect: () => goToChange("previous"),
          },
          {
            kind: "button",
            id: "next-change",
            label: "Next change",
            tooltip: "Go to the next change",
            icon: Icons.nextChange,
            disabled: changeCount === 0,
            onSelect: () => goToChange("next"),
          },
        ],
      },
      { kind: "separator", id: "after-navigate" },
      ...viewOptionItems("diff", options, setOption),
      { kind: "spacer", id: "gap" },
      {
        kind: "status",
        id: "count",
        text:
          changeCount === 0
            ? "No changes in this file"
            : `${changeCount} ${changeCount === 1 ? "change" : "changes"}`,
      },
      ...viewOptionItems("diff", options, setOption, { group: "view-mode" }),
    ],
    [changeCount, goToChange, options, setOption],
  );

  return (
    <div className="diff-panes">
      <EditorToolbar items={items} label="Diff view" />
      <div className="diff-editor-row">
        {unified ? (
          <UnifiedPane {...paneProps} />
        ) : (
          <SplitPanes
            {...paneProps}
            splitFraction={splitFraction}
            onSplitFraction={setSplitFraction}
          />
        )}
        <OverviewRuler
          stripes={stripes}
          colors={markerColors(theme)}
          labels={DIFF_MARK_LABELS}
          onSeek={seek}
          chunkAt={chunkAt}
        />
      </div>
    </div>
  );
}
