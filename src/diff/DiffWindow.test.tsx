import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiffWindow } from "./DiffWindow";
import { getFileDiff, writeWorkingFile, type FileDiff } from "../lib/diffSource";
import { onRepoChanged } from "../lib/gitStatus";
import { getCurrentWindow } from "@tauri-apps/api/window";

// DiffPane is the Monaco boundary and cannot run under jsdom. The stub stands
// in for the two things the window talks to it through — the content it
// displays and the edit callback — and copies the one behaviour those tests
// depend on: the buffer lives inside the pane, and an incoming `right` replaces
// it only when it actually changed (DiffPane's setValue guard).
vi.mock("./DiffPane", () => ({
  DiffPane: ({
    left,
    right,
    rightRevision,
    rightEditable,
    onRightChange,
  }: {
    left: string;
    right: string;
    rightRevision: number;
    rightEditable: boolean;
    onRightChange: (value: string) => void;
  }) => {
    const [value, setValue] = useState(right);
    // Keyed exactly like the real pane: content plus revision, so a test can
    // catch an adopt whose content matches the frozen prop.
    useEffect(() => {
      setValue(right);
    }, [right, rightRevision]);
    return (
      <div data-testid="pane" data-left={left} data-editable={String(rightEditable)}>
        <textarea
          aria-label="modified"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onRightChange(event.target.value);
          }}
        />
      </div>
    );
  },
}));

