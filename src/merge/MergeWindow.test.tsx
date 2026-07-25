import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MergeWindow } from "./MergeWindow";
import { getConflictFile, resolveConflict, resolvePath } from "../lib/gitMerge";
import { onRepoChanged } from "../lib/gitStatus";
import type { ConflictFile } from "../lib/gitMerge";

vi.mock("../lib/gitMerge", async (importOriginal) => {
  // parseMergeParams is pure and under test elsewhere; only the IPC is faked.
  const actual = await importOriginal<typeof import("../lib/gitMerge")>();
  return {
    ...actual,
    getConflictFile: vi.fn(),
    resolveConflict: vi.fn(),
    resolvePath: vi.fn(),
  };
});
vi.mock("../lib/gitStatus", () => ({ onRepoChanged: vi.fn() }));

const closeMock = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: closeMock }),
}));

const getConflictFileMock = vi.mocked(getConflictFile);
const resolveConflictMock = vi.mocked(resolveConflict);
const resolvePathMock = vi.mocked(resolvePath);
const onRepoChangedMock = vi.mocked(onRepoChanged);

/** A file with one conflict between two context lines. */
function conflictFile(overrides: Partial<ConflictFile> = {}): ConflictFile {
  return {
    path: "src/app.ts",
    lines: [
      "context above",
      "<<<<<<< HEAD",
      "ours line",
      "=======",
      "theirs line",
      ">>>>>>> feature",
      "context below",
      "",
    ],
    blocks: [
      {
        start: 1,
        end: 6,
        ours: { start: 2, end: 3 },
        base: null,
        theirs: { start: 4, end: 5 },
        oursLabel: "HEAD",
        theirsLabel: "feature",
        complete: true,
      },
    ],
    revision: "rev-1",
    binary: false,
    ...overrides,
  };
}

function setSearch(search: string) {
  // The window reads its target from its own URL, once, on mount.
  window.history.replaceState({}, "", `/merge.html${search}`);
}

