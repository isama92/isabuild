import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Layout } from "./Layout";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

// Render the resizable primitives as plain wrappers so the test never depends
// on the library's DOM measurement — we only care about the mount/unmount
// wiring and the size-persistence props driven by the store. The Panel mock
// forwards `defaultSize` (as a data attribute) and exposes `onResize` via a
// button so a test can drive the persistence round-trip. The Separator mock
// distinguishes the row handle (terminal split) from the --col handle (Status
// split) so tests can assert them independently.
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
  Separator: ({ className }: { className?: string }) => (
    <div data-testid={className?.includes("--col") ? "separator-col" : "separator"} />
  ),
}));

// Identify which terminals are mounted by session id.
vi.mock("./TerminalView", () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={`term-${sessionId}`} />,
}));

// The Status panel's live-data wiring is exercised in its own tests; here it
// must not hit the Tauri IPC, so the watch hook is a no-op.
vi.mock("../hooks/useRepoWatch", () => ({ useRepoWatch: () => {} }));

beforeEach(() => {
  useLayoutStore.setState(initialLayoutState);
});

function pressAlt(code: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code, bubbles: true }));
  });
}

describe("Layout", () => {
  it("shows the Claude and shell terminals plus the Status panel by default", () => {
    render(<Layout />);
    expect(screen.getByTestId("term-claude-main")).toBeInTheDocument();
    expect(screen.getByTestId("term-shell-main")).toBeInTheDocument();
    expect(screen.getByTestId("separator")).toBeInTheDocument();
    expect(screen.getByTestId("panel-status")).toBeInTheDocument();
    expect(screen.getByTestId("separator-col")).toBeInTheDocument();
  });

  it("Alt+1 hides then reshows the shell terminal; Claude stays mounted", () => {
    render(<Layout />);
    pressAlt("Digit1");
    expect(screen.queryByTestId("term-shell-main")).not.toBeInTheDocument();
    expect(screen.queryByTestId("separator")).not.toBeInTheDocument();
    expect(screen.getByTestId("term-claude-main")).toBeInTheDocument();
    pressAlt("Digit1");
    expect(screen.getByTestId("term-shell-main")).toBeInTheDocument();
  });

  it("Alt+2 hides then reshows the Status panel; the terminals stay mounted", () => {
    render(<Layout />);
    pressAlt("Digit2");
    expect(screen.queryByTestId("panel-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("separator-col")).not.toBeInTheDocument();
    expect(screen.getByTestId("term-claude-main")).toBeInTheDocument();
    expect(screen.getByTestId("term-shell-main")).toBeInTheDocument();
    pressAlt("Digit2");
    expect(screen.getByTestId("panel-status")).toBeInTheDocument();
  });

  it("the status-bar toggle reshows the terminal after the close button hides it", () => {
    render(<Layout />);
    fireEvent.click(screen.getByRole("button", { name: /close terminal/i }));
    expect(screen.queryByTestId("term-shell-main")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /toggle terminal/i }));
    expect(screen.getByTestId("term-shell-main")).toBeInTheDocument();
  });

  it("the Status panel close button hides it; the status-bar toggle reshows it", () => {
    render(<Layout />);
    fireEvent.click(screen.getByRole("button", { name: /close status panel/i }));
    expect(screen.queryByTestId("panel-status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /toggle status panel/i }));
    expect(screen.getByTestId("panel-status")).toBeInTheDocument();
  });

  it("remembers the dragged terminal size and restores it on reopen", () => {
    render(<Layout />);
    expect(screen.getByTestId("panel-terminal")).toHaveAttribute("data-default-size", "30%");

    // Simulate a resize drag settling at 45%.
    fireEvent.click(screen.getByTestId("resize-terminal"));
    expect(useLayoutStore.getState().bottomTerminalSize).toBe(45);

    // Hide then reshow: the terminal Panel remounts seeded with the stored size.
    pressAlt("Digit1");
    pressAlt("Digit1");
    expect(screen.getByTestId("panel-terminal")).toHaveAttribute("data-default-size", "45%");
  });

  it("remembers the dragged Status panel size and restores it on reopen", () => {
    render(<Layout />);
    expect(screen.getByTestId("panel-status")).toHaveAttribute("data-default-size", "22%");

    fireEvent.click(screen.getByTestId("resize-status"));
    expect(useLayoutStore.getState().statusPanelSize).toBe(45);

    pressAlt("Digit2");
    pressAlt("Digit2");
    expect(screen.getByTestId("panel-status")).toHaveAttribute("data-default-size", "45%");
  });
});
