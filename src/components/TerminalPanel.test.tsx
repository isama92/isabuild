import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { TerminalPanel } from "./TerminalPanel";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

const hoisted = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock("./TerminalView", () => ({
  TerminalView: (props: Record<string, unknown>) => {
    hoisted.props.push(props);
    return <div data-testid={`term-${String(props.sessionId)}`} />;
  },
}));

beforeEach(() => {
  hoisted.props.length = 0;
  useLayoutStore.setState(initialLayoutState);
});

describe("TerminalPanel", () => {
  it("renders the shell terminal: no cmd, no install hint", () => {
    render(<TerminalPanel />);
    const props = hoisted.props.at(-1)!;
    expect(props.sessionId).toBe("shell-main");
    expect(props.label).toBe("Terminal");
    expect(props.cmd).toBeUndefined();
    expect(props.installHintUrl).toBeUndefined();
  });

  it("does not autofocus on the startup mount, but does once the user has opened it", () => {
    const { rerender } = render(<TerminalPanel />);
    expect(hoisted.props.at(-1)!.autoFocus).toBe(false);

    act(() => useLayoutStore.setState({ bottomTerminalAutoFocus: true }));
    rerender(<TerminalPanel />);
    expect(hoisted.props.at(-1)!.autoFocus).toBe(true);
  });

  it("hides the terminal when the close button is clicked", () => {
    render(<TerminalPanel />);
    fireEvent.click(screen.getByRole("button", { name: /close terminal/i }));
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });
});
