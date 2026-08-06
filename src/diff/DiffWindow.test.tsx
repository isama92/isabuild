import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiffWindow } from "./DiffWindow";
import { getFileDiff, writeWorkingFile, type DiffParams, type FileDiff } from "../lib/diffSource";
import { onRepoChanged, getStatus } from "../lib/gitStatus";
import { onShowFile, registerDiffWindow } from "../lib/diffRegistry";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DiffHeaderLayout } from "./diffView";

// DiffPane is the CodeMirror boundary. It is stubbed here — not because it cannot
// run under jsdom (it can, and DiffPane.test drives the real thing), but because
// this file is about the window's auto-save and refresh logic, and a real MergeView
// would make every test in it depend on a diff algorithm's output.
//
// The stub stands in for the two things the window talks to it through — the
// content it displays and the edit callback — and copies the one behaviour these
// tests depend on: the buffer lives inside the pane, and an incoming `right`
// replaces it only when it actually changed (the real pane's equality guard).
/**
 * What the pane reports as the header's shape, for the test that changes it.
 *
 * A module-level box rather than a prop, because the mock is hoisted above every
 * `let` a test could otherwise assign. Reset in `beforeEach`.
 */
const paneLayout: { current: DiffHeaderLayout } = { current: { mode: "split", splitAt: 240 } };

/**
 * How many times the pane has been constructed.
 *
 * The window remounts it per file rather than re-feeding it, and that is not
 * cosmetic: a pane kept across a navigation keeps its undo history, so Ctrl+Z in
 * the new file would undo into the previous file's text and auto-save it.
 */
const paneMounts = { count: 0 };

