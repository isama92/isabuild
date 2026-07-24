import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import * as monaco from "monaco-editor/editor/editor.api";
import { DiffPane } from "./DiffPane";
import { MARKER_COLORS } from "../lib/diffMarkers";

// Monaco does not run under jsdom, so this test stands in for it and asserts
// the contract instead: which options the diff editor is built with, what the
// models are seeded with, and that everything is disposed on unmount.

interface FakeModel {
  value: string;
  language: string;
  getValue: () => string;
  setValue: (value: string) => void;
  onDidChangeContent: (handler: () => void) => monaco.IDisposable;
  dispose: () => void;
  fireChange: () => void;
}

const models: FakeModel[] = [];
const decorationSets: { original: unknown[][]; modified: unknown[][] } = {
  original: [],
  modified: [],
};
let lineChanges: monaco.editor.ILineChange[] | null = [];
let fireDiffUpdate: () => void = () => {};
let originalNode: HTMLElement | null = null;
let resizeCallback: (() => void) | undefined;
const disposed: string[] = [];
let createOptions: Record<string, unknown> = {};
const updateOptions = vi.fn();

function createModel(value: string, language: string): FakeModel {
  const handlers: (() => void)[] = [];
  const model: FakeModel = {
    value,
    language,
    getValue: () => model.value,
    setValue: (next: string) => {
      model.value = next;
      for (const handler of handlers) handler();
    },
    onDidChangeContent: (handler: () => void) => {
      handlers.push(handler);
      return { dispose: () => disposed.push("contentListener") };
    },
    dispose: () => disposed.push("model"),
    fireChange: () => {
      for (const handler of handlers) handler();
    },
  };
  models.push(model);
  return model;
}

// monacoSetup's side-effect imports (the editor features and the monarch
// languages) pull the real Monaco in, which needs browser APIs jsdom lacks.
vi.mock("./monacoSetup", () => ({
  configureMonaco: vi.fn(),
  DIFF_THEME: "test-theme",
}));

vi.mock("monaco-editor/editor/editor.api", () => {
  const collection = (side: "original" | "modified") => ({
    set: (decorations: unknown[]) => decorationSets[side].push(decorations),
  });
  return {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    editor: {
      OverviewRulerLane: { Full: 7 },
      createModel: (value: string, language: string) => createModel(value, language),
      setModelLanguage: (model: FakeModel, language: string) => {
        model.language = language;
      },
      defineTheme: vi.fn(),
      createDiffEditor: (_container: HTMLElement, options: Record<string, unknown>) => {
        createOptions = options;
        return {
          setModel: vi.fn(),
          updateOptions,
          getLineChanges: () => lineChanges,
          onDidUpdateDiff: (handler: () => void) => {
            fireDiffUpdate = handler;
            return { dispose: () => disposed.push("diffListener") };
          },
          getOriginalEditor: () => ({
            createDecorationsCollection: () => collection("original"),
            getDomNode: () => originalNode,
          }),
          getModifiedEditor: () => ({
            createDecorationsCollection: () => collection("modified"),
          }),
          dispose: () => disposed.push("editor"),
        };
      },
    },
    languages: {
      getLanguages: () => [{ id: "typescript", extensions: [".ts"] }],
    },
  };
});

const props = {
  left: "one\ntwo\n",
  right: "one\ntwo changed\n",
  rightRevision: 0,
  path: "src/a.ts",
  rightEditable: true,
  onRightChange: vi.fn(),
  onOriginalWidth: vi.fn(),
};

