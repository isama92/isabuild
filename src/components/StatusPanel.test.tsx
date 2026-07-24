import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusPanel } from "./StatusPanel";
import { initialGitState, useGitStore } from "../store/gitStore";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";
import { openDiffWindow } from "../lib/diffWindow";

vi.mock("../lib/diffWindow", () => ({ openDiffWindow: vi.fn() }));

const openDiffWindowMock = vi.mocked(openDiffWindow);

beforeEach(() => {
  useGitStore.setState(initialGitState);
  useLayoutStore.setState(initialLayoutState);
  openDiffWindowMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("StatusPanel", () => {
  it("renders staged and unstaged groups with their files", () => {
    useGitStore.setState({
      phase: "ready",
      staged: [{ path: "src/a.ts", status: "added" }],
      unstaged: [
        { path: "src/b.ts", status: "modified" },
        { path: "note.txt", status: "untracked" },
      ],
    });
    render(<StatusPanel />);

    expect(screen.getByText("Staged Changes")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("note.txt")).toBeInTheDocument();
  });

  it("shows 'No changes' when the repo is clean", () => {
    useGitStore.setState({ phase: "ready", staged: [], unstaged: [] });
    render(<StatusPanel />);
    expect(screen.getByText(/no changes/i)).toBeInTheDocument();
  });

  it("shows the error message when status could not be read", () => {
    useGitStore.setState({
      phase: "error",
      error: "'/x' is not inside a git repository",
    });
    render(<StatusPanel />);
    expect(screen.getByText(/not inside a git repository/i)).toBeInTheDocument();
  });

  it("does not render the Staged group when nothing is staged", () => {
    useGitStore.setState({
      phase: "ready",
      staged: [],
      unstaged: [{ path: "b.ts", status: "modified" }],
    });
    render(<StatusPanel />);
    expect(screen.queryByText("Staged Changes")).not.toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
  });

  it("shows the rename origin in the row tooltip", () => {
    useGitStore.setState({
      phase: "ready",
      staged: [{ path: "new.ts", origPath: "old.ts", status: "renamed" }],
      unstaged: [],
    });
    render(<StatusPanel />);
    expect(screen.getByText("new.ts").closest("li")).toHaveAttribute("title", "old.ts → new.ts");
  });

  it("opens the diff window for the clicked file", () => {
    useGitStore.setState({
      phase: "ready",
      repoRoot: "/repo",
      unstaged: [{ path: "src/b.ts", status: "modified" }],
    });
    render(<StatusPanel />);

    fireEvent.click(screen.getByText("b.ts"));

    expect(openDiffWindowMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      path: "src/b.ts",
      origPath: undefined,
    });
  });

  it("passes the rename origin so the HEAD side is read from it", () => {
    useGitStore.setState({
      phase: "ready",
      repoRoot: "/repo",
      staged: [{ path: "new.ts", origPath: "old.ts", status: "renamed" }],
    });
    render(<StatusPanel />);

    fireEvent.click(screen.getByText("new.ts"));

    expect(openDiffWindowMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      path: "new.ts",
      origPath: "old.ts",
    });
  });

  it("opens untracked and deleted files too", () => {
    useGitStore.setState({
      phase: "ready",
      repoRoot: "/repo",
      unstaged: [
        { path: "note.txt", status: "untracked" },
        { path: "gone.ts", status: "deleted" },
      ],
    });
    render(<StatusPanel />);

    fireEvent.click(screen.getByText("note.txt"));
    fireEvent.click(screen.getByText("gone.ts"));

    expect(openDiffWindowMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failure to open the window", async () => {
    useGitStore.setState({
      phase: "ready",
      repoRoot: "/repo",
      unstaged: [{ path: "src/b.ts", status: "modified" }],
    });
    openDiffWindowMock.mockRejectedValue(new Error("could not open the diff window: denied"));
    render(<StatusPanel />);

    fireEvent.click(screen.getByText("b.ts"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/could not open the diff window/i),
    );
  });

  it("hides the panel when the close button is clicked", () => {
    render(<StatusPanel />);
    fireEvent.click(screen.getByRole("button", { name: /close status panel/i }));
    expect(useLayoutStore.getState().statusPanelVisible).toBe(false);
  });
});
