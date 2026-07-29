import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MergeWindow } from "./MergeWindow";
import { getConflictStages, resolvePath, writeResolved } from "../lib/gitMerge";
import { onRepoChanged } from "../lib/gitStatus";
import type { ConflictStages } from "../lib/gitMerge";

vi.mock("../lib/gitMerge", async (importOriginal) => {
  // parseMergeParams and the naming helpers are pure and tested elsewhere; only
  // the IPC is faked.
  const actual = await importOriginal<typeof import("../lib/gitMerge")>();
  return {
    ...actual,
    getConflictStages: vi.fn(),
    writeResolved: vi.fn(),
    resolvePath: vi.fn(),
  };
});
vi.mock("../lib/gitStatus", () => ({ onRepoChanged: vi.fn() }));

// MergePanes is stubbed for the same reason DiffWindow.test stubs DiffPane: this
// file is about what the *window* decides — which text to open, when to write,
// what to do with a reload — and a real CodeMirror mount measures nothing under
// jsdom. The stub exposes the one hook the window's behaviour runs through.
vi.mock("./MergePanes", () => ({
  MergePanes: ({
    value,
    onChange,
    busy,
  }: {
    value: string;
    onChange: (text: string) => void;
    busy: boolean;
  }) => (
    <div data-testid="panes" data-busy={busy}>
      <textarea
        aria-label="result buffer"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  ),
}));

const closeMock = vi.fn();
const destroyMock = vi.fn();
let closeRequested: ((event: { preventDefault: () => void }) => unknown) | null = null;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    destroy: destroyMock,
    onCloseRequested: (handler: (event: { preventDefault: () => void }) => unknown) => {
      closeRequested = handler;
      return Promise.resolve(vi.fn());
    },
  }),
}));
// Appearance is covered by its own tests; stubbed here so this window does not
// subscribe to the real settings event.
vi.mock("../hooks/useAppearance", () => ({ useAppearanceSync: vi.fn() }));

const getConflictStagesMock = vi.mocked(getConflictStages);
const writeResolvedMock = vi.mocked(writeResolved);
const resolvePathMock = vi.mocked(resolvePath);
const onRepoChangedMock = vi.mocked(onRepoChanged);

const RESULT = "context above\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\ncontext below\n";
const RESOLVED = "context above\nmine\ncontext below\n";

/** A conflicted file with one conflict between two unchanged runs. */
function stages(overrides: Partial<ConflictStages> = {}): ConflictStages {
  return {
    path: "src/app.ts",
    base: ["context above", "base line", "context below", ""],
    ours: ["context above", "mine", "context below", ""],
    theirs: ["context above", "theirs", "context below", ""],
    stages: [1, 2, 3],
    chunks: [
      {
        kind: "unchanged",
        base: { start: 0, end: 1 },
        ours: { start: 0, end: 1 },
        theirs: { start: 0, end: 1 },
        result: { start: 0, end: 1 },
      },
      {
        kind: "conflict",
        base: { start: 1, end: 2 },
        ours: { start: 1, end: 2 },
        theirs: { start: 1, end: 2 },
        result: { start: 1, end: 6 },
      },
      {
        kind: "unchanged",
        base: { start: 2, end: 4 },
        ours: { start: 2, end: 4 },
        theirs: { start: 2, end: 4 },
        result: { start: 6, end: 8 },
      },
    ],
    result: RESULT,
    disk: RESULT,
    oursLabel: "HEAD",
    theirsLabel: "feature",
    revision: "rev-1",
    diverged: false,
    binary: false,
    ...overrides,
  };
}

/** One turn of the event loop, for asserting that something did *not* happen. */
const settle = () => act(async () => {});

function setSearch(search: string) {
  // The window reads its target from its own URL, once, on mount.
  window.history.replaceState({}, "", `/merge.html${search}`);
}

/** Type into the stubbed result pane. */
function editBuffer(text: string) {
  fireEvent.change(screen.getByLabelText("result buffer"), { target: { value: text } });
}