beforeEach(() => {
  models.length = 0;
  disposed.length = 0;
  decorationSets.original.length = 0;
  decorationSets.modified.length = 0;
  lineChanges = [];
  createOptions = {};
  originalNode = null;
  resizeCallback = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("DiffPane", () => {
  it("seeds both models with their side's content and the path's language", () => {
    render(<DiffPane {...props} />);
    expect(models.map((model) => model.value)).toEqual(["one\ntwo\n", "one\ntwo changed\n"]);
    expect(models.map((model) => model.language)).toEqual(["typescript", "typescript"]);
  });

  it("builds the editor with the options Part 4 depends on", () => {
    render(<DiffPane {...props} />);
    expect(createOptions).toMatchObject({
      // The left side is a git blob.
      originalEditable: false,
      readOnly: false,
      renderSideBySide: true,
      // Never collapse to the inline view, and never hide unchanged lines.
      useInlineViewWhenSpaceIsLimited: false,
      hideUnchangedRegions: { enabled: false },
      // The block-restore arrows, without an options surface.
      renderMarginRevertIcon: true,
      renderGutterMenu: false,
      // Whitespace-only edits must show.
      ignoreTrimWhitespace: false,
    });
  });

  it("makes the right pane read-only for a deleted file", () => {
    render(<DiffPane {...props} rightEditable={false} />);
    expect(createOptions).toMatchObject({ readOnly: true });
  });

  it("colours the scrollbar per change kind on the matching side", () => {
    lineChanges = [
      // An insertion, then a deletion.
      {
        originalStartLineNumber: 10,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 11,
        modifiedEndLineNumber: 12,
        charChanges: undefined,
      },
      {
        originalStartLineNumber: 20,
        originalEndLineNumber: 21,
        modifiedStartLineNumber: 22,
        modifiedEndLineNumber: 0,
        charChanges: undefined,
      },
    ];
    render(<DiffPane {...props} />);
    fireDiffUpdate();

    const colours = (side: "original" | "modified") =>
      (decorationSets[side].at(-1) as monaco.editor.IModelDeltaDecoration[]).map(
        (decoration) => decoration.options.overviewRuler?.color,
      );
    expect(colours("original")).toEqual([MARKER_COLORS.added, MARKER_COLORS.removed]);
    expect(colours("modified")).toEqual([MARKER_COLORS.added, MARKER_COLORS.removed]);
  });

  it("reports the left pane's width so the header can track the sash", () => {
    originalNode = Object.defineProperty(document.createElement("div"), "offsetWidth", {
      value: 640,
    });
    render(<DiffPane {...props} />);
    expect(props.onOriginalWidth).toHaveBeenCalledWith(640);

    resizeCallback?.();
    expect(props.onOriginalWidth).toHaveBeenCalledTimes(2);
  });

  it("reports edits made in the right pane", () => {
    render(<DiffPane {...props} />);
    models[1].setValue("typed\n");
    expect(props.onRightChange).toHaveBeenCalledWith("typed\n");
  });

  it("replaces a model only when its content actually changed", () => {
    const { rerender } = render(<DiffPane {...props} />);
    // Same content, new render: must not reset the model (cursor, undo stack).
    rerender(<DiffPane {...props} />);
    expect(props.onRightChange).not.toHaveBeenCalled();

    // Braces, not a plain attribute: "adopted\n" in JSX text would be literal.
    rerender(<DiffPane {...props} right={"adopted\n"} />);
    expect(models[1].value).toBe("adopted\n");
  });

  it("re-applies content the editor has drifted from when the revision bumps", () => {
    // The parent freezes `right` while it protects unsaved typing, so a fresh
    // read can arrive with the same string the pane was first given. Only the
    // revision distinguishes it, and the buffer has to be replaced.
    const { rerender } = render(<DiffPane {...props} />);
    models[1].setValue("typed on\n");

    rerender(<DiffPane {...props} rightRevision={1} />);

    expect(models[1].value).toBe(props.right);
  });

  it("does not touch the model when only unrelated props change", () => {
    const { rerender } = render(<DiffPane {...props} />);
    models[1].setValue("typed on\n");

    // A sash drag re-renders with new callback identities and nothing else.
    rerender(<DiffPane {...props} onOriginalWidth={() => {}} />);

    expect(models[1].value).toBe("typed on\n");
  });

  it("disposes the editor, models and listeners on unmount", () => {
    const { unmount } = render(<DiffPane {...props} />);
    unmount();
    expect(disposed).toContain("editor");
    expect(disposed).toContain("diffListener");
    expect(disposed).toContain("contentListener");
    expect(disposed.filter((entry) => entry === "model")).toHaveLength(2);
  });
});
