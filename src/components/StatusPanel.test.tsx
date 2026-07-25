import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusPanel } from "./StatusPanel";
import { initialGitState, useGitStore } from "../store/gitStore";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";
import { openDiffWindow } from "../lib/diffWindow";
import { openMergeWindow } from "../lib/mergeWindow";
import type { ConflictKind } from "../lib/gitStatus";

vi.mock("../lib/diffWindow", () => ({ openDiffWindow: vi.fn() }));
vi.mock("../lib/mergeWindow", () => ({ openMergeWindow: vi.fn() }));

const openDiffWindowMock = vi.mocked(openDiffWindow);
const openMergeWindowMock = vi.mocked(openMergeWindow);

beforeEach(() => {
  useGitStore.setState(initialGitState);
  useLayoutStore.setState(initialLayoutState);
  openDiffWindowMock.mockResolvedValue(undefined);
  openMergeWindowMock.mockResolvedValue(undefined);
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

describe("StatusPanel conflicts (Part 6)", () => {
  function withConflicts(kind: ConflictKind, path = "src/app.ts") {
    useGitStore.setState({
      phase: "ready",
      repoRoot: "/repo",
      conflicts: [{ path, kind }],
      mergeState: { kind: "merge", mergingRef: "feature" },
    });
    render(<StatusPanel />);
  }

  it("lists conflicts in their own group", () => {
    withConflicts("bothModified");
    expect(screen.getByText("Conflicts")).toBeInTheDocument();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
  });

  it("does not report a repo with only conflicts as having no changes", () => {
    // The conflicts group is not staged or unstaged, so the empty check has to
    // count it — otherwise a conflicted repo renders "No changes".
    withConflicts("bothModified");
    expect(screen.queryByText(/no changes/i)).not.toBeInTheDocument();
  });

  it("opens the merge window for a conflict with markers", () => {
    withConflicts("bothModified");
    fireEvent.click(screen.getByText("app.ts"));
    expect(openMergeWindowMock).toHaveBeenCalledWith({ repoRoot: "/repo", path: "src/app.ts" });
    // Never the diff window: that shows HEAD against the working tree, which is
    // not what resolving a conflict needs.
    expect(openDiffWindowMock).not.toHaveBeenCalled();
  });

  it("surfaces a failure to open the merge window", async () => {
    openMergeWindowMock.mockRejectedValue(new Error("could not open the merge window: denied"));
    withConflicts("bothModified");

    fireEvent.click(screen.getByText("app.ts"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/could not open the merge window/i),
    );
  });

  it("offers no window and no clickable row for a conflict with no markers", () => {
    // A file the other side deleted has no text to show, so a row that looked
    // clickable would lead nowhere.
    withConflicts("deletedByThem", "gone.ts");
    expect(screen.queryByRole("button", { name: /gone\.ts/ })).not.toBeInTheDocument();
    expect(screen.getByText("gone.ts")).toBeInTheDocument();
  });

  it("offers the whole-file resolutions inline for those kinds", () => {
    withConflicts("deletedByThem", "gone.ts");
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete it" })).toBeInTheDocument();
    // The side that does not exist is not offered.
    expect(screen.queryByRole("button", { name: "Keep theirs" })).not.toBeInTheDocument();
    expect(screen.getByText("they deleted it, you changed it")).toBeInTheDocument();
  });

  it("resolves a whole path through the store", () => {
    const resolveConflictPath = vi.fn().mockResolvedValue(true);
    useGitStore.setState({ resolveConflictPath });
    withConflicts("deletedByThem", "gone.ts");

    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));

    expect(resolveConflictPath).toHaveBeenCalledWith("gone.ts", "acceptDeletion");
  });

  it("shows no inline actions for a marker conflict", () => {
    withConflicts("bothModified");
    expect(screen.queryByRole("button", { name: "Keep mine" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep theirs" })).not.toBeInTheDocument();
  });

  it("renders the merge banner above the file groups", () => {
    withConflicts("bothModified");
    useGitStore.setState({ branch: null });
    expect(screen.getByLabelText("Merge in progress")).toBeInTheDocument();
  });
});
