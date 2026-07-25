import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BranchStatus } from "./BranchStatus";
import { initialGitState, useGitStore } from "../store/gitStore";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";
import type { BranchState } from "../lib/gitBranch";
import type { FileEntry } from "../lib/gitStatus";

// Validation is the only lib call the dialogs make; everything else goes through
// the store, whose actions are stubbed per test.
vi.mock("../lib/gitBranch", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  validateBranchName: vi.fn().mockResolvedValue(null),
}));

function branchState(overrides: Partial<BranchState> = {}): BranchState {
  return {
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
    locals: [
      { name: "main", upstream: "origin/main", committerDate: 2, headShort: "aaa" },
      { name: "dev", committerDate: 1, headShort: "bbb" },
    ],
    remotes: [
      {
        name: "origin/colleague",
        remote: "origin",
        branch: "colleague",
        hasLocal: false,
        committerDate: 1,
        headShort: "ccc",
      },
    ],
    ...overrides,
  };
}

/** Stub the store actions so a test can assert on what the UI asked for. */
function stubActions() {
  const actions = {
    switchTo: vi.fn().mockResolvedValue(true),
    createBranch: vi.fn().mockResolvedValue(true),
    deleteBranch: vi.fn().mockResolvedValue(true),
    renameBranch: vi.fn().mockResolvedValue(true),
    runOp: vi.fn().mockResolvedValue(true),
    cancelOp: vi.fn().mockResolvedValue(undefined),
    mergeBranch: vi.fn().mockResolvedValue(true),
  };
  useGitStore.setState(actions);
  return actions;
}

function setup(
  overrides: Partial<BranchState> = {},
  extra: { staged?: FileEntry[]; unstaged?: FileEntry[] } = {},
) {
  useGitStore.setState({
    repoRoot: "/repo",
    branch: branchState(overrides),
    staged: extra.staged ?? [],
    unstaged: extra.unstaged ?? [],
  });
  const actions = stubActions();
  render(<BranchStatus />);
  return actions;
}