vi.mock("./DiffPane", () => ({
  DiffPane: ({
    left,
    right,
    rightRevision,
    rightEditable,
    onRightChange,
    onLayout,
  }: {
    left: string;
    right: string;
    rightRevision: number;
    rightEditable: boolean;
    onRightChange: (value: string) => void;
    onLayout: (layout: DiffHeaderLayout) => void;
  }) => {
    const [value, setValue] = useState(right);
    // Keyed exactly like the real pane: content plus revision, so a test can
    // catch an adopt whose content matches the frozen prop.
    useEffect(() => {
      setValue(right);
    }, [right, rightRevision]);
    // The real panes report this from a layout effect, each describing its own
    // shape; the window has no other way to know how to divide the header.
    useEffect(() => {
      onLayout(paneLayout.current);
    }, [onLayout]);
    useEffect(() => {
      paneMounts.count += 1;
    }, []);
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
vi.mock("../lib/gitStatus", () => ({ onRepoChanged: vi.fn(), getStatus: vi.fn() }));
vi.mock("../lib/diffRegistry", () => ({
  registerDiffWindow: vi.fn(),
  onShowFile: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
// Appearance is covered by its own tests; stubbed here so this window does not
// subscribe to the real settings event.
vi.mock("../hooks/useAppearance", () => ({ useAppearanceSync: vi.fn() }));

const getFileDiffMock = vi.mocked(getFileDiff);
const writeWorkingFileMock = vi.mocked(writeWorkingFile);
const onRepoChangedMock = vi.mocked(onRepoChanged);
const getStatusMock = vi.mocked(getStatus);
const registerDiffWindowMock = vi.mocked(registerDiffWindow);
const onShowFileMock = vi.mocked(onShowFile);
const getCurrentWindowMock = vi.mocked(getCurrentWindow);

const close = vi.fn().mockResolvedValue(undefined);
const destroy = vi.fn().mockResolvedValue(undefined);
const setTitle = vi.fn().mockResolvedValue(undefined);
const onCloseRequested = vi.fn();
/** Fires the `diff://show` handler the window subscribed with. */
let fireShowFile: (target: DiffParams) => void = () => {};
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
  const view = render(<DiffWindow />);
  await waitFor(() => expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument());
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  paneLayout.current = { mode: "split", splitAt: 240 };
  paneMounts.count = 0;
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
    setTitle,
    onCloseRequested,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  registerDiffWindowMock.mockResolvedValue(undefined);
  onShowFileMock.mockImplementation((callback) => {
    fireShowFile = callback;
    return Promise.resolve(vi.fn());
  });
  // A repo with three changed files, the window's own in the middle, so both
  // directions are available unless a test says otherwise.
  getStatusMock.mockResolvedValue({
    repoRoot: "/r",
    staged: [],
    unstaged: [
      { path: "src/before.ts", status: "modified" },
      { path: "src/a.ts", status: "modified" },
      { path: "src/after.ts", status: "modified" },
    ],
    conflicts: [],
  });
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

  it("sizes the left header from the divider the pane reports", async () => {
    const { container } = await renderReady();
    expect(container.querySelector<HTMLElement>(".diff-header-side")?.style.flex).toBe(
      "0 0 240px",
    );
  });

  it("shows one header when the pane says there is no divider", async () => {
    // The one-pane view has a single document, so the two halves that track a
    // divider would be describing a divider that is not there.
    paneLayout.current = { mode: "unified" };
    const { container } = await renderReady();

    expect(container.querySelectorAll(".diff-header-side")).toHaveLength(1);
    expect(container.querySelector(".diff-header-side--unified")).not.toBeNull();
    // The same facts, still all present.
    expect(screen.getByText("dd875b8")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Current version")).toBeInTheDocument();
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
    // CodeMirror consumes Escape to close the find panel and marks the event
    // handled; the window must not close out from under that.
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

describe("stepping between changed files", () => {
  /**
   * The default accelerator for next/previous file. Bubble phase, as the hook listens.
   *
   * Alt+Page, not Alt+Arrow: the horizontal arrows are word motion inside a
   * CodeMirror pane on every platform. See the note on the registry entries.
   */
  function pressAltPage(code: "PageUp" | "PageDown") {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code, altKey: true, bubbles: true, cancelable: true }),
    );
  }

  /** Press Next file, and let the flush and the load settle. */
  async function nextFile() {
    await act(async () => {
      screen.getByRole("button", { name: "Next changed file" }).click();
    });
  }

  async function previousFile() {
    await act(async () => {
      screen.getByRole("button", { name: "Previous changed file" }).click();
    });
  }

  it("shows where this file sits in the list", async () => {
    await renderReady();
    expect(await screen.findByText("2 / 3 files")).toBeInTheDocument();
  });

  it("counts a file that is staged and then changed again once", async () => {
    getStatusMock.mockResolvedValue({
      repoRoot: "/r",
      staged: [{ path: "src/a.ts", status: "modified" }],
      unstaged: [{ path: "src/a.ts", status: "modified" }],
      conflicts: [],
    });
    await renderReady();
    expect(await screen.findByText("1 / 1 files")).toBeInTheDocument();
  });

  it("leaves conflicts out, because those open the merge window", async () => {
    getStatusMock.mockResolvedValue({
      repoRoot: "/r",
      staged: [],
      unstaged: [{ path: "src/a.ts", status: "modified" }],
      conflicts: [{ path: "src/c.ts", kind: "bothModified" }],
    });
    await renderReady();
    expect(await screen.findByText("1 / 1 files")).toBeInTheDocument();
  });

  it("loads the next file in this window rather than opening another", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));

    await nextFile();

    expect(getFileDiffMock).toHaveBeenLastCalledWith({
      repoRoot: "/r",
      path: "src/after.ts",
      origPath: undefined,
    });
    expect(await screen.findByText("3 / 3 files")).toBeInTheDocument();
  });

  it("steps backwards too", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/before.ts" }));

    await previousFile();

    expect(getFileDiffMock).toHaveBeenLastCalledWith({
      repoRoot: "/r",
      path: "src/before.ts",
      origPath: undefined,
    });
  });

  it("stops at both ends rather than wrapping", async () => {
    // In a list of twenty-six, silently starting over reads as the button having
    // done nothing at all.
    getStatusMock.mockResolvedValue({
      repoRoot: "/r",
      staged: [],
      unstaged: [{ path: "src/a.ts", status: "modified" }],
      conflicts: [],
    });
    await renderReady();
    await screen.findByText("1 / 1 files");

    expect(screen.getByRole("button", { name: "Next changed file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous changed file" })).toBeDisabled();
  });

  it("writes an unsaved edit into the file it is leaving", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));

    await nextFile();

    expect(writeWorkingFileMock).toHaveBeenCalledWith(
      { repoRoot: "/r", path: "src/a.ts", origPath: undefined },
      "edited\n",
      "lf",
    );
  });

  it("never writes the new file's content into the old one", async () => {
    // The worst thing this feature could do, so it is asserted as an outcome
    // rather than as a mechanism. The danger is real — `writeBuffer` reads the
    // buffer when it *runs*, not when it was asked, so a write that outlives the
    // navigation would put the new file's content into the old file with perfectly
    // correct params — and this is the closest reachable approach to it: a second
    // flush requested while the navigation is suspended on the first, carrying the
    // old file's generation and running after the buffer is reset.
    //
    // It passes for two independent reasons (the generation guard, and `goToFile`
    // nulling `diffRef` before a stale write can read it), and removing either one
    // alone leaves it passing. That is the point of asserting the outcome: the
    // property has to hold however it is arrived at.
    await renderReady();
    await screen.findByText("2 / 3 files");

    let releaseWrite: () => void = () => {};
    writeWorkingFileMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = () => resolve();
        }),
    );

    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts", right: "other file\n" }));

    // Press Next. Its flush is the hanging write, so the navigation suspends here,
    // before the generation moves and before the buffer is reset.
    await act(async () => {
      screen.getByRole("button", { name: "Next changed file" }).click();
    });
    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);

    // Losing focus while it is suspended queues a second write behind the first.
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    // Releasing the first lets the navigation finish and adopt the new file, and
    // only then does the queued write get its turn.
    await act(async () => {
      releaseWrite();
    });
    await screen.findByText("3 / 3 files");

    const intoOldFile = writeWorkingFileMock.mock.calls.filter(
      ([params]) => params.path === "src/a.ts",
    );
    expect(intoOldFile).not.toHaveLength(0);
    expect(intoOldFile.every(([, content]) => content !== "other file\n")).toBe(true);
  });

  it("drops a diff that arrives for the file it has already left", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");

    // The old file's read is still in flight when the navigation happens.
    let releaseStale: (value: FileDiff) => void = () => {};
    getFileDiffMock.mockImplementationOnce(
      () => new Promise<FileDiff>((resolve) => (releaseStale = resolve)),
    );
    await act(async () => {
      fireRepoChanged();
    });

    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts", headSha: "newsha1" }));
    await nextFile();

    await act(async () => {
      releaseStale(fileDiff({ path: "src/a.ts", headSha: "stalesha" }));
    });

    expect(screen.queryByText("stalesha")).toBeNull();
    expect(screen.getByText("newsha1")).toBeInTheDocument();
  });

  it("refuses to leave a file whose save failed, and goes on the second press", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    writeWorkingFileMock.mockRejectedValue(new Error("permission denied"));
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));

    await nextFile();

    expect(screen.getByText("2 / 3 files")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/press Next file again/i);

    await nextFile();

    expect(await screen.findByText("3 / 3 files")).toBeInTheDocument();
  });

  it("clears the previous file's save error", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    writeWorkingFileMock.mockRejectedValueOnce(new Error("permission denied"));
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));
    await nextFile();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rebuilds the pane for the new file", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    const before = paneMounts.count;
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));

    await nextFile();

    expect(paneMounts.count).toBeGreaterThan(before);
  });

  it("does not stack navigations when the key is held down", async () => {
    // Alt+PageDown autorepeats. The guard only has anything to do when
    // `goToFile` actually suspends, so there has to be an edit for it to flush and
    // that flush has to be in flight when the second press arrives — otherwise the
    // whole of `goToFile` runs synchronously and the flag is back down before the
    // second press could see it.
    await renderReady();
    await screen.findByText("2 / 3 files");

    let releaseWrite: () => void = () => {};
    writeWorkingFileMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = () => resolve();
        }),
    );
    fireEvent.change(screen.getByLabelText("modified"), { target: { value: "edited\n" } });
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));
    const before = getFileDiffMock.mock.calls.length;

    // First press suspends on the flush; the second must be refused outright.
    await act(async () => {
      pressAltPage("PageDown");
    });
    await act(async () => {
      pressAltPage("PageDown");
    });
    await act(async () => {
      releaseWrite();
    });

    expect(writeWorkingFileMock).toHaveBeenCalledTimes(1);
    expect(getFileDiffMock.mock.calls.length - before).toBe(1);
  });

  it("walks the list on Alt+Page, the accelerator the settings offer", async () => {
    // The buttons and the keybinding are separate paths into `step`, and until now
    // only the buttons were covered.
    await renderReady();
    await screen.findByText("2 / 3 files");
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));

    await act(async () => {
      pressAltPage("PageDown");
    });

    expect(getFileDiffMock).toHaveBeenLastCalledWith({
      repoRoot: "/r",
      path: "src/after.ts",
      origPath: undefined,
    });
  });

  it("walks it backwards on Alt+PageUp", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/before.ts" }));

    await act(async () => {
      pressAltPage("PageUp");
    });

    expect(getFileDiffMock).toHaveBeenLastCalledWith({
      repoRoot: "/r",
      path: "src/before.ts",
      origPath: undefined,
    });
  });

  it("keeps both buttons alive when the file it shows has left the list", async () => {
    // `reanchor` holds the old slot, and the toolbar has to let you use it — the
    // counter says there are still files, so two dead buttons would read as a bug.
    await renderReady();
    await screen.findByText("2 / 3 files");

    // src/a.ts is gone, and the slot it held — index 1 — still has files either
    // side of it, so both directions are genuinely available.
    getStatusMock.mockResolvedValue({
      repoRoot: "/r",
      staged: [],
      unstaged: [
        { path: "src/before.ts", status: "modified" },
        { path: "src/middle.ts", status: "modified" },
        { path: "src/after.ts", status: "modified" },
      ],
      conflicts: [],
    });
    await act(async () => {
      fireRepoChanged();
    });
    await screen.findByText("— / 3 files");

    expect(screen.getByRole("button", { name: "Next changed file" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Previous changed file" })).toBeEnabled();

    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/middle.ts" }));
    await nextFile();

    // Lands on the file that took the slot, not on the one after it — otherwise
    // `middle.ts` would be unreachable in either direction from here.
    expect(getFileDiffMock).toHaveBeenLastCalledWith({
      repoRoot: "/r",
      path: "src/middle.ts",
      origPath: undefined,
    });
  });

  it("keeps its place when the list changes underneath it", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");

    getStatusMock.mockResolvedValue({
      repoRoot: "/r",
      staged: [],
      unstaged: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/after.ts", status: "modified" },
      ],
      conflicts: [],
    });
    await act(async () => {
      fireRepoChanged();
    });

    expect(await screen.findByText("1 / 2 files")).toBeInTheDocument();
  });

  it("stays open, saying so, when the file it shows leaves the list", async () => {
    // Committed or reverted while open. A diff of a file with no changes is a
    // legitimate thing to be looking at, and closing a window out from under
    // someone is hostile.
    await renderReady();
    await screen.findByText("2 / 3 files");

    getStatusMock.mockResolvedValue({
      repoRoot: "/r",
      staged: [],
      unstaged: [{ path: "src/after.ts", status: "modified" }],
      conflicts: [],
    });
    await act(async () => {
      fireRepoChanged();
    });

    expect(await screen.findByText("— / 1 files")).toBeInTheDocument();
    expect(screen.getByLabelText("modified")).toBeInTheDocument();
  });

  it("says so when nothing is changed any more", async () => {
    getStatusMock.mockResolvedValue({
      repoRoot: "/r",
      staged: [],
      unstaged: [],
      conflicts: [],
    });
    await renderReady();

    expect(await screen.findByText("No changed files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next changed file" })).toBeDisabled();
  });

  it("registers itself on mount and on every navigation", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    expect(registerDiffWindowMock).toHaveBeenCalledWith({
      repoRoot: "/r",
      path: "src/a.ts",
      origPath: undefined,
    });

    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));
    await nextFile();

    expect(registerDiffWindowMock).toHaveBeenCalledWith({
      repoRoot: "/r",
      path: "src/after.ts",
      origPath: undefined,
    });
  });

  it("renames the native window, which does not follow document.title", async () => {
    await renderReady();
    expect(setTitle).toHaveBeenCalledWith("Diff: src/a.ts");

    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/after.ts" }));
    await nextFile();

    expect(setTitle).toHaveBeenLastCalledWith("Diff: src/after.ts");
  });

  it("loads the file the backend asks it to show", async () => {
    // The `Reuse` route: this window was opened for a file, navigated away, and
    // the Status panel has been clicked on the file it was opened for.
    await renderReady();
    await screen.findByText("2 / 3 files");
    getFileDiffMock.mockResolvedValue(fileDiff({ path: "src/before.ts" }));

    await act(async () => {
      fireShowFile({ repoRoot: "/r", path: "src/before.ts" });
    });

    expect(getFileDiffMock).toHaveBeenLastCalledWith({
      repoRoot: "/r",
      path: "src/before.ts",
      origPath: undefined,
    });
  });

  it("ignores a request for the file it is already showing", async () => {
    await renderReady();
    await screen.findByText("2 / 3 files");
    const before = getFileDiffMock.mock.calls.length;

    await act(async () => {
      fireShowFile({ repoRoot: "/r", path: "src/a.ts" });
    });

    expect(getFileDiffMock.mock.calls.length).toBe(before);
  });

  it("still shows the diff when the status read fails", async () => {
    // A broken list must never break the diff, which is what this window is for.
    getStatusMock.mockRejectedValue(new Error("not a git repository"));
    await renderReady();

    expect(screen.getByLabelText("modified")).toHaveValue("one\ntwo changed\n");
    expect(screen.getByText("No changed files")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a status that came back for another repository", async () => {
    // The project was switched under this window. Its own close is on the way; a
    // list from somewhere else is worse than no list.
    getStatusMock.mockResolvedValue({
      repoRoot: "/elsewhere",
      staged: [],
      unstaged: [{ path: "other.ts", status: "modified" }],
      conflicts: [],
    });
    await renderReady();

    expect(await screen.findByText("No changed files")).toBeInTheDocument();
  });
});
