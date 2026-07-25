import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MergePanes } from "./MergePanes";
import type { ConflictStages } from "../lib/gitMerge";

// Real CodeMirror, not a mock. It constructs perfectly well under jsdom — what it
// cannot do there is *measure*, and that shapes what this file can assert:
//
// - Decorations, gutter markers and the toolbar are all real and testable.
// - **A gutter arrow cannot be clicked.** CodeMirror resolves which line a gutter
//   click belongs to from `getBoundingClientRect()`, which is all zeros in jsdom, so
//   every arrow would resolve to line 1. The arrows' *presence* is asserted here;
//   the apply path they share with the toolbar is driven through the toolbar, which
//   is plain React. Clicking an arrow is left to the manual pass in the plan.
// - Nothing asserts on scroll positions; paneScroll's arithmetic is unit-tested.
//
// @codemirror/language-data is stubbed to nothing: it dynamically imports ~140
// language modules, and highlighting is not what this file is about.
vi.mock("@codemirror/language-data", () => ({ languages: [] }));

/**
 * Two conflicts and one unchanged run between them.
 *
 * base:   a / one     / b / two     / c / ""
 * ours:   a / MINE1   / b / MINE2   / c / ""
 * theirs: a / THEIRS1 / b / THEIRS2 / c / ""
 *
 * Two conflicts rather than one so the position mapping has something to prove:
 * resolving the first shortens the buffer by four lines, and the second must still
 * be found after it.
 */
const RESULT = [
  "a",
  "<<<<<<< HEAD",
  "MINE1",
  "=======",
  "THEIRS1",
  ">>>>>>> feature",
  "b",
  "<<<<<<< HEAD",
  "MINE2",
  "=======",
  "THEIRS2",
  ">>>>>>> feature",
  "c",
  "",
].join("\n");

function stages(overrides: Partial<ConflictStages> = {}): ConflictStages {
  return {
    path: "src/app.ts",
    base: ["a", "one", "b", "two", "c", ""],
    ours: ["a", "MINE1", "b", "MINE2", "c", ""],
    theirs: ["a", "THEIRS1", "b", "THEIRS2", "c", ""],
    stages: [1, 2, 3],
    chunks: [
      chunk("unchanged", [0, 1], [0, 1], [0, 1], [0, 1]),
      chunk("conflict", [1, 2], [1, 2], [1, 2], [1, 6]),
      chunk("unchanged", [2, 3], [2, 3], [2, 3], [6, 7]),
      chunk("conflict", [3, 4], [3, 4], [3, 4], [7, 12]),
      chunk("unchanged", [4, 6], [4, 6], [4, 6], [12, 14]),
    ],
    result: RESULT,
    disk: RESULT,
    oursLabel: "HEAD",
    theirsLabel: "feature",
    revision: "rev-1",
    diverged: false,
    binary: false,
    ...overrides,
  };
}

function chunk(
  kind: ConflictStages["chunks"][number]["kind"],
  base: [number, number],
  ours: [number, number],
  theirs: [number, number],
  result: [number, number],
): ConflictStages["chunks"][number] {
  const range = ([start, end]: [number, number]) => ({ start, end });
  return { kind, base: range(base), ours: range(ours), theirs: range(theirs), result: range(result) };
}

/** Last text the component reported, i.e. the buffer as the window would hold it. */
let reported = RESULT;

function setup(overrides: Partial<ConflictStages> = {}, value = RESULT) {
  const model = stages(overrides);
  reported = value;
  const onChange = vi.fn((text: string) => {
    reported = text;
  });
  const view = render(
    <MergePanes path={model.path} stages={model} value={value} onChange={onChange} busy={false} />,
  );
  return { model, view, onChange };
}

/** The CodeMirror document of one pane, as text. */
function docOf(testId: string): string {
  const content = screen.getByTestId(testId).querySelector(".cm-content");
  if (!content) throw new Error(`${testId} has no CodeMirror content`);
  return Array.from(content.querySelectorAll(".cm-line"))
    .map((line) => line.textContent)
    .join("\n");
}

function arrowsIn(testId: string): NodeListOf<Element> {
  return screen.getByTestId(testId).querySelectorAll(".isabuild-arrow");
}

const click = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));

