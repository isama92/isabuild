import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalView } from "./TerminalView";
import type { AttachOptions } from "../lib/ptySession";

const hoisted = vi.hoisted(() => ({
  attachMock: vi.fn(),
  restartMock: vi.fn(),
  detachMock: vi.fn(),
  lastOpts: null as AttachOptions | null,
}));

vi.mock("../lib/ptySession", () => ({
  attach: hoisted.attachMock,
  restart: hoisted.restartMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.lastOpts = null;
  hoisted.attachMock.mockImplementation((_container: HTMLElement, opts: AttachOptions) => {
    hoisted.lastOpts = opts;
    return { detach: hoisted.detachMock };
  });
  hoisted.restartMock.mockResolvedValue(undefined);
});

function renderView() {
  return render(<TerminalView sessionId="claude-main" cmd="claude" />);
}

describe("TerminalView", () => {
  it("attaches on mount and shows no overlay", () => {
    renderView();
    expect(hoisted.attachMock).toHaveBeenCalledTimes(1);
    expect(hoisted.attachMock.mock.calls[0][1]).toMatchObject({
      id: "claude-main",
      cmd: "claude",
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("detaches on unmount", () => {
    const { unmount } = renderView();
    unmount();
    expect(hoisted.detachMock).toHaveBeenCalledTimes(1);
  });

  it("shows install guidance when the command is not found (exit 127)", () => {
    renderView();
    act(() => hoisted.lastOpts!.onExit!({ exitCode: 127 }));

    // The dialog's accessible name must match the visible heading.
    expect(
      screen.getByRole("alertdialog", { name: /was not found on your PATH/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/was not found on your PATH/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /installation guide/i })).toHaveAttribute(
      "href",
      "https://code.claude.com/docs/en/quickstart#step-1-install-claude-code",
    );
  });

  it("shows the exit code for a non-zero exit", () => {
    renderView();
    act(() => hoisted.lastOpts!.onExit!({ exitCode: 1 }));
    expect(screen.getByText("Claude Code exited (code 1)")).toBeInTheDocument();
  });

  it("shows a neutral message for a clean exit", () => {
    renderView();
    act(() => hoisted.lastOpts!.onExit!({ exitCode: 0 }));
    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  it("moves focus to the restart button when the overlay appears", () => {
    renderView();
    act(() => hoisted.lastOpts!.onExit!({ exitCode: 1 }));
    expect(screen.getByRole("button", { name: /restart claude code/i })).toHaveFocus();
  });

  it("shows spawn errors reported through onError", () => {
    renderView();
    act(() => hoisted.lastOpts!.onError!(new Error("boom")));
    expect(screen.getByText("Failed to start session")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("restart button respawns and clears the overlay", async () => {
    renderView();
    act(() => hoisted.lastOpts!.onExit!({ exitCode: 0 }));

    fireEvent.click(screen.getByRole("button", { name: /restart claude code/i }));

    await waitFor(() =>
      expect(hoisted.restartMock).toHaveBeenCalledWith("claude-main", "claude"),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows an error overlay when restart fails", async () => {
    hoisted.restartMock.mockRejectedValue(new Error("spawn failed"));
    renderView();
    act(() => hoisted.lastOpts!.onExit!({ exitCode: 1 }));

    fireEvent.click(screen.getByRole("button", { name: /restart claude code/i }));

    expect(await screen.findByText("Failed to start session")).toBeInTheDocument();
    expect(screen.getByText("spawn failed")).toBeInTheDocument();
  });
});
