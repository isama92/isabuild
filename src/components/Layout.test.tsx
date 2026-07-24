import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Layout } from "./Layout";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

// Render the resizable primitives as plain wrappers so the test never depends
// on the library's DOM measurement — we only care about the mount/unmount
// wiring and the size-persistence props driven by the store. The Panel mock
// forwards `defaultSize` (as a data attribute) and exposes `onResize` via a
// button so a test can drive the persistence round-trip.
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({
    id,
    defaultSize,
    onResize,
    children,
  }: {
    id?: string;
    defaultSize?: number | string;
    onResize?: (size: { asPercentage: number; inPixels: number }) => void;
    children: ReactNode;
  }) => (
    <div data-testid={`panel-${id}`} data-default-size={defaultSize ?? ""}>
      {onResize && (
        <button
          type="button"
          data-testid={`resize-${id}`}
          onClick={() => onResize({ asPercentage: 45, inPixels: 300 })}
        />
      )}
      {children}
    </div>
  ),
  Separator: () => <div data-testid="separator" />,
}));

// Identify which terminals are mounted by session id.
vi.mock("./TerminalView", () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`term-${sessionId}`} />
  ),
}));

beforeEach(() => {
  useLayoutStore.setState(initialLayoutState);
});

function pressCtrl1() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { ctrlKey: true, code: "Digit1", bubbles: true }),
    );
  });
}

describe("Layout", () => {
  it("shows both the Claude and shell terminals by default", () => {
    render(<Layout />);
    expect(screen.getByTestId("term-claude-main")).toBeInTheDocument();
    expect(screen.getByTestId("term-shell-main")).toBeInTheDocument();
    expect(screen.getByTestId("separator")).toBeInTheDocument();
  });

  it("Ctrl+1 hides then reshows the shell terminal; Claude stays mounted", () => {
    render(<Layout />);
    pressCtrl1();
    expect(screen.queryByTestId("term-shell-main")).not.toBeInTheDocument();
    expect(screen.queryByTestId("separator")).not.toBeInTheDocument();
    expect(screen.getByTestId("term-claude-main")).toBeInTheDocument();
    pressCtrl1();
    expect(screen.getByTestId("term-shell-main")).toBeInTheDocument();
  });

  it("the status-bar toggle reshows the terminal after the close button hides it", () => {
    render(<Layout />);
    fireEvent.click(screen.getByRole("button", { name: /close terminal/i }));
    expect(screen.queryByTestId("term-shell-main")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /toggle terminal/i }));
    expect(screen.getByTestId("term-shell-main")).toBeInTheDocument();
  });

  it("remembers the dragged terminal size and restores it on reopen", () => {
    render(<Layout />);
    expect(screen.getByTestId("panel-terminal")).toHaveAttribute("data-default-size", "30%");

    // Simulate a resize drag settling at 45%.
    fireEvent.click(screen.getByTestId("resize-terminal"));
    expect(useLayoutStore.getState().bottomTerminalSize).toBe(45);

    // Hide then reshow: the terminal Panel remounts seeded with the stored size.
    pressCtrl1();
    pressCtrl1();
    expect(screen.getByTestId("panel-terminal")).toHaveAttribute("data-default-size", "45%");
  });
});
