import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { getStatus, onRepoChanged, startWatch, type GitStatus } from "../lib/gitStatus";
import { initialGitState, useGitStore } from "../store/gitStore";
import { useRepoWatch } from "./useRepoWatch";

vi.mock("../lib/gitStatus", () => ({
  getStatus: vi.fn(),
  startWatch: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const getStatusMock = vi.mocked(getStatus);
const startWatchMock = vi.mocked(startWatch);
const onRepoChangedMock = vi.mocked(onRepoChanged);

function Harness() {
  useRepoWatch();
  return null;
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

let repoChangedCb: (() => void) | undefined;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useGitStore.setState(initialGitState);
  unlisten = vi.fn();
  repoChangedCb = undefined;
  getStatusMock.mockResolvedValue({ repoRoot: "/repo", staged: [], unstaged: [] });
  startWatchMock.mockResolvedValue(undefined);
  onRepoChangedMock.mockImplementation((cb: () => void) => {
    repoChangedCb = cb;
    return Promise.resolve(unlisten as unknown as () => void);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useRepoWatch", () => {
  it("fetches status, starts the watcher, and subscribes on mount", async () => {
    render(<Harness />);
    await flush();

    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(startWatchMock).toHaveBeenCalledWith("/repo");
    expect(onRepoChangedMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when repo://changed fires", async () => {
    render(<Harness />);
    await flush();
    getStatusMock.mockClear();

    repoChangedCb!();
    await flush();

    expect(getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a watcher when the directory is not a repo", async () => {
    getStatusMock.mockRejectedValue(new Error("not a git repository"));
    render(<Harness />);
    await flush();

    expect(startWatchMock).not.toHaveBeenCalled();
    expect(onRepoChangedMock).not.toHaveBeenCalled();
    expect(useGitStore.getState().phase).toBe("error");
  });

  it("still subscribes to changes when starting the watcher fails", async () => {
    // A watch failure is non-fatal: the one-shot status still shows and the
    // subscription is still attempted (it just may never receive events).
    startWatchMock.mockRejectedValue(new Error("watch failed"));
    render(<Harness />);
    await flush();

    expect(onRepoChangedMock).toHaveBeenCalledTimes(1);
    expect(useGitStore.getState().phase).toBe("ready");
  });

  it("does not subscribe when unmounted before the initial fetch resolves", async () => {
    // Hold the initial fetch open so we can unmount mid-flight; the cancelled
    // guard must then skip the watcher setup entirely.
    let resolveStatus!: (value: GitStatus) => void;
    getStatusMock.mockImplementation(
      () => new Promise<GitStatus>((resolve) => (resolveStatus = resolve)),
    );

    const { unmount } = render(<Harness />);
    unmount();
    resolveStatus({ repoRoot: "/repo", staged: [], unstaged: [] });
    await flush();

    expect(startWatchMock).not.toHaveBeenCalled();
    expect(onRepoChangedMock).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<Harness />);
    await flush();

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
