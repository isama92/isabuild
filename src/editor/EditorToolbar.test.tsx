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
});
