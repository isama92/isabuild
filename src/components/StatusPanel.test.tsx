import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { StatusPanel } from "./StatusPanel";
import { initialGitState, useGitStore } from "../store/gitStore";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";
import { openDiffWindow } from "../lib/diffWindow";
import { openMergeWindow } from "../lib/mergeWindow";
import type { ConflictKind } from "../lib/gitStatus";
import { mergeState } from "../test/factories";

vi.mock("../lib/diffWindow", () => ({ openDiffWindow: vi.fn() }));
vi.mock("../lib/mergeWindow", () => ({ openMergeWindow: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const openDiffWindowMock = vi.mocked(openDiffWindow);
const openMergeWindowMock = vi.mocked(openMergeWindow);
const invokeMock = vi.mocked(invoke);

const CLEAN_STATUS = { repoRoot: "/repo", staged: [], unstaged: [], conflicts: [] };

/** A promise the test resolves by hand, so it can assert mid-read. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Start a real `refresh()` whose `git_status` will not answer until released.
 *
 * Driving the action rather than presetting `phase` is the whole point: the
 * Part 9 bug lived in the window between the call and its answer, so a test that
 * sets the end state can never see it.
 */
function gatedRefresh() {
  const gate = deferred<typeof CLEAN_STATUS>();
  invokeMock.mockReturnValueOnce(gate.promise);
  let pending!: Promise<void>;
  act(() => {
    pending = useGitStore.getState().refresh();
  });
  return {
    async release(status = CLEAN_STATUS) {
      gate.resolve(status);
      await act(async () => {
        await pending;
      });
    },
  };
}

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

describe("StatusPanel across a refresh (Part 9)", () => {
  it("keeps 'No changes' on screen while a refresh is in flight", async () => {
    // The bug: refresh() opened with set({ phase: "loading" }) and the empty
    // state was gated on phase === "ready", so a clean repo rendered an empty
    // body for the whole of every read — several times a second in dev, because
    // the watcher covered target/ and node_modules/. A dirty repo never showed
    // it: its rows are not gated on the phase (see the test below).
    useGitStore.setState({ ...initialGitState, phase: "ready", repoRoot: "/repo" });
    render(<StatusPanel />);
    expect(screen.getByText("No changes")).toBeInTheDocument();

    const read = gatedRefresh();
    // The assertion the old implementation failed, on the very next line: it set
    // the phase before its first await, so act() had already flushed the blank.
    expect(screen.getByText("No changes")).toBeInTheDocument();

    await read.release();
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("never shows the loading placeholder for a refresh that already has data", async () => {
    // The constraint that stops the fix reintroducing the bug in a new costume:
    // "Loading changes…" is for "nothing read yet", never for "reading now", or a
    // clean repo would alternate between the two messages instead of blanking.
    useGitStore.setState({ ...initialGitState, phase: "ready", repoRoot: "/repo" });
    render(<StatusPanel />);

    const read = gatedRefresh();
    expect(screen.queryByText(/loading changes/i)).not.toBeInTheDocument();

    await read.release();
    expect(screen.queryByText(/loading changes/i)).not.toBeInTheDocument();
  });

  it("keeps the file rows on screen while a refresh is in flight", () => {
    // The behaviour a dirty repo always had, now asserted rather than incidental.
    useGitStore.setState({
      ...initialGitState,
      phase: "ready",
      repoRoot: "/repo",
      unstaged: [{ path: "src/b.ts", status: "modified" }],
    });
    render(<StatusPanel />);

    gatedRefresh();

    expect(screen.getByText("b.ts")).toBeInTheDocument();
  });

  it("says it is loading before the first read has landed", () => {
    // Nothing read yet, which is also every project switch. Previously a blank
    // panel body with no explanation.
    render(<StatusPanel />);
    expect(screen.getByText("Loading changes…")).toBeInTheDocument();
    expect(screen.queryByText(/no changes/i)).not.toBeInTheDocument();
  });

  it("goes back to loading when a project switch resets the store", () => {
    useGitStore.setState({ ...initialGitState, phase: "ready", repoRoot: "/repo" });
    render(<StatusPanel />);
    expect(screen.getByText("No changes")).toBeInTheDocument();

    // What projectStore.resetForProjectSwitch does to this store.
    act(() => {
      useGitStore.setState(initialGitState);
    });

    expect(screen.getByText("Loading changes…")).toBeInTheDocument();
    expect(screen.queryByText(/no changes/i)).not.toBeInTheDocument();
  });

  it("keeps the error on screen while a retry is in flight, then shows the result", async () => {
    // Same rule as the empty state, and the reason the error arm is checked
    // first: swapping an actionable message for a meaningless placeholder at
    // 3 Hz would be the identical bug on a broken repo.
    useGitStore.setState({
      ...initialGitState,
      phase: "error",
      error: "'/x' is not inside a git repository",
    });
    render(<StatusPanel />);

    const read = gatedRefresh();
    expect(screen.getByText(/not inside a git repository/i)).toBeInTheDocument();
    expect(screen.queryByText(/loading changes/i)).not.toBeInTheDocument();

    await read.release();
    expect(screen.queryByText(/not inside a git repository/i)).not.toBeInTheDocument();
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });
});

describe("StatusPanel conflicts (Part 6)", () => {
  function withConflicts(kind: ConflictKind, path = "src/app.ts") {
    useGitStore.setState({
      phase: "ready",
      repoRoot: "/repo",
      conflicts: [{ path, kind }],
      mergeState: mergeState("merge", { mergingRef: "feature" }),
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
