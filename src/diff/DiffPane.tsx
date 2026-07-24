// The two-pane diff editor: the only module that touches Monaco.
//
// Monaco's diff editor already gives us what Part 4 asks for — side-by-side
// panes, per-pane line numbers, character-level highlighting, scroll locked
// between the panes, an editable right side, and the `»` revert arrow in the
// margin between the panes (`renderMarginRevertIcon`), which copies a block
// from HEAD into the working file. What it does not give us is a three-colour
// scrollbar map, so those marks are our own overview-ruler decorations.
//
// Content flows one way: `left`/`right` are what to *display*, and edits are
// reported through `onRightChange`. The parent deliberately does not feed the
// buffer back down as `right` — that would fight the user's typing.

import { useEffect, useMemo, useRef } from "react";
// The API-only entry, matching monacoSetup: importing the bare `monaco-editor`
// here would drag the worker-backed language services back in.
import * as monaco from "monaco-editor/editor/editor.api";
import {
  computeMarkers,
  MARKER_COLORS,
  type DiffMarker,
  type DiffSide,
} from "../lib/diffMarkers";
import { languageForPath } from "../lib/diffLanguage";
import { configureMonaco, DIFF_THEME } from "./monacoSetup";

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
  /** Repo-relative path; drives syntax highlighting for both models. */
  path: string;
  /** False for a deleted file: nothing to edit, and a save must not recreate it. */
  rightEditable: boolean;
  onRightChange: (value: string) => void;
  /**
   * Current width of the left pane, reported on mount and whenever the user
   * drags the sash, so the two headers stay lined up with the panes.
   */
  onOriginalWidth: (width: number) => void;
}

function toDecorations(
  markers: readonly DiffMarker[],
  side: DiffSide,
): monaco.editor.IModelDeltaDecoration[] {
  return markers
    .filter((marker) => marker.side === side)
    .map((marker) => ({
      range: new monaco.Range(marker.startLine, 1, marker.endLine, 1),
      options: {
        description: `isabuild-diff-${marker.kind}`,
        overviewRuler: {
          color: MARKER_COLORS[marker.kind],
          position: monaco.editor.OverviewRulerLane.Full,
        },
      },
    }));
}

export function DiffPane({
  left,
  right,
  rightRevision,
  path,
  rightEditable,
  onRightChange,
  onOriginalWidth,
}: DiffPaneProps) {
  // Monaco's own registry holds the extension mapping, so it is the source of
  // truth; languageForPath just picks from it (see lib/diffLanguage).
  const language = useMemo(() => languageForPath(path, monaco.languages.getLanguages()), [path]);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);

  // The editor is built once. Values that only seed it are read through refs so
  // they are not effect dependencies; later changes are applied by the effects
  // below, which update the live editor instead of rebuilding it.
  const seedRef = useRef({ left, right, language, rightEditable });
  const changeRef = useRef(onRightChange);
  const widthRef = useRef(onOriginalWidth);

  // Keep the callbacks the editor's own listeners reach for current, without
  // making them dependencies that would tear the editor down and rebuild it.
  // Declared before the mount effect so it always runs first.
  useEffect(() => {
    changeRef.current = onRightChange;
    widthRef.current = onOriginalWidth;
  }, [onRightChange, onOriginalWidth]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    configureMonaco();

    const seed = seedRef.current;
    const original = monaco.editor.createModel(seed.left, seed.language);
    const modified = monaco.editor.createModel(seed.right, seed.language);
    modelsRef.current = { original, modified };

    const editor = monaco.editor.createDiffEditor(container, {
      theme: DIFF_THEME,
      // The left side is a git blob: it can be read, never written.
      originalEditable: false,
      readOnly: !seed.rightEditable,
      renderSideBySide: true,
      // Never silently collapse to the inline view on a narrow window.
      useInlineViewWhenSpaceIsLimited: false,
      // Show the whole file, unchanged lines included.
      hideUnchangedRegions: { enabled: false },
      // The `»` block-restore arrows, without the extra gutter menu — Part 4
      // ships no options surface.
      renderMarginRevertIcon: true,
      renderGutterMenu: false,
      // Whitespace-only edits are real edits; don't hide them.
      ignoreTrimWhitespace: false,
      minimap: { enabled: false },
      wordWrap: "off",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      enableSplitViewResizing: true,
      renderLineHighlight: "none",
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;

    const originalMarks = editor.getOriginalEditor().createDecorationsCollection();
    const modifiedMarks = editor.getModifiedEditor().createDecorationsCollection();
    const disposables: monaco.IDisposable[] = [
      editor.onDidUpdateDiff(() => {
        const markers = computeMarkers(editor.getLineChanges());
        originalMarks.set(toDecorations(markers, "original"));
        modifiedMarks.set(toDecorations(markers, "modified"));
      }),
      // Fires for typing, for a revert-arrow click, and for our own setValue;
      // the parent decides which of those is worth saving.
      modified.onDidChangeContent(() => {
        changeRef.current(modified.getValue());
      }),
    ];

    const originalNode = editor.getOriginalEditor().getDomNode();
    let observer: ResizeObserver | null = null;
    if (originalNode) {
      widthRef.current(originalNode.offsetWidth);
      observer = new ResizeObserver(() => {
        widthRef.current(originalNode.offsetWidth);
      });
      observer.observe(originalNode);
    }

    return () => {
      observer?.disconnect();
      for (const disposable of disposables) {
        disposable.dispose();
      }
      editor.dispose();
      original.dispose();
      modified.dispose();
      editorRef.current = null;
      modelsRef.current = null;
    };
  }, []);

  // Reloads (a new commit, or an external edit the parent decided to adopt)
  // replace the model text. Guarded by an equality check so a re-render with
  // unchanged content never resets the cursor or the undo stack.
  useEffect(() => {
    const models = modelsRef.current;
    if (models && models.original.getValue() !== left) {
      models.original.setValue(left);
    }
  }, [left]);

  // Keyed on the revision as well as the content — see the prop's doc comment:
  // an adopt can hand back a string this editor was already shown, and the
  // revision is what makes that visible here. The value guard still stands, so a
  // revision bump whose content the editor already holds resets nothing.
  useEffect(() => {
    const models = modelsRef.current;
    if (models && models.modified.getValue() !== right) {
      models.modified.setValue(right);
    }
  }, [right, rightRevision]);

  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    monaco.editor.setModelLanguage(models.original, language);
    monaco.editor.setModelLanguage(models.modified, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !rightEditable });
  }, [rightEditable]);

  return <div className="diff-editor" ref={containerRef} data-testid="diff-editor" />;
}
