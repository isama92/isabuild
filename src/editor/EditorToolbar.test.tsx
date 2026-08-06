import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EditorToolbar, type ToolbarButton } from "./EditorToolbar";

function button(overrides: Partial<ToolbarButton> = {}): ToolbarButton {
  return {
    kind: "button",
    id: "take-mine",
    label: "Take mine",
    tooltip: "Replace this chunk with your version",
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe("EditorToolbar", () => {
  it("names itself, because the app has more than one toolbar", () => {
    render(<EditorToolbar items={[button()]} label="Diff actions" />);
    expect(screen.getByRole("toolbar", { name: "Diff actions" })).toBeInTheDocument();
  });

  it("renders a button with its tooltip and runs it on click", () => {
    const onSelect = vi.fn();
    render(<EditorToolbar items={[button({ onSelect })]} label="Actions" />);

    const control = screen.getByRole("button", { name: "Take mine" });
    expect(control).toHaveAttribute("title", "Replace this chunk with your version");
    control.click();

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("disables a button the pane says is not available", () => {
    render(<EditorToolbar items={[button({ disabled: true })]} label="Actions" />);
    expect(screen.getByRole("button", { name: "Take mine" })).toBeDisabled();
  });

  it("reports a toggle's state through aria-pressed, not only through colour", () => {
    render(
      <EditorToolbar
        label="Actions"
        items={[
          {
            kind: "toggle",
            id: "collapse-unchanged",
            label: "Compact",
            tooltip: "Hide unchanged lines",
            active: true,
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Compact", pressed: true });
    expect(toggle).toHaveClass("ew-button--active");
  });

  it("leaves aria-pressed off a plain button", () => {
    // A button that is not a toggle must not read as an unpressed one.
    render(<EditorToolbar items={[button()]} label="Actions" />);
    expect(screen.getByRole("button", { name: "Take mine" })).not.toHaveAttribute("aria-pressed");
  });

  it("renders a group's buttons in order", () => {
    render(
      <EditorToolbar
        label="Actions"
        items={[
          {
            kind: "group",
            id: "navigate",
            items: [
              button({ id: "previous", label: "◂ Previous" }),
              button({ id: "next", label: "Next ▸" }),
            ],
          },
        ]}
      />,
    );

    const labels = screen.getAllByRole("button").map((element) => element.textContent);
    expect(labels).toEqual(["◂ Previous", "Next ▸"]);
  });

  it("renders status text as text, not as a control", () => {
    render(
      <EditorToolbar
        label="Actions"
        items={[{ kind: "status", id: "current", text: "Chunk 2 of 7 — both sides changed this" }]}
      />,
    );

    expect(screen.getByText("Chunk 2 of 7 — both sides changed this")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  describe("icons", () => {
    // The guarantee the whole icon API rests on: giving a button an icon must not
    // change what finds it. Every existing query in the merge and diff suites is
    // `getByRole("button", { name })`, and they are not rewritten when a label
    // stops being visible.
    it("keeps the label as the accessible name when the button is an icon", () => {
      render(
        <EditorToolbar
          label="Actions"
          items={[button({ label: "Next change", icon: <svg data-testid="glyph" /> })]}
        />,
      );

      const control = screen.getByRole("button", { name: "Next change" });
      expect(control).toHaveTextContent("");
      expect(control).toHaveClass("ew-button--icon");
      expect(screen.getByTestId("glyph")).toBeInTheDocument();
    });

    it("hides the icon from assistive tech, so the name is not said twice", () => {
      render(
        <EditorToolbar
          label="Actions"
          items={[button({ label: "Next change", icon: <svg data-testid="glyph" /> })]}
        />,
      );

      expect(screen.getByTestId("glyph").parentElement).toHaveAttribute("aria-hidden", "true");
    });

    it("leaves aria-label off a text button, whose text is already its name", () => {
      render(<EditorToolbar items={[button()]} label="Actions" />);
      expect(screen.getByRole("button", { name: "Take mine" })).not.toHaveAttribute("aria-label");
    });

    it("still reports a toggle's state when it is an icon", () => {
      render(
        <EditorToolbar
          label="Actions"
          items={[
            {
              kind: "toggle",
              id: "collapse-unchanged",
              label: "Compact",
              tooltip: "Hide unchanged lines",
              icon: <svg />,
              active: true,
              onSelect: vi.fn(),
            },
          ]}
        />,
      );

      expect(screen.getByRole("button", { name: "Compact", pressed: true })).toHaveClass(
        "ew-button--active",
      );
    });
  });

  describe("layout items", () => {
    it("joins a segmented group into one control", () => {
      const { container } = render(
        <EditorToolbar
          label="Actions"
          items={[
            {
              kind: "group",
              id: "view-mode",
              variant: "segmented",
              items: [button({ id: "split" }), button({ id: "unified", label: "Unified" })],
            },
          ]}
        />,
      );

      expect(container.querySelector(".ew-toolbar-group--segmented")).not.toBeNull();
    });

    it("leaves an ordinary group unjoined", () => {
      const { container } = render(
        <EditorToolbar
          label="Actions"
          items={[{ kind: "group", id: "navigate", items: [button()] }]}
        />,
      );

      const group = container.querySelector(".ew-toolbar-group");
      expect(group).not.toBeNull();
      expect(group).not.toHaveClass("ew-toolbar-group--segmented");
    });

    it("renders a spacer that is not a control", () => {
      const { container } = render(
        <EditorToolbar label="Actions" items={[{ kind: "spacer", id: "gap" }]} />,
      );

      expect(container.querySelector(".ew-toolbar-spacer")).not.toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders a separator as one, so a cluster boundary is not colour-only", () => {
      render(<EditorToolbar label="Actions" items={[{ kind: "separator", id: "rule" }]} />);
      expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
    });

    it("keeps every item in the order it was given", () => {
      const { container } = render(
        <EditorToolbar
          label="Actions"
          items={[
            { kind: "group", id: "navigate", items: [button({ id: "a", label: "A" })] },
            { kind: "separator", id: "rule" },
            { kind: "spacer", id: "gap" },
            { kind: "status", id: "count", text: "6 changes" },
          ]}
        />,
      );

      const classes = Array.from(container.querySelectorAll(".ew-toolbar > *")).map(
        (element) => element.className,
      );
      expect(classes).toEqual([
        "ew-toolbar-group",
        "ew-toolbar-separator",
        "ew-toolbar-spacer",
        "ew-toolbar-status",
      ]);
    });
  });
});
