// Real CodeMirror and a real MergeView, not a mock — the same choice
// MergePanes.test made, and it costs the same thing. CodeMirror constructs
// perfectly well under jsdom; what it cannot do there is *measure*, and that
// shapes what this file can assert:
//
// - Documents, editability, the diff itself, the toolbar and the panes' wiring are
//   all real and testable. `EditorView.findFromDOM` gets a handle on each pane, so
//   a change can be dispatched the way the revert control's would be.
// - **The change map needs a layout faked for it.** Its geometry comes from
//   `lineBlockAt` and `contentHeight`. jsdom measures nothing, so every line block
//   comes back at top 0 — CodeMirror still *estimates* a content height, so marks do
//   render, but they all pile up at the top on the minimum height, which proves
//   nothing about where a mark goes. `withLayout` stubs twenty pixels a line, which
//   is enough to assert that the marks are wired to the chunks and to the theme. The
//   arithmetic itself is `lib/diffStripes`' own test, against an injected geometry,
//   and the strip's rendering is `editor/OverviewRuler.test`.
// - **A `»` cannot be clicked.** @codemirror/merge places the revert buttons from
//   measured chunk positions, so under jsdom the column is there and empty. That
//   the control is configured is asserted; clicking one is a manual check, exactly
//   as MergePanes.test says of its gutter arrows.
// - **The panes' alignment cannot be asserted**, for the same reason: spacer
//   heights are measured.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { getChunks } from "@codemirror/merge";
import { DiffPane, type DiffPaneProps } from "./DiffPane";
import { initialSettingsState, useSettingsStore } from "../store/settingsStore";
import { publishAppearance, resetAppearance } from "../lib/appearance";
import { DEFAULT_THEME, themeById } from "../theme/themes";
import type { Settings, SettingsPatch } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
// It dynamically imports ~140 language modules, none of which this file needs.
vi.mock("@codemirror/language-data", () => ({ languages: [] }));

const save = vi.fn<(patch: SettingsPatch) => Promise<void>>();

function settings(viewOptions: Record<string, boolean> = {}): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings: {},
    viewOptions,
    lastProject: null,
    recentProjects: [],
  };
}

function props(overrides: Partial<DiffPaneProps> = {}): DiffPaneProps {
  return {
    left: "one\ntwo\nthree\n",
    right: "one\nTWO\nthree\n",
    rightRevision: 0,
    path: "src/a.ts",
    rightEditable: true,
    onRightChange: vi.fn(),
    onSplitAt: vi.fn(),
    ...overrides,
  };
}

/** The live view for one side. `a` is HEAD, `b` the working tree. */
function pane(container: HTMLElement, side: "a" | "b"): EditorView {
  const roots = Array.from(container.querySelectorAll<HTMLElement>(".cm-editor"));
  const root = side === "a" ? roots[0] : roots[1];
  const view = EditorView.findFromDOM(root);
  if (!view) throw new Error(`no ${side} pane`);
  return view;
}

function docOf(container: HTMLElement, side: "a" | "b"): string {
  return pane(container, side).state.doc.toString();
}

function editableOf(container: HTMLElement, side: "a" | "b"): boolean {
  return pane(container, side).contentDOM.getAttribute("contenteditable") === "true";
}

