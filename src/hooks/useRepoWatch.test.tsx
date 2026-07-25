import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { getStatus, onRepoChanged, startWatch, type GitStatus } from "../lib/gitStatus";
import { getBranchState } from "../lib/gitBranch";
import { initialGitState, useGitStore } from "../store/gitStore";
import { useRepoWatch } from "./useRepoWatch";

vi.mock("../lib/gitStatus", () => ({
  getStatus: vi.fn(),
  startWatch: vi.fn(),
  onRepoChanged: vi.fn(),
}));

vi.mock("../lib/gitBranch", () => ({ getBranchState: vi.fn() }));

const getStatusMock = vi.mocked(getStatus);
const startWatchMock = vi.mocked(startWatch);
const onRepoChangedMock = vi.mocked(onRepoChanged);
const getBranchStateMock = vi.mocked(getBranchState);

const BRANCH_STATE = {
  current: "main",
  detachedSha: null,
  unborn: false,
  upstream: "origin/main",
  upstreamGone: false,
  upstreamOnRemote: true,
  remote: "origin",
  ahead: 0,
  behind: 0,
  lastFetch: null,
  locals: [],
  remotes: [],
};

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
  getStatusMock.mockResolvedValue({ repoRoot: "/repo", staged: [], unstaged: [], conflicts: [] });
  getBranchStateMock.mockResolvedValue(BRANCH_STATE);
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

  it("collapses a burst of repo://changed into one read plus one (Part 9)", async () => {
    // The watcher can fire several times a second, and each event used to start
    // its own cascade of three reads. This is the user-visible scenario end to
    // end: the hook stays a dumb forwarder and the store absorbs the burst.
    render(<Harness />);
    await flush();
    getStatusMock.mockClear();

    let release!: (value: GitStatus) => void;
    getStatusMock.mockImplementationOnce(
      () => new Promise<GitStatus>((resolve) => (release = resolve)),
    );

    repoChangedCb!();
    repoChangedCb!();
    repoChangedCb!();
    expect(getStatusMock).toHaveBeenCalledTimes(1);

    release({ repoRoot: "/repo", staged: [], unstaged: [], conflicts: [] });
    await flush();

    expect(getStatusMock).toHaveBeenCalledTimes(2);
  });

  it("reads the branch state on mount, after the root is resolved", async () => {
    render(<Harness />);
    await flush();

    expect(getBranchStateMock).toHaveBeenCalledWith("/repo");
    expect(useGitStore.getState().branch).toEqual(BRANCH_STATE);
  });

  it("re-reads the branch state too when repo://changed fires", async () => {
    // The watcher covers .git, so a branch switch made in the bottom terminal
    // updates the status bar with no button press.
    render(<Harness />);
    await flush();
    getBranchStateMock.mockClear();

    repoChangedCb!();
    await flush();

    expect(getBranchStateMock).toHaveBeenCalledTimes(1);
  });

  it("skips both reads while one of our own operations is running", async () => {
    render(<Harness />);
    await flush();
    getStatusMock.mockClear();
    getBranchStateMock.mockClear();
    // A fetch re-fires the watcher repeatedly for its whole duration.
    useGitStore.setState({ op: { id: "fetch-1", kind: "fetch", progress: "" } });

    repoChangedCb!();
    await flush();

    expect(getStatusMock).not.toHaveBeenCalled();
    expect(getBranchStateMock).not.toHaveBeenCalled();
  });

  it("does not read branch state when the directory is not a repo", async () => {
    getStatusMock.mockRejectedValue(new Error("not a git repository"));
    render(<Harness />);
    await flush();

    expect(getBranchStateMock).not.toHaveBeenCalled();
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
    resolveStatus({ repoRoot: "/repo", staged: [], unstaged: [], conflicts: [] });
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