/** Move the cursor to the next conflict — the one navigation that needs no pixels. */
const toNextConflict = () => click(/next/i);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MergePanes", () => {
  it("mounts three panes and labels the sides with git's own marker labels", () => {
    setup();
    expect(screen.getByTestId("pane-ours")).toBeInTheDocument();
    expect(screen.getByTestId("pane-result")).toBeInTheDocument();
    expect(screen.getByTestId("pane-theirs")).toBeInTheDocument();
    expect(screen.getByText("HEAD (mine)")).toBeInTheDocument();
    expect(screen.getByText("feature (theirs)")).toBeInTheDocument();
  });

  it("shows each side's own index stage, not the working-tree file", () => {
    // The premise of the whole part: the panes come from the stages, so each side
    // shows what git stored rather than what the conflicted merge left on disk.
    setup();
    expect(docOf("pane-ours")).toBe("a\nMINE1\nb\nMINE2\nc\n");
    expect(docOf("pane-theirs")).toBe("a\nTHEIRS1\nb\nTHEIRS2\nc\n");
    expect(docOf("pane-result")).toContain("<<<<<<< HEAD");
  });

  it("keeps the side panes read-only and the result editable", () => {
    // Ours and theirs are git blobs: there is nowhere for an edit to them to go.
    setup();
    for (const testId of ["pane-ours", "pane-theirs"]) {
      expect(screen.getByTestId(testId).querySelector(".cm-content")).toHaveAttribute(
        "contenteditable",
        "false",
      );
    }
    expect(screen.getByTestId("pane-result").querySelector(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true",
    );
  });

  it("decorates the marker lines in the result buffer", () => {
    // They are real, editable text, so they are styled to read as structure.
    setup();
    expect(screen.getByTestId("pane-result").querySelectorAll(".isabuild-marker")).toHaveLength(6);
  });

  it("tints each chunk in that side's own coordinates", () => {
    setup();
    expect(arrowsIn("pane-ours").length).toBeGreaterThan(0);
    expect(
      screen.getByTestId("pane-ours").querySelectorAll(".isabuild-chunk-conflict").length,
    ).toBe(2);
    expect(
      screen.getByTestId("pane-theirs").querySelectorAll(".isabuild-chunk-conflict").length,
    ).toBe(2);
  });

  describe("the gutter arrows", () => {
    it("offers one per conflict on each side", () => {
      setup();
      expect(arrowsIn("pane-ours")).toHaveLength(2);
      expect(arrowsIn("pane-theirs")).toHaveLength(2);
    });

    it("offers none on an unchanged chunk", () => {
      // Nothing happened there; "take ours" would be offering the base again.
      setup({ chunks: [chunk("unchanged", [0, 6], [0, 6], [0, 6], [0, 14])] });
      expect(arrowsIn("pane-ours")).toHaveLength(0);
      expect(arrowsIn("pane-theirs")).toHaveLength(0);
    });

    it("offers none for a side the chunk already holds", () => {
      // The result already has our version of an ours-only chunk, so a `»` there
      // would be a no-op. Theirs can still be taken — that is how an auto-applied
      // change gets replaced.
      setup({ chunks: [chunk("ours", [0, 6], [0, 6], [0, 6], [0, 14])] });
      expect(arrowsIn("pane-ours")).toHaveLength(0);
      expect(arrowsIn("pane-theirs")).toHaveLength(1);
    });
  });

  describe("the toolbar", () => {
    it("describes the chunk the cursor starts in, without waiting to be clicked", () => {
      setup();
      expect(screen.getByText(/Chunk 1 of 5 — unchanged by both sides/)).toBeInTheDocument();
    });

    it("follows the cursor to the conflict it navigated to", () => {
      setup();
      toNextConflict();
      expect(screen.getByText(/Chunk 2 of 5 — changed differently by both/)).toBeInTheDocument();
    });

    it("offers nothing on an unchanged chunk", () => {
      setup();
      for (const name of [/take mine/i, /take theirs/i, /take both/i, /revert to base/i]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
    });

    it("offers all four choices on a conflict", () => {
      setup();
      toNextConflict();
      for (const name of [/take mine/i, /take theirs/i, /take both/i, /revert to base/i]) {
        expect(screen.getByRole("button", { name })).toBeEnabled();
      }
    });

    it("replaces a conflict with our side, markers and all", () => {
      setup();
      toNextConflict();
      click(/take mine/i);

      expect(reported).toBe("a\nMINE1\nb\n<<<<<<< HEAD\nMINE2\n=======\nTHEIRS2\n>>>>>>> feature\nc\n");
      // The first conflict is gone entirely — no marker survived it.
      expect(reported).not.toContain("THEIRS1");
    });

    it("replaces a conflict with their side", () => {
      setup();
      toNextConflict();
      click(/take theirs/i);
      expect(reported).toContain("a\nTHEIRS1\nb\n");
      expect(reported).not.toContain("MINE1");
    });

    it("takes both sides, ours first", () => {
      setup();
      toNextConflict();
      click(/take both/i);
      expect(reported).toContain("a\nMINE1\nTHEIRS1\nb\n");
    });

    it("reverts a chunk to the merge base, discarding both sides", () => {
      setup();
      toNextConflict();
      click(/revert to base/i);
      expect(reported).toContain("a\none\nb\n");
    });

    it("still finds the second conflict after the first has shortened the buffer", () => {
      // The reason the spans are mapped through transactions rather than
      // recomputed: resolving the first conflict removes four lines, and an arrow
      // acting on stale offsets would rewrite somebody else's lines.
      setup();
      toNextConflict();
      click(/take mine/i);

      toNextConflict();
      expect(screen.getByText(/Chunk 4 of 5 — changed differently by both/)).toBeInTheDocument();
      click(/take theirs/i);

      expect(reported).toBe("a\nMINE1\nb\nTHEIRS2\nc\n");
    });

    it("survives a new stages object of identical content", () => {
      // The window's watcher reload produces exactly that. If `stages` identity were
      // a dependency of the construction effect, all three editors would be
      // destroyed and rebuilt from a seed ref frozen at first render — silently
      // reverting the user's resolution to the pristine marker text while the
      // window's buffer state still said otherwise.
      const { view, model } = setup();
      toNextConflict();
      click(/take mine/i);
      const resolved = reported;
      const shown = docOf("pane-result");

      view.rerender(
        <MergePanes
          path={model.path}
          // A fresh object, same content — what a reload of an unchanged file gives.
          stages={{ ...model }}
          value={resolved}
          onChange={vi.fn()}
          busy={false}
        />,
      );

      // Same document, not the pristine marker text it was seeded with.
      expect(docOf("pane-result")).toBe(shown);
      expect(docOf("pane-result")).not.toContain("THEIRS1");
    });

    it("has nothing to navigate to in a resolved buffer", () => {
      setup({}, "a\nMINE1\nb\nMINE2\nc\n");
      expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    });

    it("disables every chunk action while a write is in flight", () => {
      const model = stages();
      render(
        <MergePanes
          path={model.path}
          stages={model}
          value={RESULT}
          onChange={vi.fn()}
          busy
        />,
      );
      for (const name of [/take mine/i, /take theirs/i, /take both/i, /revert to base/i]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
    });
  });
});