beforeEach(() => {
  setSearch("?repo=%2Frepo&path=src%2Fapp.ts");
  getConflictStagesMock.mockResolvedValue(stages());
  writeResolvedMock.mockResolvedValue({ remaining: 0, staged: true });
  resolvePathMock.mockResolvedValue(undefined);
  onRepoChangedMock.mockResolvedValue(vi.fn());
  closeMock.mockClear();
  destroyMock.mockClear();
  closeRequested = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MergeWindow", () => {
  it("reads the file named in its own query string", async () => {
    render(<MergeWindow />);
    await waitFor(() => expect(getConflictStagesMock).toHaveBeenCalledWith("/repo", "src/app.ts"));
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
  });

  it("opens the rebuilt merge and counts what is left to decide", async () => {
    render(<MergeWindow />);
    await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());
    expect(screen.getByLabelText("result buffer")).toHaveValue(RESULT);
    expect(screen.getByText("1 conflict to decide")).toBeInTheDocument();
  });

  it("renders the message rather than an empty pane when opened by hand", async () => {
    setSearch("");
    render(<MergeWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/without a repository/);
    expect(getConflictStagesMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed read", async () => {
    getConflictStagesMock.mockRejectedValue(new Error("'x' resolves outside the repository"));
    render(<MergeWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/outside the repository/);
  });

  describe("the single write", () => {
    it("offers to stage once the last conflict is decided, and writes nothing yet", async () => {
      // The whole point of the pause: a decided file is not a reviewed one, and
      // nothing reaches the index until the user says so.
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);

      expect(await screen.findByRole("button", { name: /stage this file/i })).toBeInTheDocument();
      expect(screen.getByText(/read the result over/i)).toBeInTheDocument();
      await settle();
      expect(writeResolvedMock).not.toHaveBeenCalled();
    });

    it("writes and stages when the button is pressed", async () => {
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));

      await waitFor(() =>
        expect(writeResolvedMock).toHaveBeenCalledWith("/repo", "src/app.ts", RESOLVED, "rev-1"),
      );
      expect(await screen.findByText(/resolved, and the file is staged/i)).toBeInTheDocument();
      // The offer goes with the deed: the buffer and what was written now agree.
      expect(screen.queryByRole("button", { name: /stage this file/i })).not.toBeInTheDocument();
    });

    it("offers nothing while a conflict is still undecided", async () => {
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      // An edit that leaves the markers alone: still work outstanding.
      editBuffer(RESULT.replace("mine", "mine, edited"));

      await settle();
      expect(screen.queryByRole("button", { name: /stage this file/i })).not.toBeInTheDocument();
      expect(writeResolvedMock).not.toHaveBeenCalled();
      expect(screen.getByText("1 conflict to decide")).toBeInTheDocument();
    });

    it("offers nothing for a file that arrived with nothing to decide", async () => {
      // Untouched: there is no resolution of the user's to stage, so an offer would
      // be inviting them to stage whatever git happened to leave in the tree.
      getConflictStagesMock.mockResolvedValue(stages({ result: RESOLVED, disk: RESOLVED }));
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      await settle();
      expect(screen.queryByRole("button", { name: /stage this file/i })).not.toBeInTheDocument();
      expect(writeResolvedMock).not.toHaveBeenCalled();
    });

    it("does not offer again when its own write comes back through the watcher", async () => {
      // The write triggers repo://changed, which reloads. Without the guard on what
      // was written, the window would ask to stage the file it just staged.
      let fire: () => void = () => undefined;
      onRepoChangedMock.mockImplementation((handler: () => void) => {
        fire = handler;
        return Promise.resolve(vi.fn());
      });
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));
      await waitFor(() => expect(writeResolvedMock).toHaveBeenCalledTimes(1));

      getConflictStagesMock.mockResolvedValue(stages({ stages: [], disk: RESOLVED }));
      fire();
      await waitFor(() => expect(screen.getByText(/no longer reports this file/i)).toBeVisible());
      expect(writeResolvedMock).toHaveBeenCalledTimes(1);
    });

    it("surfaces a refused write and keeps the buffer", async () => {
      // The backend re-counts the markers and re-checks the revision; a refusal is
      // information, not something to paper over.
      writeResolvedMock.mockRejectedValue(
        new Error("'src/app.ts' changed on disk since it was read; reload it and try again"),
      );
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/changed on disk/);
      expect(screen.getByLabelText("result buffer")).toHaveValue(RESOLVED);
      // Still offered: pressing it again is a fresh attempt, which is the recovery
      // for a refusal the file itself has moved past. It is *not* the recovery for a
      // stale revision, where the second attempt sends the same revision and is
      // refused identically — reloading is. The button being offered either way is
      // right, because the window cannot tell the two refusals apart.
      expect(screen.getByRole("button", { name: /stage this file/i })).toBeInTheDocument();
    });

    it("never writes on its own after a refusal", async () => {
      // What used to need a `refusedRef` guard against a write that retried itself
      // forever, holding the op lock and starving the main window's git operations.
      // With the write behind a button there is nothing to loop: the count only
      // moves when the user moves it.
      writeResolvedMock.mockRejectedValue(new Error("'src/app.ts' changed on disk"));
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));
      await waitFor(() => expect(writeResolvedMock).toHaveBeenCalledTimes(1));

      for (let turn = 0; turn < 5; turn += 1) await settle();
      expect(writeResolvedMock).toHaveBeenCalledTimes(1);

      // And pressing it again is a fresh attempt.
      fireEvent.click(screen.getByRole("button", { name: /stage this file/i }));
      await waitFor(() => expect(writeResolvedMock).toHaveBeenCalledTimes(2));
    });

    it("keeps an edit typed while the write was in flight", async () => {
      // The panes stay editable across the write, deliberately, so this is a race the
      // model has to answer rather than one it can rule out. Clearing "touched" on
      // any successful write would strand the newer text: unstageable, because the
      // offer needs `touched`, and dropped with no prompt on close, because the close
      // guard bails on the same flag.
      let finishWrite: () => void = () => undefined;
      writeResolvedMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishWrite = () => resolve({ remaining: 0, staged: true });
          }),
      );
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));
      await waitFor(() => expect(writeResolvedMock).toHaveBeenCalledTimes(1));

      // Typed while the IPC call is outstanding.
      const later = RESOLVED.replace("mine", "mine, typed during the write");
      editBuffer(later);
      finishWrite();
      await settle();

      // The newer text can still be staged, and it is what would be written.
      expect(screen.getByRole("button", { name: /stage this file/i })).toBeInTheDocument();
      expect(screen.getByLabelText("result buffer")).toHaveValue(later);
      fireEvent.click(screen.getByRole("button", { name: /stage this file/i }));
      await waitFor(() =>
        expect(writeResolvedMock).toHaveBeenLastCalledWith("/repo", "src/app.ts", later, "rev-1"),
      );
    });

    it("still asks before closing on an edit typed while the write was in flight", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      let finishWrite: () => void = () => undefined;
      writeResolvedMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishWrite = () => resolve({ remaining: 0, staged: true });
          }),
      );
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));
      editBuffer(RESOLVED.replace("mine", "mine, typed during the write"));
      finishWrite();
      await settle();

      const preventDefault = vi.fn();
      await closeRequested?.({ preventDefault });

      expect(preventDefault).toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/has not been staged/i));
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("offers to stage again for a conflict recreated in the same window", async () => {
      // `git checkout --merge` brings the conflict back. Resolving it to byte-identical
      // text is then a resolution that has never been staged, so remembering what was
      // written across the reload would decline to offer it.
      let fire: () => void = () => undefined;
      onRepoChangedMock.mockImplementation((handler: () => void) => {
        fire = handler;
        return Promise.resolve(vi.fn());
      });
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));
      await waitFor(() => expect(writeResolvedMock).toHaveBeenCalledTimes(1));

      // The conflict is back, as a different revision of the same path.
      getConflictStagesMock.mockResolvedValue(stages({ revision: "rev-2" }));
      fire();
      await waitFor(() => expect(screen.getByLabelText("result buffer")).toHaveValue(RESULT));

      // Resolved to exactly the text staged a moment ago.
      editBuffer(RESOLVED);
      expect(await screen.findByRole("button", { name: /stage this file/i })).toBeInTheDocument();
    });

    it("keeps a refusal on screen when an unrelated watcher event arrives", async () => {
      // A read succeeding says nothing about the write that was refused, and the
      // user still has to act on it.
      let fire: () => void = () => undefined;
      onRepoChangedMock.mockImplementation((handler: () => void) => {
        fire = handler;
        return Promise.resolve(vi.fn());
      });
      writeResolvedMock.mockRejectedValue(new Error("'src/app.ts' changed on disk"));
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());
      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/changed on disk/);

      fire();
      await settle();

      expect(screen.getByRole("alert")).toHaveTextContent(/changed on disk/);
    });
  });

  describe("a file that changed since git wrote it", () => {
    it("asks which version to work from instead of guessing", async () => {
      getConflictStagesMock.mockResolvedValue(
        stages({ diverged: true, disk: "context above\nhand edited\ncontext below\n" }),
      );
      render(<MergeWindow />);

      expect(await screen.findByText(/changed since git wrote it/i)).toBeInTheDocument();
      // No editor yet: opening either text would be a guess, and one of them loses
      // work done outside the app.
      expect(screen.queryByTestId("panes")).not.toBeInTheDocument();
    });

    it("opens the file on disk when asked, keeping the edit", async () => {
      const disk = "context above\nhand edited\ncontext below\n";
      getConflictStagesMock.mockResolvedValue(stages({ diverged: true, disk }));
      render(<MergeWindow />);
      fireEvent.click(await screen.findByRole("button", { name: /use the file on disk/i }));

      expect(screen.getByLabelText("result buffer")).toHaveValue(disk);
      expect(screen.getByText(/opened from the file on disk/i)).toBeInTheDocument();
    });

    it("opens the rebuild when asked to start over", async () => {
      getConflictStagesMock.mockResolvedValue(
        stages({ diverged: true, disk: "context above\nhand edited\ncontext below\n" }),
      );
      render(<MergeWindow />);
      fireEvent.click(await screen.findByRole("button", { name: /start over/i }));

      expect(screen.getByLabelText("result buffer")).toHaveValue(RESULT);
    });

    it("still offers to stage a disk version that has no conflicts left", async () => {
      // "Use the file on disk" on an already-resolved file: nothing is staged yet,
      // so choosing that text counts as work of the user's and can be staged.
      getConflictStagesMock.mockResolvedValue(
        stages({ diverged: true, disk: RESOLVED }),
      );
      render(<MergeWindow />);
      fireEvent.click(await screen.findByRole("button", { name: /use the file on disk/i }));
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));

      await waitFor(() =>
        expect(writeResolvedMock).toHaveBeenCalledWith("/repo", "src/app.ts", RESOLVED, "rev-1"),
      );
    });
  });

  describe("following the file", () => {
    it("adopts a reload while the buffer is untouched", async () => {
      let fire: () => void = () => undefined;
      onRepoChangedMock.mockImplementation((handler: () => void) => {
        fire = handler;
        return Promise.resolve(vi.fn());
      });
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      const moved = RESULT.replace("theirs", "their newer line");
      getConflictStagesMock.mockResolvedValue(
        stages({ result: moved, disk: moved, revision: "rev-2" }),
      );
      fire();

      await waitFor(() => expect(screen.getByLabelText("result buffer")).toHaveValue(moved));
      expect(screen.queryByText(/changed on disk while you were working/i)).not.toBeInTheDocument();
    });

    it("says nothing when the event was about some other file", async () => {
      // `repo://changed` fires for anything in the repository, and with Claude Code
      // writing files in the terminal next door that is the common case. Warning
      // about a file nobody touched — and offering to discard the buffer — would be
      // a lie the user has to evaluate every few seconds.
      let fire: () => void = () => undefined;
      onRepoChangedMock.mockImplementation((handler: () => void) => {
        fire = handler;
        return Promise.resolve(vi.fn());
      });
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      const mine = RESULT.replace("mine", "my work in progress");
      editBuffer(mine);
      // Same revision and the same stages: this file did not move.
      fire();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(screen.queryByText(/changed on disk while you were working/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText("result buffer")).toHaveValue(mine);
    });

    it("keeps a touched buffer and says the file moved instead", async () => {
      // The whole reason the diff window's adopt guard has an analogue here: a
      // watcher event fires for anything in the repository, and silently replacing
      // a half-finished resolution is unforgivable.
      let fire: () => void = () => undefined;
      onRepoChangedMock.mockImplementation((handler: () => void) => {
        fire = handler;
        return Promise.resolve(vi.fn());
      });
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      const mine = RESULT.replace("mine", "my work in progress");
      editBuffer(mine);

      getConflictStagesMock.mockResolvedValue(
        stages({
          result: RESULT.replace("theirs", "elsewhere"),
          disk: "something else\n",
          // A changed file means a changed revision: it is a hash of the bytes.
          revision: "rev-2",
        }),
      );
      fire();

      await waitFor(() =>
        expect(screen.getByText(/changed on disk while you were working/i)).toBeInTheDocument(),
      );
      expect(screen.getByLabelText("result buffer")).toHaveValue(mine);
    });

    it("reloads on request, discarding the buffer the user chose to drop", async () => {
      let fire: () => void = () => undefined;
      onRepoChangedMock.mockImplementation((handler: () => void) => {
        fire = handler;
        return Promise.resolve(vi.fn());
      });
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());
      editBuffer(RESULT.replace("mine", "my work in progress"));

      const newer = RESULT.replace("theirs", "elsewhere");
      getConflictStagesMock.mockResolvedValue(
        stages({ result: newer, disk: newer, revision: "rev-2" }),
      );
      fire();
      await waitFor(() =>
        expect(screen.getByText(/changed on disk while you were working/i)).toBeInTheDocument(),
      );

      // The notice must not promise a write: the revision it would send is the stale
      // one, and the backend refuses exactly that.
      expect(screen.getByText(/staging what you have will be refused/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /reload it/i }));
      await waitFor(() => expect(screen.getByLabelText("result buffer")).toHaveValue(newer));
    });
  });

  describe("closing", () => {
    it("asks before dropping an undecided buffer", async () => {
      // The buffer is not on disk anywhere until every conflict is decided, so it
      // goes with the window.
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());
      editBuffer(RESULT.replace("mine", "half done"));

      const preventDefault = vi.fn();
      await closeRequested?.({ preventDefault });

      expect(preventDefault).toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/unresolved conflicts/i));
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("closes once the loss is confirmed", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());
      editBuffer(RESULT.replace("mine", "half done"));

      await closeRequested?.({ preventDefault: vi.fn() });

      expect(destroyMock).toHaveBeenCalled();
    });

    it("does not ask when nothing has been touched", async () => {
      const confirm = vi.spyOn(window, "confirm");
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      const preventDefault = vi.fn();
      await closeRequested?.({ preventDefault });

      expect(preventDefault).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    });

    it("asks before dropping a decided but unstaged buffer", async () => {
      // Deciding every conflict no longer writes anything, so this result is as
      // unsaved as a half-finished one and says so in its own words.
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());
      editBuffer(RESOLVED);

      const preventDefault = vi.fn();
      await closeRequested?.({ preventDefault });

      expect(preventDefault).toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/has not been staged/i));
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("does not ask once the file has been resolved and staged", async () => {
      const confirm = vi.spyOn(window, "confirm");
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());
      editBuffer(RESOLVED);
      fireEvent.click(await screen.findByRole("button", { name: /stage this file/i }));
      await waitFor(() => expect(writeResolvedMock).toHaveBeenCalled());

      await closeRequested?.({ preventDefault: vi.fn() });

      expect(confirm).not.toHaveBeenCalled();
    });

    it("closes on Escape and on Ctrl+W", async () => {
      render(<MergeWindow />);
      await waitFor(() => expect(screen.getByTestId("panes")).toBeInTheDocument());

      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
      expect(closeMock).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(window, { key: "w", ctrlKey: true });
      expect(closeMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("the conflicts with no text to merge", () => {
    it("offers a whole-side choice for a binary file", async () => {
      getConflictStagesMock.mockResolvedValue(
        stages({ binary: true, chunks: [], result: "", ours: [], theirs: [] }),
      );
      render(<MergeWindow />);

      expect(await screen.findByText(/nothing to merge line by line/i)).toBeInTheDocument();
      expect(screen.queryByTestId("panes")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /keep mine/i }));
      await waitFor(() =>
        expect(resolvePathMock).toHaveBeenCalledWith("/repo", "src/app.ts", "keepOurs"),
      );
    });

    it("points at the panel for a one-sided conflict", async () => {
      // Only stage 2: there is no second version to put in a pane, and the
      // whole-file buttons live on the row in the Status panel.
      getConflictStagesMock.mockResolvedValue(
        stages({ stages: [1, 2], chunks: [], result: "", theirs: [] }),
      );
      render(<MergeWindow />);

      expect(await screen.findByText(/only one side of this file/i)).toBeInTheDocument();
      expect(screen.queryByTestId("panes")).not.toBeInTheDocument();
    });

    it("says so, and still offers Mark resolved, once git stops reporting it", async () => {
      // Reachable by an abort, by resolving elsewhere, or by a hand fix the user
      // has not staged — which is what keeps the button worth having.
      getConflictStagesMock.mockResolvedValue(stages({ stages: [], chunks: [], result: "" }));
      render(<MergeWindow />);

      expect(await screen.findByText(/no longer reports this file as conflicted/i)).toBeVisible();
      // Never closes itself: an OS window vanishing reads as a crash.
      expect(closeMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /mark resolved/i }));
      await waitFor(() =>
        expect(resolvePathMock).toHaveBeenCalledWith("/repo", "src/app.ts", "markResolved"),
      );
    });
  });
});