beforeEach(() => {
  useGitStore.setState(initialGitState);
  useLayoutStore.setState(initialLayoutState);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BranchStatus rendering", () => {
  it("renders nothing before the first branch read lands", () => {
    useGitStore.setState({ repoRoot: "/repo", branch: null });
    const { container } = render(<BranchStatus />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing outside a repository", () => {
    useGitStore.setState({ repoRoot: null, branch: branchState() });
    const { container } = render(<BranchStatus />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the branch and its ahead/behind counts", () => {
    setup({ ahead: 2, behind: 1 });
    expect(screen.getByRole("button", { name: "Current branch" })).toHaveTextContent("main");
    expect(screen.getByText("↑2")).toBeInTheDocument();
    expect(screen.getByText("↓1")).toBeInTheDocument();
  });

  it("hides the counts when the branch has no upstream", () => {
    setup({ upstream: null });
    expect(screen.queryByText("↑0")).not.toBeInTheDocument();
  });

  it("shows a detached HEAD by its sha and disables syncing", () => {
    setup({ current: null, detachedSha: "abc1234", upstream: null });
    expect(screen.getByRole("button", { name: "Current branch" })).toHaveTextContent(
      "HEAD @ abc1234",
    );
    expect(screen.getByRole("button", { name: "Publish branch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

  it("marks an unborn HEAD and refuses to push from it", () => {
    setup({ unborn: true, upstream: null, locals: [], remotes: [] });
    expect(screen.getByRole("button", { name: "Current branch" })).toHaveTextContent("no commits");
    expect(screen.getByRole("button", { name: "Publish branch" })).toBeDisabled();
  });
});

describe("BranchStatus sync controls", () => {
  it("fetches from the resolved remote", () => {
    const { runOp } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(runOp).toHaveBeenCalledWith({ kind: "fetch", remote: "origin" });
  });

  it("disables fetch when there is no remote at all", () => {
    setup({ remote: null, upstream: null });
    const fetch = screen.getByRole("button", { name: "Fetch" });
    expect(fetch).toBeDisabled();
    expect(fetch).toHaveAttribute("title", "No remote to fetch from");
  });

  it("reports how stale the counts are once the tooltip is about to be read", () => {
    // Date.now() cannot be called during render, so the age is sampled on hover.
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    setup({ lastFetch: now / 1000 - 12 * 60 });

    const fetch = screen.getByRole("button", { name: "Fetch" });
    expect(fetch).toHaveAttribute("title", "Fetch origin");
    fireEvent.mouseEnter(fetch);
    expect(fetch).toHaveAttribute("title", "Fetch origin — fetched 12m ago");
  });

  it("says so when nothing has ever been fetched", () => {
    setup({ lastFetch: null });
    expect(screen.getByRole("button", { name: "Fetch" })).toHaveAttribute(
      "title",
      "Fetch origin — never fetched",
    );
  });

  it("enables pull only when the branch is behind", () => {
    setup({ behind: 0 });
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

  it("pulls when behind", () => {
    const { runOp } = setup({ behind: 3 });
    const pull = screen.getByRole("button", { name: "Pull" });
    expect(pull).toBeEnabled();
    expect(pull).toHaveTextContent("3");
    fireEvent.click(pull);
    expect(runOp).toHaveBeenCalledWith({ kind: "pull", remote: "origin" });
  });

  it("enables push only when the branch is ahead", () => {
    setup({ ahead: 0 });
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
  });

  it("pushes when ahead, without setting an upstream", () => {
    const { runOp } = setup({ ahead: 2 });
    const push = screen.getByRole("button", { name: "Push" });
    expect(push).toHaveTextContent("2");
    fireEvent.click(push);
    expect(runOp).toHaveBeenCalledWith({
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: false,
    });
  });

  it("says the upstream is gone instead of showing a reassuring zero", () => {
    // A pruned upstream is still *configured*, so ahead/behind come back 0/0.
    // Rendering that as ↑0 ↓0 would read as "in sync" for a branch whose remote
    // copy has been deleted.
    setup({ upstreamGone: true, ahead: 0, behind: 0 });
    expect(screen.getByText("upstream gone")).toBeInTheDocument();
    expect(screen.queryByText("↑0")).not.toBeInTheDocument();
    expect(screen.queryByText("↓0")).not.toBeInTheDocument();
  });

  it("disables pull and explains why when the upstream is gone", () => {
    setup({ upstreamGone: true, behind: 3 });
    const pull = screen.getByRole("button", { name: "Pull" });
    expect(pull).toBeDisabled();
    expect(pull.getAttribute("title")).toMatch(/no longer exists on the remote/);
  });

  it("offers to publish again when the upstream is gone, recreating it", () => {
    // The branch really is not on the remote any more, so "Publish" is the
    // honest label, and pushing recreates it.
    const { runOp } = setup({ upstreamGone: true, ahead: 0 });
    const publish = screen.getByRole("button", { name: "Publish branch" });
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    expect(runOp).toHaveBeenCalledWith({
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: true,
    });
  });

  it("still allows a fetch when the upstream is gone", () => {
    // Fetch is how you would discover the branch is back, so it must stay live.
    const { runOp } = setup({ upstreamGone: true });
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(runOp).toHaveBeenCalledWith({ kind: "fetch", remote: "origin" });
  });

  it("does not claim the upstream is gone on a branch that never had one", () => {
    setup({ upstream: null, upstreamGone: false });
    expect(screen.queryByText("upstream gone")).not.toBeInTheDocument();
  });

  it("does not say 'on the remote' when the lost upstream was a local branch", () => {
    // `git branch --track topic main` gives a valid upstream that is a local
    // branch. Telling the user it vanished from the remote, and offering to push
    // to recreate it, would be wrong on both counts.
    setup({ upstream: "main", upstreamOnRemote: false, upstreamGone: true });
    const chip = screen.getByText("upstream gone");
    expect(chip.getAttribute("title")).toMatch(/local branch this tracked/);
    expect(chip.getAttribute("title")).not.toMatch(/on the remote/);
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

  it("treats a healthy local-branch upstream as unpublished, not as remote-tracking", () => {
    // The sync cluster is about a remote; `branch.topic.remote = "."` is not one,
    // so counts against it would be meaningless here.
    setup({ upstream: "main", upstreamOnRemote: false, ahead: 2, behind: 1 });
    expect(screen.queryByText("↑2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish branch" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

  it("becomes Publish branch with no upstream, and sets one", () => {
    const { runOp } = setup({ upstream: null, ahead: 0 });
    const publish = screen.getByRole("button", { name: "Publish branch" });
    expect(publish).toBeEnabled();
    expect(publish).toHaveTextContent("Publish");
    fireEvent.click(publish);
    expect(runOp).toHaveBeenCalledWith({
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: true,
    });
  });
});

describe("BranchStatus while an operation runs", () => {
  function running(progress = "") {
    setup();
    act(() => {
      useGitStore.setState({ op: { id: "fetch-1", kind: "fetch", progress } });
    });
  }

  it("replaces the sync controls with the running op and a cancel button", () => {
    running();
    expect(screen.getByText("fetch…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel fetch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fetch" })).not.toBeInTheDocument();
  });

  it("shows git's own progress line", () => {
    // git pads its progress ("Receiving objects:  50%"), and the text is passed
    // through verbatim, so match loosely rather than on exact whitespace.
    running("Receiving objects:  50% (1/2)");
    expect(screen.getByText(/Receiving objects:\s+50% \(1\/2\)/)).toBeInTheDocument();
  });

  it("cancels through the store", () => {
    running();
    const cancelOp = vi.fn().mockResolvedValue(undefined);
    act(() => useGitStore.setState({ cancelOp }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel fetch" }));
    expect(cancelOp).toHaveBeenCalledTimes(1);
  });

  it("locks the branch picker so a switch cannot race the operation", () => {
    running();
    expect(screen.getByRole("button", { name: "Current branch" })).toBeDisabled();
  });
});

describe("BranchStatus branch switching", () => {
  it("switches straight away when the tree is clean", () => {
    const { switchTo } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to dev" }));
    // A clean tree makes the policy irrelevant; bring is the no-op path.
    expect(switchTo).toHaveBeenCalledWith({ branch: "dev" }, "bring");
  });

  it("does nothing when the current branch is picked", () => {
    const { switchTo } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "main, current branch" }));
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("creates a tracking branch for a remote-only pick", () => {
    const { switchTo } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Check out origin/colleague" }));
    expect(switchTo).toHaveBeenCalledWith(
      { branch: "colleague", track: "origin/colleague" },
      "bring",
    );
  });

  it("asks what to do with uncommitted changes, counting both groups", () => {
    const { switchTo } = setup(
      {},
      {
        staged: [{ path: "a.ts", status: "added" }],
        unstaged: [{ path: "b.ts", status: "modified" }],
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to dev" }));

    expect(switchTo).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /uncommitted changes/i })).toBeInTheDocument();
    expect(screen.getByText(/2 changes that are not committed to main/)).toBeInTheDocument();
  });

  it("passes the chosen policy through", () => {
    const { switchTo } = setup({}, { unstaged: [{ path: "b.ts", status: "modified" }] });
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave my changes on main" }));
    expect(switchTo).toHaveBeenCalledWith({ branch: "dev" }, "leave");
  });

  it("cancelling the dirty prompt switches nothing", () => {
    const { switchTo } = setup({}, { unstaged: [{ path: "b.ts", status: "modified" }] });
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(switchTo).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("BranchStatus branch management", () => {
  it("creates a branch from the dialog", async () => {
    const { createBranch } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: /New branch/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "feature/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() => expect(createBranch).toHaveBeenCalledWith("feature/x", "main"));
  });

  it("renames the current branch", async () => {
    const { renameBranch } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for main" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "trunk" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(renameBranch).toHaveBeenCalledWith("main", "trunk"));
  });

  it("deletes a branch without force on the first attempt", async () => {
    const { deleteBranch } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteBranch).toHaveBeenCalledWith("dev", false));
  });

  it("escalates to a force confirm when git refuses an unmerged branch", async () => {
    const actions = setup();
    // git refuses, and the store records why.
    actions.deleteBranch.mockImplementation(() => {
      useGitStore.setState({
        opError: {
          title: "Could not delete dev",
          detail: "error: the branch 'dev' is not fully merged",
          command: "",
        },
      });
      return Promise.resolve(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // The confirm-anyway variant, showing git's own reason — and the raw error
    // dialog is dismissed so the two do not stack.
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Delete dev anyway?" })).toBeInTheDocument(),
    );
    expect(screen.getByText(/not fully merged/)).toBeInTheDocument();
    expect(useGitStore.getState().opError).toBeNull();

    actions.deleteBranch.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(actions.deleteBranch).toHaveBeenLastCalledWith("dev", true));
  });
});

describe("BranchStatus notices and errors", () => {
  it("shows a notice and dismisses it when clicked", () => {
    setup();
    act(() => useGitStore.setState({ notice: "Changes stashed from main" }));
    const notice = screen.getByRole("button", { name: /Changes stashed from main/ });
    fireEvent.click(notice);
    expect(useGitStore.getState().notice).toBeNull();
  });

  it("opens the error dialog with git's stderr", () => {
    setup();
    act(() =>
      useGitStore.setState({
        opError: { title: "push failed", detail: "! [rejected] main -> main", command: "git push origin main" },
      }),
    );
    expect(screen.getByRole("dialog", { name: "push failed" })).toBeInTheDocument();
    expect(screen.getByText("! [rejected] main -> main")).toBeInTheDocument();
  });

  it("counts a conflict as a pending change when switching away", () => {
    // Conflicts became their own group in Part 6; leaving them out of the count
    // made a conflicted repo look clean, so a switch skipped the prompt and went
    // straight to git, which refuses it.
    const { switchTo } = setup();
    act(() =>
      useGitStore.setState({ conflicts: [{ path: "a.ts", kind: "bothModified" }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to dev" }));

    expect(screen.getByRole("dialog", { name: /uncommitted changes/i })).toBeInTheDocument();
    expect(screen.getByText(/1 change that is not committed/i)).toBeInTheDocument();
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("confirms a merge from the branch menu before running it", () => {
    const { mergeBranch } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge into main…" }));

    // The dialog spells out the direction, which is the part people get wrong.
    expect(screen.getByRole("dialog", { name: "Merge dev into main?" })).toBeInTheDocument();
    expect(mergeBranch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(mergeBranch).toHaveBeenCalledWith("dev");
  });

  it("does not merge when the confirm is cancelled", () => {
    const { mergeBranch } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge into main…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("blocks the merge entries while something else is in progress", () => {
    // git would refuse anyway, but a disabled entry saying why beats a modal
    // full of git's refusal.
    setup();
    act(() =>
      useGitStore.setState({ mergeState: { kind: "merge", mergingRef: "feature" } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for dev" }));

    const merge = screen.getByRole("button", { name: "Merge into main…" });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("title", "Finish or abort the operation in progress first");
  });

  it("blocks the merge entries in a repo with no commits", () => {
    setup({ unborn: true, locals: [{ name: "main", committerDate: 1, headShort: "" }] });
    fireEvent.click(screen.getByRole("button", { name: "Current branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for main" }));

    // "You are on it" wins over the unborn reason for this row; either way it is
    // disabled with a reason, which is the invariant that matters.
    expect(screen.getByRole("button", { name: "Merge into main…" })).toBeDisabled();
  });

  it("queues the command in the bottom terminal and reveals it on retry", () => {
    setup();
    act(() => useLayoutStore.getState().setBottomTerminalVisible(false));
    act(() =>
      useGitStore.setState({
        opError: { title: "push failed", detail: "denied", command: "git push origin main" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry in terminal" }));

    const layout = useLayoutStore.getState();
    expect(layout.pendingShellCommand).toBe("git push origin main");
    expect(layout.bottomTerminalVisible).toBe(true);
    expect(layout.bottomTerminalAutoFocus).toBe(true);
    // And the dialog is out of the way so the terminal is usable.
    expect(useGitStore.getState().opError).toBeNull();
  });
});