beforeEach(() => {
  setSearch("?repo=%2Frepo&path=src%2Fapp.ts");
  getConflictFileMock.mockResolvedValue(conflictFile());
  resolveConflictMock.mockResolvedValue({ remaining: 0, staged: true });
  resolvePathMock.mockResolvedValue(undefined);
  onRepoChangedMock.mockResolvedValue(vi.fn());
  closeMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MergeWindow", () => {
  it("reads the file named in its own query string", async () => {
    render(<MergeWindow />);
    await waitFor(() => expect(getConflictFileMock).toHaveBeenCalledWith("/repo", "src/app.ts"));
  });

  it("renders the conflict with both sides and the file's own line numbers", async () => {
    render(<MergeWindow />);

    expect(await screen.findByText("ours line")).toBeInTheDocument();
    expect(screen.getByText("theirs line")).toBeInTheDocument();
    expect(screen.getByText("context above")).toBeInTheDocument();
    expect(screen.getByText("context below")).toBeInTheDocument();
    // git's labels, shown verbatim, with which side they are spelled out.
    expect(screen.getByText("HEAD (ours)")).toBeInTheDocument();
    expect(screen.getByText("feature (theirs)")).toBeInTheDocument();
    // "ours line" is index 2, so it displays as line 3.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("counts the conflicts in the header", async () => {
    render(<MergeWindow />);
    expect(await screen.findByText("1 conflict")).toBeInTheDocument();
  });

  it("sends the choice with the revision it was made against", async () => {
    render(<MergeWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept ours" }));

    await waitFor(() =>
      expect(resolveConflictMock).toHaveBeenCalledWith("/repo", "src/app.ts", 0, "ours", "rev-1"),
    );
  });

  it("offers ours, theirs and both", async () => {
    render(<MergeWindow />);
    expect(await screen.findByRole("button", { name: "Accept ours" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept theirs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept both" })).toBeInTheDocument();
  });

  it("says so when the last conflict was resolved and the file staged", async () => {
    render(<MergeWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept theirs" }));
    expect(await screen.findByText(/resolved, and the file is staged/i)).toBeInTheDocument();
  });

  it("reports how many conflicts are left when others remain", async () => {
    resolveConflictMock.mockResolvedValue({ remaining: 2, staged: false });
    render(<MergeWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept ours" }));
    expect(await screen.findByText(/2 conflicts left in this file/i)).toBeInTheDocument();
  });

  it("shows the stale-revision refusal and reloads", async () => {
    // The guard that stops a resolution landing on the wrong hunk. The window's
    // answer is to say so and re-read what is actually on disk.
    resolveConflictMock.mockRejectedValue(
      new Error("'src/app.ts' changed on disk since it was read; reload it and try again"),
    );
    render(<MergeWindow />);
    await screen.findByText("ours line");
    getConflictFileMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Accept ours" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on disk/i);
    await waitFor(() => expect(getConflictFileMock).toHaveBeenCalled());
  });

  it("re-reads the file when the repo changes underneath it", async () => {
    let fire: (() => void) | undefined;
    onRepoChangedMock.mockImplementation((callback: () => void) => {
      fire = callback;
      return Promise.resolve(vi.fn());
    });
    render(<MergeWindow />);
    await screen.findByText("ours line");
    getConflictFileMock.mockClear();

    fire?.();

    await waitFor(() => expect(getConflictFileMock).toHaveBeenCalled());
  });

  it("renders the diff3 base section and says Accept both drops it", async () => {
    getConflictFileMock.mockResolvedValue(
      conflictFile({
        lines: [
          "<<<<<<< HEAD",
          "ours line",
          "||||||| merged common ancestors",
          "base line",
          "=======",
          "theirs line",
          ">>>>>>> feature",
          "",
        ],
        blocks: [
          {
            start: 0,
            end: 7,
            ours: { start: 1, end: 2 },
            base: { start: 3, end: 4 },
            theirs: { start: 5, end: 6 },
            oursLabel: "HEAD",
            theirsLabel: "feature",
            complete: true,
          },
        ],
      }),
    );
    render(<MergeWindow />);

    expect(await screen.findByText("base line")).toBeInTheDocument();
    expect(screen.getByText(/dropped by Accept both/i)).toBeInTheDocument();
  });

  it("shows an empty side as a real choice rather than an absent block", async () => {
    getConflictFileMock.mockResolvedValue(
      conflictFile({
        lines: ["<<<<<<< HEAD", "=======", "theirs line", ">>>>>>> feature", ""],
        blocks: [
          {
            start: 0,
            end: 4,
            ours: { start: 1, end: 1 },
            base: null,
            theirs: { start: 2, end: 3 },
            oursLabel: "HEAD",
            theirsLabel: "feature",
            complete: true,
          },
        ],
      }),
    );
    render(<MergeWindow />);
    expect(await screen.findByText(/nothing on this side/i)).toBeInTheDocument();
  });

  it("offers whole-file sides for a binary conflict and no hunks", async () => {
    getConflictFileMock.mockResolvedValue(
      conflictFile({ lines: [], blocks: [], binary: true }),
    );
    render(<MergeWindow />);

    expect(await screen.findByText(/this file is binary/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep theirs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept ours" })).not.toBeInTheDocument();
  });

  it("resolves a binary conflict as a whole path", async () => {
    getConflictFileMock.mockResolvedValue(conflictFile({ lines: [], blocks: [], binary: true }));
    render(<MergeWindow />);

    fireEvent.click(await screen.findByRole("button", { name: "Keep theirs" }));

    await waitFor(() =>
      expect(resolvePathMock).toHaveBeenCalledWith("/repo", "src/app.ts", "keepTheirs"),
    );
  });

  it("stays open and says the markers are gone when nothing is left", async () => {
    // Never self-closing: a window vanishing on its own reads as a crash, and
    // after an abort this is how the user finds out the markers went away.
    getConflictFileMock.mockResolvedValue(conflictFile({ lines: ["a", ""], blocks: [] }));
    render(<MergeWindow />);

    expect(await screen.findByText(/no conflict markers left/i)).toBeInTheDocument();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("offers Mark resolved for a file whose markers were removed by hand", async () => {
    // The dead end this closes: git reports a path as unmerged until something
    // stages it, so a conflict fixed in the diff window or the terminal would
    // otherwise sit in the Conflicts group forever with Continue disabled.
    getConflictFileMock.mockResolvedValue(
      conflictFile({ lines: ["resolved by hand", ""], blocks: [] }),
    );
    render(<MergeWindow />);

    fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));

    await waitFor(() =>
      expect(resolvePathMock).toHaveBeenCalledWith("/repo", "src/app.ts", "markResolved"),
    );
  });

  it("withholds the accept buttons on a half-edited conflict", async () => {
    getConflictFileMock.mockResolvedValue(
      conflictFile({
        lines: ["top", "<<<<<<< HEAD", "ours", ">>>>>>> feature", "bottom", ""],
        blocks: [
          {
            start: 1,
            end: 4,
            ours: { start: 2, end: 3 },
            base: null,
            theirs: { start: 3, end: 3 },
            oursLabel: "HEAD",
            theirsLabel: "",
            complete: false,
          },
        ],
      }),
    );
    render(<MergeWindow />);

    expect(await screen.findByText(/fix it by hand/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept ours" })).not.toBeInTheDocument();
  });

  it("reports a read failure instead of an empty pane", async () => {
    getConflictFileMock.mockRejectedValue(new Error("'src/app.ts' is no longer in the working tree"));
    render(<MergeWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer in the working tree/i);
  });

  it("explains itself when opened without a target, and asks git for nothing", async () => {
    setSearch("");
    render(<MergeWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /without a repository and file path/i,
    );
    expect(getConflictFileMock).not.toHaveBeenCalled();
  });

  it("closes on Escape and on Ctrl+W", async () => {
    render(<MergeWindow />);
    await screen.findByText("ours line");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeMock).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(closeMock).toHaveBeenCalledTimes(2);
  });

  it("leaves a key another handler already dealt with alone", async () => {
    render(<MergeWindow />);
    await screen.findByText("ours line");
    fireEvent(
      window,
      Object.assign(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }), {}),
    );
    closeMock.mockClear();

    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    fireEvent(window, handled);

    expect(closeMock).not.toHaveBeenCalled();
  });
});