/** jsdom normalises an inline `background` to `rgb(...)`; the tokens are hex. */
function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${Math.floor(value / 65536)}, ${Math.floor(value / 256) % 256}, ${value % 256})`;
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no ResizeObserver, and the pane watches its host to know when the
  // divider has moved. A no-op is enough: nothing here resizes, and what the
  // callback would recompute is geometry jsdom reports as zeros anyway.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  save.mockResolvedValue(undefined);
  useSettingsStore.setState({ ...initialSettingsState, settings: settings(), save });
  publishAppearance(document.documentElement, {
    fontFamily: "",
    fontSize: 14,
    theme: DEFAULT_THEME,
  });
});

afterEach(() => {
  resetAppearance();
});

describe("the two panes", () => {
  it("seeds HEAD on the left and the working tree on the right", () => {
    const { container } = render(<DiffPane {...props()} />);
    expect(docOf(container, "a")).toBe("one\ntwo\nthree\n");
    expect(docOf(container, "b")).toBe("one\nTWO\nthree\n");
  });

  it("diffs them", () => {
    // One changed line out of three. If this is ever a single chunk covering the
    // whole file, the diff has fallen back to its coarse path — which is what
    // @codemirror/merge's own default `scanLimit` does, and why DiffPane sets a
    // timeout instead.
    const { container } = render(<DiffPane {...props()} />);
    const found = getChunks(pane(container, "b").state);
    expect(found?.chunks).toHaveLength(1);
    expect(found?.side).toBe("b");
    const [chunk] = found?.chunks ?? [];
    expect(pane(container, "b").state.doc.lineAt(chunk.fromB).number).toBe(2);
  });

  it("computes the diff precisely for a file of this size", () => {
    const { container } = render(<DiffPane {...props()} />);
    const found = getChunks(pane(container, "b").state);
    expect(found?.chunks.every((chunk) => chunk.precise)).toBe(true);
  });

  it("never lets the HEAD side be typed into", () => {
    // It is a git blob: it can be read, never written.
    const { container } = render(<DiffPane {...props()} />);
    expect(pane(container, "a").state.readOnly).toBe(true);
  });

  it("still lets the HEAD side be focused, so it can be searched and copied out of", () => {
    // The distinction that matters: `readOnly` refuses input, `editable` decides
    // whether the pane can be focused at all. Turning the second one off as well
    // would make Ctrl+F in the HEAD pane do nothing — a keystroke never reaches a
    // pane that cannot take focus.
    const { container } = render(<DiffPane {...props()} />);
    expect(editableOf(container, "a")).toBe(true);
  });

  it("lets the working tree be typed into", () => {
    const { container } = render(<DiffPane {...props()} />);
    expect(editableOf(container, "b")).toBe(true);
  });

  it("marks a deleted file read-only so a save cannot recreate it", () => {
    const { container } = render(<DiffPane {...props({ right: "", rightEditable: false })} />);
    expect(editableOf(container, "b")).toBe(false);
  });

  it("stops accepting edits when the file is deleted under it, keeping the content", () => {
    // A watcher refresh can turn an editable pane read-only mid-edit; the pane
    // reconfigures rather than being rebuilt, so nothing shown is lost.
    const { container, rerender } = render(<DiffPane {...props()} />);
    rerender(<DiffPane {...props({ rightEditable: false })} />);

    expect(editableOf(container, "b")).toBe(false);
    expect(docOf(container, "b")).toBe("one\nTWO\nthree\n");
  });

  it("shows an empty HEAD side for a file that is not in HEAD yet", () => {
    const { container } = render(<DiffPane {...props({ left: "" })} />);
    expect(docOf(container, "a")).toBe("");
  });

  it("offers find in both panes", () => {
    // Monaco's find bar is one of the things Part 4 shipped; losing it silently
    // would be a regression nobody wrote down.
    const { container } = render(<DiffPane {...props()} />);
    for (const side of ["a", "b"] as const) {
      const view = pane(container, side);
      act(() => {
        openSearchPanel(view);
      });
      expect(view.dom.querySelector(".cm-panel.cm-search")).toBeInTheDocument();
    }
  });

  it("opens find above the panes, not below", () => {
    // Below would push one pane's content out of step with the other.
    const { container } = render(<DiffPane {...props()} />);
    const view = pane(container, "b");
    act(() => {
      openSearchPanel(view);
    });
    expect(view.dom.querySelector(".cm-panels-top")).toBeInTheDocument();
    expect(view.dom.querySelector(".cm-panels-bottom")).toBeNull();
  });
});

describe("edits", () => {
  it("reports what the working-tree pane now holds", () => {
    // Dispatched through the view, which is the path typing and the `»` both take.
    const onRightChange = vi.fn();
    const { container } = render(<DiffPane {...props({ onRightChange })} />);

    act(() => {
      pane(container, "b").dispatch({ changes: { from: 0, insert: "edited " } });
    });

    expect(onRightChange).toHaveBeenCalledWith("edited one\nTWO\nthree\n");
  });

  it("re-diffs after an edit", () => {
    const { container } = render(<DiffPane {...props()} />);
    act(() => {
      pane(container, "b").dispatch({
        changes: { from: 0, to: pane(container, "b").state.doc.length, insert: "one\ntwo\nthree\n" },
      });
    });

    // The panes now agree, so there is nothing left to mark.
    expect(getChunks(pane(container, "b").state)?.chunks).toHaveLength(0);
  });

  it("replaces the HEAD side when a new commit arrives", () => {
    const { container, rerender } = render(<DiffPane {...props()} />);
    rerender(<DiffPane {...props({ left: "committed\n" })} />);
    expect(docOf(container, "a")).toBe("committed\n");
  });

  it("adopts working-tree content the window decided to push in", () => {
    const { container, rerender } = render(<DiffPane {...props()} />);
    rerender(<DiffPane {...props({ right: "from disk\n", rightRevision: 1 })} />);
    expect(docOf(container, "b")).toBe("from disk\n");
  });

  it("re-applies content the pane has drifted from when the revision bumps", () => {
    // The window freezes `right` while it protects unsaved typing, so an adopt can
    // hand back a string this pane was already shown. The revision is what makes
    // that visible here.
    const { container, rerender } = render(<DiffPane {...props()} />);
    act(() => {
      pane(container, "b").dispatch({ changes: { from: 0, insert: "typed " } });
    });

    rerender(<DiffPane {...props({ rightRevision: 1 })} />);

    expect(docOf(container, "b")).toBe("one\nTWO\nthree\n");
  });

  it("does not reset the pane when only unrelated props change", () => {
    // A re-render must never throw away the cursor, the scroll position or the
    // undo stack — and must not re-run the diff.
    const { container, rerender } = render(<DiffPane {...props()} />);
    act(() => {
      pane(container, "b").dispatch({ changes: { from: 0, insert: "typed " } });
    });

    rerender(<DiffPane {...props({ onRightChange: vi.fn() })} />);

    expect(docOf(container, "b")).toBe("typed one\nTWO\nthree\n");
  });

  it("keeps one MergeView across a re-render rather than rebuilding it", () => {
    const { container, rerender } = render(<DiffPane {...props()} />);
    const before = container.querySelector(".cm-mergeView");
    rerender(<DiffPane {...props()} />);
    expect(container.querySelector(".cm-mergeView")).toBe(before);
  });
});

describe("the toolbar", () => {
  it("offers the Compact toggle, off by default", () => {
    render(<DiffPane {...props()} />);
    expect(screen.getByRole("button", { name: "Compact", pressed: false })).toBeInTheDocument();
  });

  it("shows the toggle as on when the settings say so", () => {
    useSettingsStore.setState({ settings: settings({ "collapse-unchanged": true }) });
    render(<DiffPane {...props()} />);
    expect(screen.getByRole("button", { name: "Compact", pressed: true })).toBeInTheDocument();
  });

  it("persists the toggle rather than keeping it to this window", () => {
    // A view option is a setting: every diff window should open the way the last
    // one was left.
    render(<DiffPane {...props()} />);
    act(() => screen.getByRole("button", { name: "Compact" }).click());
    expect(save).toHaveBeenCalledWith({ viewOptions: { "collapse-unchanged": true } });
  });

  it("offers change navigation", () => {
    render(<DiffPane {...props()} />);
    expect(screen.getByRole("button", { name: "Previous change" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next change" })).toBeInTheDocument();
  });

  it("counts the changes even in a pane nothing has measured", async () => {
    // A pane with no content height yet — its first frame, before CodeMirror has a
    // height map. The strip is allowed to be empty until the geometry answers; the
    // count and the navigation are not, or the toolbar would claim a file with one
    // change has none and disable the buttons over it.
    const { container } = render(<DiffPane {...props()} />);
    await act(async () => {
      vi.spyOn(pane(container, "b"), "contentHeight", "get").mockReturnValue(0);
      pane(container, "b").dispatch({ changes: { from: 0, to: 0, insert: "" } });
    });

    await waitFor(() => {
      expect(container.querySelectorAll(".ew-ruler-mark")).toHaveLength(0);
    });
    expect(screen.getByText("1 change")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next change" })).toBeEnabled();
  });

  it("says so when there is nothing to navigate", () => {
    render(<DiffPane {...props({ left: "one\nTWO\nthree\n" })} />);
    expect(screen.getByText("No changes in this file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next change" })).toBeDisabled();
  });

  it("names itself, so it is not just some buttons", () => {
    render(<DiffPane {...props()} />);
    expect(screen.getByRole("toolbar", { name: "Diff view" })).toBeInTheDocument();
  });

  it("moves the cursor to the next change", () => {
    const { container } = render(<DiffPane {...props()} />);
    const view = pane(container, "b");
    act(() => {
      view.dispatch({ selection: { anchor: 0 } });
    });

    act(() => screen.getByRole("button", { name: "Next change" }).click());

    // Line 2 is the one that differs.
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
  });
});

describe("the revert control", () => {
  it("is configured to restore from HEAD into the working file", () => {
    // Part 4's `»`. The column exists as soon as the MergeView does; the buttons
    // inside it are placed from measured chunk positions, so jsdom has none —
    // clicking one is a manual check.
    const { container } = render(<DiffPane {...props()} />);
    expect(container.querySelector(".cm-merge-revert")).toBeInTheDocument();
  });
});

describe("the divider", () => {
  it("reports where it sits so the headers can line up with the panes", () => {
    const onSplitAt = vi.fn();
    render(<DiffPane {...props({ onSplitAt })} />);
    // jsdom measures every box as zero, so the value is not the point; being told
    // at all is, because the header has no other way to find the split.
    expect(onSplitAt).toHaveBeenCalled();
  });

  it("offers a handle to drag", () => {
    render(<DiffPane {...props()} />);
    expect(screen.getByRole("separator", { name: "Resize the panes" })).toBeInTheDocument();
  });
});

/**
 * Give the working-tree pane a layout, so the change map has something to measure.
 *
 * Without it every line block is at top 0 and each mark falls back to
 * `MIN_HEIGHT` at the top of the strip — true to jsdom, and useless for asserting
 * that a mark lands where its chunk is. Twenty pixels a line makes the geometry real.
 */
function withLayout(container: HTMLElement): void {
  const view = pane(container, "b");
  const lineHeight = 20;
  vi.spyOn(view, "contentHeight", "get").mockReturnValue(view.state.doc.lines * lineHeight);
  vi.spyOn(view, "lineBlockAt").mockImplementation((pos: number) => {
    const line = view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length)));
    const top = (line.number - 1) * lineHeight;
    return { from: line.from, to: line.to, top, bottom: top + lineHeight, height: lineHeight } as
      ReturnType<EditorView["lineBlockAt"]>;
  });
}

describe("the change map", () => {
  it("marks each change, coloured from the theme", async () => {
    const { container } = render(<DiffPane {...props()} />);
    await act(async () => {
      withLayout(container);
      // Any doc change re-measures; this one is a no-op replacement of the content.
      const view = pane(container, "b");
      view.dispatch({ changes: { from: 0, to: 0, insert: "" }, scrollIntoView: false });
    });

    // `waitFor`, because the pane coalesces its measuring onto an animation frame
    // rather than forcing a layout inside CodeMirror's update cycle.
    await waitFor(() => {
      expect(container.querySelectorAll(".ew-ruler-mark")).toHaveLength(1);
    });
    const mark = container.querySelector<HTMLElement>(".ew-ruler-mark");
    expect(mark?.dataset.kind).toBe("modified");
    expect(mark?.style.background).toBe(hexToRgb(DEFAULT_THEME.tokens.markModified));
  });

  it("drops the marks when a new HEAD leaves nothing to mark", async () => {
    // The path nothing else covers: a change to the *HEAD* side reaches the other
    // pane as a bare `setChunks` effect, with neither `docChanged` nor — unless the
    // spacers move — `geometryChanged`, so the update listener never fires. A
    // `commit --amend` or a checkout that lands an edit of the same line count would
    // otherwise leave the strip marking chunks the file no longer has.
    const { container, rerender } = render(<DiffPane {...props()} />);
    await act(async () => {
      withLayout(container);
      pane(container, "b").dispatch({ changes: { from: 0, to: 0, insert: "" } });
    });
    await waitFor(() => {
      expect(container.querySelectorAll(".ew-ruler-mark")).toHaveLength(1);
    });

    // HEAD catches up with the working tree: same line count, no chunk left.
    rerender(<DiffPane {...props({ left: "one\nTWO\nthree\n" })} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".ew-ruler-mark")).toHaveLength(0);
    });
    expect(screen.getByText("No changes in this file")).toBeInTheDocument();
  });

  it("recolours the marks when the theme changes", async () => {
    // The wiring this pins: `theme` state in the pane reaching the strip as
    // `markerColors(theme)`. Nothing else in the file touches that path, and the
    // marks hold the colour they were handed rather than reading CSS.
    const { container } = render(<DiffPane {...props()} />);
    await act(async () => {
      withLayout(container);
      pane(container, "b").dispatch({ changes: { from: 0, to: 0, insert: "" } });
    });

    const light = themeById("vscode-light");
    await act(async () => {
      publishAppearance(document.documentElement, {
        fontFamily: "",
        fontSize: 14,
        theme: light,
      });
    });

    await waitFor(() => {
      const mark = container.querySelector<HTMLElement>(".ew-ruler-mark");
      expect(mark?.style.background).toBe(hexToRgb(light.tokens.markModified));
    });
  });
});

describe("diff precision", () => {
  it("reports that a file of this size was compared exactly", () => {
    const onImprecise = vi.fn();
    render(<DiffPane {...props({ onImprecise })} />);
    expect(onImprecise).toHaveBeenLastCalledWith(false);
  });

  it("re-reports after an edit rather than answering once at mount", async () => {
    // `precise` describes the *current* diff, and the diff is recomputed on every
    // edit and every side replaced. Said once at mount it would go stale both ways:
    // a warning left up after the file was edited back down to a small diff, or none
    // at all on a coarse diff that arrived through a reload.
    const onImprecise = vi.fn();
    const { container } = render(<DiffPane {...props({ onImprecise })} />);
    const before = onImprecise.mock.calls.length;

    await act(async () => {
      withLayout(container);
      pane(container, "b").dispatch({ changes: { from: 0, insert: "edited " } });
    });

    await waitFor(() => {
      expect(onImprecise.mock.calls.length).toBeGreaterThan(before);
    });
    expect(onImprecise).toHaveBeenLastCalledWith(false);
  });
});

describe("appearance", () => {
  it("repaints both panes when the theme changes", () => {
    const { container } = render(<DiffPane {...props()} />);
    const light = themeById("vscode-light");

    act(() => {
      publishAppearance(document.documentElement, {
        fontFamily: "",
        fontSize: 14,
        theme: light,
      });
    });

    const css = Array.from(document.querySelectorAll("style"))
      .map((element) => element.textContent ?? "")
      .join("\n");
    expect(css).toContain(light.tokens.bg);
    // And the panes are still the ones they were: a theme change is a
    // reconfigure, not a rebuild.
    expect(docOf(container, "b")).toBe("one\nTWO\nthree\n");
  });
});

describe("teardown", () => {
  it("destroys the MergeView on unmount", () => {
    const { container, unmount } = render(<DiffPane {...props()} />);
    expect(container.querySelector(".cm-mergeView")).toBeInTheDocument();
    unmount();
    expect(container.querySelector(".cm-mergeView")).toBeNull();
  });

  it("stops following the appearance on unmount", () => {
    const { unmount } = render(<DiffPane {...props()} />);
    unmount();
    // A leaked subscription would dispatch into a destroyed view and throw.
    expect(() =>
      publishAppearance(document.documentElement, {
        fontFamily: "",
        fontSize: 14,
        theme: themeById("vscode-light"),
      }),
    ).not.toThrow();
  });
});
