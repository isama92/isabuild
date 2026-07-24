import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalPanel } from "./TerminalPanel";
import { writeText } from "../lib/ptySession";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

const hoisted = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock("./TerminalView", () => ({
  TerminalView: (props: Record<string, unknown>) => {
    hoisted.props.push(props);
    return <div data-testid={`term-${String(props.sessionId)}`} />;
  },
}));

vi.mock("../lib/ptySession", () => ({ writeText: vi.fn() }));
const writeTextMock = vi.mocked(writeText);

/** Drive the "the PTY is attached and wired" moment. */
function fireReady() {
  const onReady = hoisted.props.at(-1)?.onReady as (() => void) | undefined;
  if (!onReady) throw new Error("TerminalView was given no onReady");
  act(() => onReady());
}

beforeEach(() => {
  hoisted.props.length = 0;
  useLayoutStore.setState(initialLayoutState);
  writeTextMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
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

  it("closes the region when the shell exits", () => {
    render(<TerminalPanel />);
    const onExit = hoisted.props.at(-1)!.onExit as (info: { exitCode: number }) => void;
    expect(typeof onExit).toBe("function");
    act(() => onExit({ exitCode: 0 }));
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });
});

// "Retry in terminal" (Part 5). The command is queued in the store because the
// region may be closed — and this component unmounted — when the user asks, so it
// is consumed on onReady rather than written directly.
describe("TerminalPanel pending shell command", () => {
  it("writes a queued command once the session is attached", async () => {
    useLayoutStore.getState().requestShellCommand("git push origin main");
    render(<TerminalPanel />);

    fireReady();

    await waitFor(() =>
      // No trailing newline: the user reviews it and presses Enter themselves.
      expect(writeTextMock).toHaveBeenCalledWith("shell-main", "git push origin main"),
    );
    expect(useLayoutStore.getState().pendingShellCommand).toBeNull();
  });

  it("writes nothing when no command is queued", () => {
    render(<TerminalPanel />);
    fireReady();
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it("consumes the request even when the write fails", async () => {
    // Otherwise a stale command would surprise the user on some later reopen.
    writeTextMock.mockRejectedValue(new Error("no such session"));
    useLayoutStore.getState().requestShellCommand("git fetch origin");
    render(<TerminalPanel />);

    fireReady();

    await waitFor(() => expect(writeTextMock).toHaveBeenCalled());
    expect(useLayoutStore.getState().pendingShellCommand).toBeNull();
  });

  it("writes a command queued while the session was ALREADY attached", async () => {
    // The regression this test exists for. When the region is already open,
    // nothing re-attaches, so `onReady` never fires again — relying on it alone
    // meant Retry in terminal silently did nothing and the command sat in the
    // store until some later reopen fired it unexpectedly.
    render(<TerminalPanel />);
    fireReady();
    expect(writeTextMock).not.toHaveBeenCalled();

    act(() => useLayoutStore.getState().requestShellCommand("git push origin main"));

    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith("shell-main", "git push origin main"),
    );
    expect(useLayoutStore.getState().pendingShellCommand).toBeNull();
  });

  it("waits for the session before writing a command queued too early", async () => {
    // Mounted but not yet attached: writing now would just fail.
    render(<TerminalPanel />);
    act(() => useLayoutStore.getState().requestShellCommand("git fetch origin"));
    expect(writeTextMock).not.toHaveBeenCalled();

    fireReady();
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith("shell-main", "git fetch origin"));
  });

  it("does not replay the command when the session re-attaches", async () => {
    useLayoutStore.getState().requestShellCommand("git pull");
    render(<TerminalPanel />);

    fireReady();
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1));

    // A remount (dev HMR, or reopening the region) fires onReady again.
    fireReady();
    expect(writeTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("layoutStore.requestShellCommand", () => {
  it("reveals and focuses the terminal along with queueing the command", () => {
    useLayoutStore.setState({ bottomTerminalVisible: false, bottomTerminalAutoFocus: false });
    useLayoutStore.getState().requestShellCommand("git fetch origin");

    const state = useLayoutStore.getState();
    expect(state.pendingShellCommand).toBe("git fetch origin");
    expect(state.bottomTerminalVisible).toBe(true);
    // An explicit request to run something there: focus is the point.
    expect(state.bottomTerminalAutoFocus).toBe(true);
  });

  it("clears the queued command", () => {
    useLayoutStore.getState().requestShellCommand("git fetch origin");
    useLayoutStore.getState().clearPendingShellCommand();
    expect(useLayoutStore.getState().pendingShellCommand).toBeNull();
  });
});
