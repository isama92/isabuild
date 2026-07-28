import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EditorWindow } from "./EditorWindow";

describe("EditorWindow", () => {
  it("puts the window's own header in the header row", () => {
    render(
      <EditorWindow header={<span>abc1234 src/a.ts</span>}>
        <p>panes</p>
      </EditorWindow>,
    );
    expect(screen.getByText("abc1234 src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("panes")).toBeInTheDocument();
  });

  it("keeps the window's own class alongside its own", () => {
    // Each window still owns a few rules; the shell must not take the hook away.
    const { container } = render(
      <EditorWindow className="diff-window" header={null}>
        {null}
      </EditorWindow>,
    );
    expect(container.firstElementChild).toHaveClass("ew-window", "diff-window");
  });

  it("interrupts for an error and merely reports anything else", () => {
    // A failed save has to reach a screen reader now; a hint should wait its turn.
    render(
      <EditorWindow
        header={null}
        notices={[
          { id: "save", tone: "error", text: "Could not save: permission denied" },
          { id: "stale", tone: "warn", text: "This file changed on disk" },
          { id: "hint", tone: "info", text: "Loading diff…" },
        ]}
      >
        {null}
      </EditorWindow>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not save: permission denied");
    const statuses = screen.getAllByRole("status").map((element) => element.textContent);
    expect(statuses).toEqual(["This file changed on disk", "Loading diff…"]);
  });

  it("renders the notices in the order it was given them", () => {
    const { container } = render(
      <EditorWindow
        header={null}
        notices={[
          { id: "one", tone: "warn", text: "first" },
          { id: "two", tone: "warn", text: "second" },
        ]}
      >
        {null}
      </EditorWindow>,
    );
    const texts = Array.from(container.querySelectorAll(".ew-notice")).map(
      (element) => element.textContent,
    );
    expect(texts).toEqual(["first", "second"]);
  });

  it("renders no notice strip when there is nothing to say", () => {
    const { container } = render(
      <EditorWindow header={null}>{null}</EditorWindow>,
    );
    expect(container.querySelector(".ew-notice")).toBeNull();
  });
});