vi.mock("../lib/diffSource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/diffSource")>()),
  getFileDiff: vi.fn(),
  writeWorkingFile: vi.fn(),
}));
vi.mock("../lib/gitStatus", () => ({ onRepoChanged: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
// Appearance is covered by its own tests; stubbed here so this window does not
// subscribe to the real settings event.
vi.mock("../hooks/useAppearance", () => ({ useAppearanceSync: vi.fn() }));

const getFileDiffMock = vi.mocked(getFileDiff);
const writeWorkingFileMock = vi.mocked(writeWorkingFile);
const onRepoChangedMock = vi.mocked(onRepoChanged);
const getCurrentWindowMock = vi.mocked(getCurrentWindow);

const close = vi.fn().mockResolvedValue(undefined);
const destroy = vi.fn().mockResolvedValue(undefined);
const onCloseRequested = vi.fn();
/** Fires the `repo://changed` handler the window subscribed with. */
let fireRepoChanged: () => void = () => {};
/** Fires the close-requested handler the window subscribed with. */
let fireCloseRequested: (event: { preventDefault: () => void }) => Promise<void>;

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/a.ts",
    origPath: null,
    headSha: "dd875b8",
    left: "one\ntwo\n",
    right: "one\ntwo changed\n",
    binary: false,
    eol: "lf",
    ...overrides,
  };
}

/** Render and wait for the initial load to settle (whatever it renders). */
async function renderReady(diff: FileDiff = fileDiff()) {
  getFileDiffMock.mockResolvedValue(diff);
  render(<DiffWindow />);
  await waitFor(() => expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument());
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.history.replaceState({}, "", "/diff.html?repo=%2Fr&path=src%2Fa.ts");
  writeWorkingFileMock.mockResolvedValue(undefined);
  onRepoChangedMock.mockImplementation((callback) => {
    fireRepoChanged = callback;
    return Promise.resolve(vi.fn());
  });
  onCloseRequested.mockImplementation((handler: typeof fireCloseRequested) => {
    fireCloseRequested = handler;
    return Promise.resolve(vi.fn());
  });
  getCurrentWindowMock.mockReturnValue({
    close,
    destroy,
    onCloseRequested,
  } as unknown as ReturnType<typeof getCurrentWindow>);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("DiffWindow", () => {
  it("loads the file named in its own url", async () => {
    await renderReady();
    expect(getFileDiffMock).toHaveBeenCalledWith({
      repoRoot: "/r",
      path: "src/a.ts",
      origPath: undefined,
    });
  });

  it("shows the head sha and path on the left, Current version on the right", async () => {
    await renderReady();
    expect(screen.getByText("dd875b8")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Current version")).toBeInTheDocument();
  });

  it("labels the left pane for a file that is not in HEAD", async () => {
    await renderReady(fileDiff({ left: null }));
    expect(screen.getByText("(new file)")).toBeInTheDocument();
  });

  it("labels an unborn HEAD instead of showing a sha", async () => {
    await renderReady(fileDiff({ headSha: null, left: null }));
    expect(screen.getByText("(no commits yet)")).toBeInTheDocument();
  });

  it("shows the rename origin as the left-hand path", async () => {
    await renderReady(fileDiff({ path: "new.ts", origPath: "old.ts" }));
    expect(screen.getByText("old.ts")).toBeInTheDocument();
  });

  it("renders a message instead of an editor for a binary file", async () => {
    await renderReady(fileDiff({ binary: true, left: null, right: null }));
    expect(screen.getByText(/binary file/i)).toBeInTheDocument();
    expect(screen.queryByTestId("pane")).not.toBeInTheDocument();
  });

  it("marks a deleted file read-only so a save cannot recreate it", async () => {
    await renderReady(fileDiff({ right: null }));
    expect(screen.getByTestId("pane")).toHaveAttribute("data-editable", "false");
    expect(screen.getByText("(deleted)")).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    getFileDiffMock.mockRejectedValue(new Error("'x' is not inside a git repository"));
    render(<DiffWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not inside a git repository/);
  });

  it("reports a window opened without a target instead of loading", async () => {
    window.history.replaceState({}, "", "/diff.html");
    render(<DiffWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/without a repository and file path/);
    expect(getFileDiffMock).not.toHaveBeenCalled();
  });

  it("auto-saves an edit once, debounced, with the file's own line ending", async () => {
    await renderReady(fileDiff({ eol: "crlf" }));

    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited once\n" } });
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited twice\n" } });
    expect(writeWorkingFileMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);
    expect(writeWorkingFileMock).toHaveBeenCalledWith(
      { repoRoot: "/r", path: "src/a.ts", origPath: undefined },
      "edited twice\n",
      "crlf",
    );
  });

  it("does not write when an edit lands back on the content on disk", async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText("modified"), {
      target: { value: "one\ntwo changed\n" },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(writeWorkingFileMock).not.toHaveBeenCalled();
  });

  it("reports a failed save and keeps the edit in the pane", async () => {
    await renderReady();
    writeWorkingFileMock.mockRejectedValue(new Error("permission denied"));

    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save: permission denied/i);
    expect(screen.getByLabelText("modified")).toHaveValue("edited\n");
  });

  it("adopts an external change to the file", async () => {
    await renderReady();
    getFileDiffMock.mockResolvedValue(fileDiff({ right: "changed by claude code\n" }));

    await act(async () => {
      fireRepoChanged();
    });

    expect(screen.getByLabelText("modified")).toHaveValue("changed by claude code\n");
  });

  it("keeps unsaved typing when its own write echoes back", async () => {
    await renderReady();
    // Type, let auto-save run, then type again so the buffer is ahead of disk.
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "saved\n" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "saved and more\n" } });

    // The watcher fires for our own write, which still reads as "saved".
    getFileDiffMock.mockResolvedValue(fileDiff({ right: "saved\n" }));
    await act(async () => {
      fireRepoChanged();
    });

    expect(screen.getByLabelText("modified")).toHaveValue("saved and more\n");
  });

  it("adopts a revert to content the pane was previously shown", async () => {
    // The nasty one: the displayed prop is frozen at "one\ntwo changed\n" while
    // the buffer moved on. An external `git checkout --` puts exactly that
    // string back on disk, so only the adopt signal (not the content) differs.
    await renderReady();
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "typed\n" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);

    getFileDiffMock.mockResolvedValue(fileDiff({ right: "one\ntwo changed\n" }));
    await act(async () => {
      fireRepoChanged();
    });

    expect(screen.getByLabelText("modified")).toHaveValue("one\ntwo changed\n");

    // And the adopted content is now the baseline: a later edit is a real write,
    // while re-typing the adopted text is not.
    fireEvent.change(screen.getByLabelText("modified"), {
      target: { value: "one\ntwo changed\n" },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);
  });

  it("serialises overlapping saves so the newest content wins", async () => {
    await renderReady();
    // Hold the first write open so the second is requested while it is in
    // flight; out-of-order completion must not leave stale content on disk.
    let releaseFirst: () => void = () => {};
    writeWorkingFileMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "first\n" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "second\n" } });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    // Still one write: the second is queued behind the first, not racing it.
    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await Promise.resolve();
    });

    expect(writeWorkingFileMock).toHaveBeenCalledTimes(2);
    expect(writeWorkingFileMock).toHaveBeenLastCalledWith(expect.anything(), "second\n", "lf");
  });

  it("still updates the HEAD side when the buffer is kept", async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "typing\n" } });

    // A new commit landed while the user was typing.
    getFileDiffMock.mockResolvedValue(fileDiff({ headSha: "9999999", left: "committed\n" }));
    await act(async () => {
      fireRepoChanged();
    });

    expect(screen.getByText("9999999")).toBeInTheDocument();
    expect(screen.getByTestId("pane")).toHaveAttribute("data-left", "committed\n");
    expect(screen.getByLabelText("modified")).toHaveValue("typing\n");
  });

  it("closes the window on Escape and on Ctrl+W", async () => {
    await renderReady();

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("leaves a key alone once something else has handled it", async () => {
    // Monaco consumes Escape to dismiss its own widgets (the find bar) and marks
    // the event handled; the window must not close out from under that.
    await renderReady();

    const handled = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", cancelable: true });
    handled.preventDefault();
    await act(async () => {
      window.dispatchEvent(handled);
    });

    expect(close).not.toHaveBeenCalled();
  });

  it("writes immediately on Ctrl+S", async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });

    await act(async () => {
      fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    });

    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending save before the window is destroyed", async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });

    const preventDefault = vi.fn();
    await act(async () => {
      await fireCloseRequested({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(writeWorkingFileMock).toHaveBeenCalledWith(expect.anything(), "edited\n", "lf");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("lets the close through untouched when nothing is pending", async () => {
    await renderReady();

    const preventDefault = vi.fn();
    await act(async () => {
      await fireCloseRequested({ preventDefault });
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("keeps the window open when the flush-on-close fails, and closes on a second try", async () => {
    await renderReady();
    writeWorkingFileMock.mockRejectedValue(new Error("disk full"));
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });

    await act(async () => {
      await fireCloseRequested({ preventDefault: vi.fn() });
    });

    expect(destroy).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/disk full/);

    // Insisting closes it: a file that cannot be written must not trap the
    // window open forever.
    await act(async () => {
      await fireCloseRequested({ preventDefault: vi.fn() });
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("flushes on close even after the debounce has already fired", async () => {
    // The guard is "is anything unsaved", not "is a timer pending": a save that
    // fired and failed leaves no timer but still holds an unwritten edit.
    await renderReady();
    writeWorkingFileMock.mockRejectedValueOnce(new Error("transient"));
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    await act(async () => {
      await fireCloseRequested({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(writeWorkingFileMock).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending save when the window loses focus", async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);
  });
});
