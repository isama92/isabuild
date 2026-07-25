import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConflictBlocks } from "./ConflictBlocks";
import type { ConflictBlock } from "../lib/gitMerge";

// Two conflicts with context above, between and below, so the interleaving of
// context lines and blocks is actually exercised.
const LINES = [
  "top",
  "<<<<<<< HEAD",
  "first ours",
  "=======",
  "first theirs",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "second ours",
  "=======",
  "second theirs",
  ">>>>>>> feature",
  "bottom",
  "",
];

const BLOCKS: ConflictBlock[] = [
  {
    start: 1,
    end: 6,
    ours: { start: 2, end: 3 },
    base: null,
    theirs: { start: 4, end: 5 },
    oursLabel: "HEAD",
    theirsLabel: "feature",
    complete: true,
  },
  {
    start: 7,
    end: 12,
    ours: { start: 8, end: 9 },
    base: null,
    theirs: { start: 10, end: 11 },
    oursLabel: "HEAD",
    theirsLabel: "feature",
    complete: true,
  },
];

function setup(busy = false) {
  const onResolve = vi.fn();
  render(<ConflictBlocks lines={LINES} blocks={BLOCKS} busy={busy} onResolve={onResolve} />);
  return onResolve;
}

describe("ConflictBlocks", () => {
  it("renders every conflict, numbered for the reader", () => {
    setup();
    expect(screen.getByLabelText("Conflict 1 of 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Conflict 2 of 2")).toBeInTheDocument();
  });

  it("keeps the context lines between and around the blocks", () => {
    setup();
    for (const text of ["top", "middle", "bottom"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("hides the marker lines themselves", () => {
    // They are structure, not content: the block borders and labels say the same
    // thing without the noise.
    setup();
    expect(screen.queryByText("<<<<<<< HEAD")).not.toBeInTheDocument();
    expect(screen.queryByText("=======")).not.toBeInTheDocument();
    expect(screen.queryByText(">>>>>>> feature")).not.toBeInTheDocument();
  });

  it("numbers lines as they are in the file, markers included", () => {
    // The numbers have to agree with the terminal and any editor while the
    // conflict is still there, so they count the marker lines even though the
    // markers are not shown.
    setup();
    expect(screen.getByText("top").closest(".merge-line")).toHaveTextContent("1");
    // "second ours" is index 8 → line 9.
    expect(screen.getByText("second ours").closest(".merge-line")).toHaveTextContent("9");
  });

  it("reports the index of the conflict that was resolved", () => {
    const onResolve = setup();
    const second = screen.getByLabelText("Conflict 2 of 2");

    fireEvent.click(second.querySelector("button")!);

    // The *second* block, not the first: an off-by-one here rewrites the wrong
    // hunk of someone's file.
    expect(onResolve).toHaveBeenCalledWith(1, "ours");
  });

  it("reports each choice distinctly", () => {
    const onResolve = setup();
    const first = screen.getByLabelText("Conflict 1 of 2");
    const buttons = first.querySelectorAll("button");

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[2]);

    expect(onResolve.mock.calls).toEqual([
      [0, "ours"],
      [0, "theirs"],
      [0, "both"],
    ]);
  });

  it("disables every choice while a resolution is in flight", () => {
    setup(true);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("withholds the accept buttons on a half-edited block and says why", () => {
    // Without both markers there is no boundary between the sides. Guessing one
    // wrote a conflict marker back into the file and then staged it, so the block
    // is shown with no way to accept it.
    const onResolve = vi.fn();
    const lines = ["top", "<<<<<<< HEAD", "ours", ">>>>>>> feature", "bottom", ""];
    render(
      <ConflictBlocks
        lines={lines}
        blocks={[
          {
            start: 1,
            end: 4,
            ours: { start: 2, end: 3 },
            base: null,
            theirs: { start: 3, end: 3 },
            oursLabel: "HEAD",
            theirsLabel: "",
            complete: false,
          },
        ]}
        busy={false}
        onResolve={onResolve}
      />,
    );

    expect(screen.queryByRole("button", { name: "Accept ours" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept both" })).not.toBeInTheDocument();
    expect(screen.getByText(/fix it by hand/i)).toBeInTheDocument();
    // The lines are still shown: the user has to see what state the file is in.
    expect(screen.getByText("ours")).toBeInTheDocument();
  });

  it("renders an empty file with no conflicts as nothing at all", () => {
    const onResolve = vi.fn();
    const { container } = render(
      <ConflictBlocks lines={[]} blocks={[]} busy={false} onResolve={onResolve} />,
    );
    expect(container.querySelectorAll(".merge-line")).toHaveLength(0);
    expect(container.querySelectorAll(".merge-block")).toHaveLength(0);
  });
});
