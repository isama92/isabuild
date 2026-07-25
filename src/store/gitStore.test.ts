import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initialGitState, useGitStore } from "./gitStore";
import type { BranchState } from "../lib/gitBranch";
import { mergeState } from "../test/factories";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const EMPTY_STATUS = { repoRoot: "/repo", staged: [], unstaged: [], conflicts: [] };

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
    locals: [{ name: "main", upstream: "origin/main", committerDate: 1, headShort: "aaa" }],
    remotes: [],
    ...overrides,
  };
}

/** Route each invoke by command name, the ptySession.test.ts pattern. */
function routeInvokes(routes: Record<string, unknown>) {
  invokeMock.mockImplementation((command: string) => {
    if (!(command in routes)) return Promise.resolve(undefined);
    const value = routes[command];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
}

/** Handlers for the streamed op events, so a test can drive an op to its end. */
let handlers: Map<string, (event: { event: string; id: number; payload: unknown }) => void>;

function fire(name: string, payload: unknown) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`nothing is listening to ${name}`);
  handler({ event: name, id: 0, payload });
}

/** Let queued microtasks and timers run, as useRepoWatch.test.tsx does. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait until the store is tracking a running op.
 *
 * `runOp` awaits two `listen` calls and the `invoke` before it can record the
 * op, so polling beats counting microtask turns — a change to that sequence
 * would silently break a hand-counted flush.
 */
async function startedOp() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const op = useGitStore.getState().op;
    if (op) return op;
    await tick();
  }
  throw new Error("no op was started");
}

/** Settle the op the store is currently holding. */
async function finishCurrentOp(payload: {
  exitCode: number;
  output: string;
  cancelled: boolean;
}) {
  const op = await startedOp();
  fire(`git://done/${op.id}`, payload);
}

beforeEach(() => {
  useGitStore.setState(initialGitState);
  handlers = new Map();
  listenMock.mockImplementation((name, handler) => {
    handlers.set(name, handler as (event: { event: string; id: number; payload: unknown }) => void);
    return Promise.resolve(vi.fn());
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("gitStore.refresh", () => {
  it("populates groups and repoRoot on success", async () => {
    invokeMock.mockResolvedValue({
      repoRoot: "/repo",
      staged: [{ path: "a.ts", status: "added" }],
      unstaged: [{ path: "b.ts", status: "modified" }],
    });

    await useGitStore.getState().refresh();

    const s = useGitStore.getState();
    expect(s.phase).toBe("ready");
    expect(s.repoRoot).toBe("/repo");
    expect(s.staged).toHaveLength(1);
    expect(s.unstaged).toHaveLength(1);
    expect(s.error).toBeNull();
  });

  it("resolves from cwd on the first call, then reuses the resolved root", async () => {
    invokeMock.mockResolvedValue({ repoRoot: "/repo", staged: [], unstaged: [] });

    await useGitStore.getState().refresh();
    expect(invokeMock).toHaveBeenLastCalledWith("git_status", { path: null });

    await useGitStore.getState().refresh();
    expect(invokeMock).toHaveBeenLastCalledWith("git_status", { path: "/repo" });
  });

  it("records an error without throwing when git_status rejects", async () => {
    invokeMock.mockRejectedValue(new Error("'/x' is not inside a git repository"));

    await expect(useGitStore.getState().refresh()).resolves.toBeUndefined();

    const s = useGitStore.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/not inside a git repository/);
  });
});

describe("gitStore.refreshBranch", () => {
  it("stores the branch state once a repo root is known", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({ git_branch_state: branchState({ ahead: 2, behind: 1 }) });

    await useGitStore.getState().refreshBranch();

    expect(invokeMock).toHaveBeenCalledWith("git_branch_state", { repoRoot: "/repo" });
    expect(useGitStore.getState().branch).toMatchObject({ ahead: 2, behind: 1 });
  });

  it("does nothing before the repo root is resolved", async () => {
    await useGitStore.getState().refreshBranch();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useGitStore.getState().branch).toBeNull();
  });

  it("keeps the last known state when the read fails", async () => {
    // Blanking the status bar on a transient read failure only loses
    // information; the Status panel already reports "not a repository".
    const known = branchState({ ahead: 5 });
    useGitStore.setState({ repoRoot: "/repo", branch: known });
    routeInvokes({ git_branch_state: new Error("boom") });

    await expect(useGitStore.getState().refreshBranch()).resolves.toBeUndefined();

    expect(useGitStore.getState().branch).toBe(known);
  });
});

describe("gitStore.refreshAll", () => {
  it("reads status, branch state and merge state together", async () => {
    routeInvokes({
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
      git_merge_state: mergeState("none"),
    });
    await useGitStore.getState().refreshAll();
    expect(invokeMock).toHaveBeenCalledWith("git_status", { path: null });
    expect(invokeMock).toHaveBeenCalledWith("git_branch_state", { repoRoot: "/repo" });
    expect(invokeMock).toHaveBeenCalledWith("git_merge_state", { repoRoot: "/repo" });
  });

  it("keeps the conflicts group from the status read", async () => {
    routeInvokes({
      git_status: {
        ...EMPTY_STATUS,
        conflicts: [{ path: "a.ts", kind: "bothModified" }],
      },
      git_branch_state: branchState(),
      git_merge_state: mergeState("merge", { mergingRef: "feature" }),
    });
    await useGitStore.getState().refreshAll();
    expect(useGitStore.getState().conflicts).toEqual([{ path: "a.ts", kind: "bothModified" }]);
    expect(useGitStore.getState().mergeState).toEqual(
      mergeState("merge", { mergingRef: "feature" }),
    );
  });

  it("keeps the last known merge state when the read fails", async () => {
    // A banner that vanishes mid-merge is worse than a stale one: it is the only
    // route to Continue and Abort.
    useGitStore.setState({
      repoRoot: "/repo",
      mergeState: mergeState("merge", { mergingRef: "feature" }),
    });
    routeInvokes({
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
      git_merge_state: new Error("index.lock exists"),
    });
    await useGitStore.getState().refreshAll();
    expect(useGitStore.getState().mergeState).toEqual(
      mergeState("merge", { mergingRef: "feature" }),
    );
  });

  it("skips both reads while an operation is running", async () => {
    // A fetch writes inside .git for its whole duration, re-firing the watcher's
    // debounce repeatedly; reading mid-flight is wasted work against a repo that
    // is being written to. runOp does one read at the end instead.
    useGitStore.setState({ repoRoot: "/repo", op: { id: "fetch-1", kind: "fetch", progress: "" } });
    await useGitStore.getState().refreshAll();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("gitStore.switchTo", () => {
  it("reports a stash left behind and a restore as a notice", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({
      git_switch_branch: { branch: "dev", stashedFrom: "main", restored: true, warnings: [] },
      git_status: EMPTY_STATUS,
      git_branch_state: branchState({ current: "dev" }),
    });

    await expect(useGitStore.getState().switchTo({ branch: "dev" }, "leave")).resolves.toBe(true);

    expect(useGitStore.getState().notice).toBe(
      "Changes stashed from main. Restored changes stashed on dev",
    );
    expect(useGitStore.getState().opError).toBeNull();
  });

  it("routes warnings to the modal, not the status bar", async () => {
    // A stash that would not reapply leaves conflict markers in the tree. That
    // is far too important for an ellipsised one-liner in a 24px bar.
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({
      git_switch_branch: {
        branch: "dev",
        stashedFrom: null,
        restored: false,
        warnings: ["changes stashed for 'dev' could not be restored"],
      },
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
    });

    await expect(useGitStore.getState().switchTo({ branch: "dev" }, "bring")).resolves.toBe(true);

    const dialog = useGitStore.getState().opError;
    expect(dialog?.title).toMatch(/Switched to dev/);
    expect(dialog?.detail).toMatch(/could not be restored/);
    // No command: there is nothing to re-run in a terminal.
    expect(dialog?.command).toBe("");
    expect(useGitStore.getState().notice).toBeNull();
  });

  it("keeps routine stash facts in the status bar with no modal", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({
      git_switch_branch: { branch: "dev", stashedFrom: "main", restored: false, warnings: [] },
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
    });

    await useGitStore.getState().switchTo({ branch: "dev" }, "leave");

    expect(useGitStore.getState().notice).toBe("Changes stashed from main");
    expect(useGitStore.getState().opError).toBeNull();
  });

  it("leaves no notice when nothing noteworthy happened", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({
      git_switch_branch: { branch: "dev", stashedFrom: null, restored: false, warnings: [] },
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
    });

    await useGitStore.getState().switchTo({ branch: "dev" }, "bring");

    expect(useGitStore.getState().notice).toBeNull();
  });

  it("turns git's refusal into an opError and reports failure", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({
      git_switch_branch: new Error(
        "git exited with an error: error: Your local changes would be overwritten",
      ),
    });

    await expect(useGitStore.getState().switchTo({ branch: "dev" }, "bring")).resolves.toBe(false);

    const error = useGitStore.getState().opError;
    expect(error?.title).toBe("Could not switch to dev");
    expect(error?.detail).toMatch(/would be overwritten/);
    // No command: a switch is not something we offer to retry in the terminal.
    expect(error?.command).toBe("");
  });
});

describe("gitStore branch mutations", () => {
  it("createBranch passes the base through and refreshes afterwards", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({ git_status: EMPTY_STATUS, git_branch_state: branchState() });

    await expect(useGitStore.getState().createBranch("feature", "main")).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("git_create_branch", {
      repoRoot: "/repo",
      name: "feature",
      base: "main",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_branch_state", { repoRoot: "/repo" });
  });

  it("deleteBranch reports git's refusal so the caller can escalate to force", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({ git_delete_branch: new Error("error: the branch 'doomed' is not fully merged") });

    await expect(useGitStore.getState().deleteBranch("doomed", false)).resolves.toBe(false);

    expect(useGitStore.getState().opError?.detail).toMatch(/not fully merged/);
  });

  it("renameBranch sends both names", async () => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({ git_status: EMPTY_STATUS, git_branch_state: branchState() });

    await useGitStore.getState().renameBranch("old", "new");

    expect(invokeMock).toHaveBeenCalledWith("git_rename_branch", {
      repoRoot: "/repo",
      from: "old",
      to: "new",
    });
  });
});

describe("gitStore.runOp", () => {
  beforeEach(() => {
    useGitStore.setState({ repoRoot: "/repo" });
    routeInvokes({ git_status: EMPTY_STATUS, git_branch_state: branchState() });
  });

  it("tracks the running op and clears it when it finishes", async () => {
    const pending = useGitStore.getState().runOp({ kind: "fetch", remote: "origin" });

    expect(await startedOp()).toMatchObject({ kind: "fetch", progress: "" });

    await finishCurrentOp({ exitCode: 0, output: "", cancelled: false });
    await expect(pending).resolves.toBe(true);
    expect(useGitStore.getState().op).toBeNull();
    expect(useGitStore.getState().opError).toBeNull();
  });

  it("shows git's latest progress line while it runs", async () => {
    const pending = useGitStore.getState().runOp({ kind: "fetch", remote: "origin" });
    const op = await startedOp();

    fire(`git://progress/${op.id}`, "Receiving objects:  50% (1/2)");
    expect(useGitStore.getState().op?.progress).toBe("Receiving objects:  50% (1/2)");
    fire(`git://progress/${op.id}`, "Resolving deltas: 100%");
    expect(useGitStore.getState().op?.progress).toBe("Resolving deltas: 100%");

    await finishCurrentOp({ exitCode: 0, output: "", cancelled: false });
    await pending;
  });

  it("records the op before the first listener, so no early line has nowhere to land", async () => {
    // runOp used to set `op` only after runRemoteOp resolved, which discarded any
    // progress line from an op that narrated itself immediately.
    const pending = useGitStore.getState().runOp({ kind: "fetch", remote: "origin" });
    // Synchronously after the call, before any await has settled.
    expect(useGitStore.getState().op).toMatchObject({ kind: "fetch", progress: "" });

    await finishCurrentOp({ exitCode: 0, output: "", cancelled: false });
    await pending;
  });

  it("ignores a progress line belonging to a different op", async () => {
    // After a cancel the backend reader may still drain its pipe, so a late line
    // must not be written into the op that replaced it.
    const pending = useGitStore.getState().runOp({ kind: "fetch", remote: "origin" });
    const op = await startedOp();
    fire(`git://progress/${op.id}`, "real line");
    expect(useGitStore.getState().op?.progress).toBe("real line");

    // Pretend a newer op took over the slot, then replay the old op's handler.
    useGitStore.setState({ op: { id: "pull-99", kind: "pull", progress: "newer" } });
    fire(`git://progress/${op.id}`, "stale line from the cancelled fetch");
    expect(useGitStore.getState().op?.progress).toBe("newer");

    // Put the real op back so the pending promise can settle.
    useGitStore.setState({ op });
    await finishCurrentOp({ exitCode: 0, output: "", cancelled: false });
    await pending;
  });

  it("turns a non-zero exit into an opError carrying git's stderr and command", async () => {
    const pending = useGitStore
      .getState()
      .runOp({ kind: "push", remote: "origin", branch: "main" });

    await finishCurrentOp({
      exitCode: 1,
      output: "! [rejected] main -> main (fetch first)",
      cancelled: false,
    });
    await expect(pending).resolves.toBe(false);

    const error = useGitStore.getState().opError;
    expect(error?.title).toBe("push failed");
    expect(error?.detail).toBe("! [rejected] main -> main (fetch first)");
    // Present, so the dialog can offer "Retry in terminal".
    expect(error?.command).toBe("git push origin main");
  });

  it("reports a cancellation as a notice, not an error", async () => {
    const pending = useGitStore.getState().runOp({ kind: "fetch", remote: "origin" });

    await finishCurrentOp({ exitCode: -1, output: "", cancelled: true });
    await expect(pending).resolves.toBe(false);

    expect(useGitStore.getState().opError).toBeNull();
    expect(useGitStore.getState().notice).toBe("fetch cancelled");
  });

  it("refreshes even after a failure, because refs may still have moved", async () => {
    const pending = useGitStore.getState().runOp({ kind: "fetch", remote: "origin" });
    await startedOp();
    invokeMock.mockClear();

    await finishCurrentOp({ exitCode: 1, output: "fatal: could not read", cancelled: false });
    await pending;

    expect(invokeMock).toHaveBeenCalledWith("git_branch_state", { repoRoot: "/repo" });
  });

  it("refuses a second op while one is running", async () => {
    const first = useGitStore.getState().runOp({ kind: "fetch", remote: "origin" });
    await startedOp();

    await expect(useGitStore.getState().runOp({ kind: "pull", remote: "origin" })).resolves.toBe(
      false,
    );

    await finishCurrentOp({ exitCode: 0, output: "", cancelled: false });
    await first;
  });

  it("does nothing without a repo root", async () => {
    useGitStore.setState({ repoRoot: null });
    await expect(useGitStore.getState().runOp({ kind: "fetch", remote: "origin" })).resolves.toBe(
      false,
    );
    expect(useGitStore.getState().op).toBeNull();
  });

  it("records an opError when the op cannot even be started", async () => {
    routeInvokes({ git_remote_op: new Error("another git operation (switch-1) is still running") });

    await expect(useGitStore.getState().runOp({ kind: "fetch", remote: "origin" })).resolves.toBe(
      false,
    );

    expect(useGitStore.getState().op).toBeNull();
    expect(useGitStore.getState().opError?.title).toBe("Could not start fetch");
    expect(useGitStore.getState().opError?.detail).toMatch(/still running/);
  });
});

describe("gitStore.cancelOp", () => {
  it("cancels the running op by id", async () => {
    useGitStore.setState({
      repoRoot: "/repo",
      op: { id: "fetch-7", kind: "fetch", progress: "" },
    });
    routeInvokes({});

    await useGitStore.getState().cancelOp();

    expect(invokeMock).toHaveBeenCalledWith("git_cancel_op", { opId: "fetch-7" });
  });

  it("does nothing when no op is running", async () => {
    await useGitStore.getState().cancelOp();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("swallows a cancel failure, since the terminal event settles the op anyway", async () => {
    useGitStore.setState({ op: { id: "fetch-7", kind: "fetch", progress: "" } });
    routeInvokes({ git_cancel_op: new Error("unknown op") });
    await expect(useGitStore.getState().cancelOp()).resolves.toBeUndefined();
  });
});

describe("gitStore merge actions", () => {
  beforeEach(() => {
    // A merge in progress by default. `concludeOp` reads the kind to *name* what
    // happened, and the banner is the only way to reach it — so it can never be
    // called with nothing in progress.
    useGitStore.setState({
      repoRoot: "/repo",
      mergeState: mergeState("merge", { mergingRef: "feature" }),
    });
  });

  it("merges a ref and reports success", async () => {
    routeInvokes({
      git_merge: { conflicted: false, output: "Fast-forward" },
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
      git_merge_state: mergeState("none"),
    });

    await expect(useGitStore.getState().mergeBranch("feature")).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("git_merge", {
      repoRoot: "/repo",
      reference: "feature",
    });
    expect(useGitStore.getState().notice).toBe("Merged feature");
    expect(useGitStore.getState().opError).toBeNull();
  });

  it("reports a conflicted merge as a notice and never a modal", async () => {
    // Stopping on a conflict is the outcome this whole part is about; a dialog on
    // top of the banner and the Conflicts group would only be in the way.
    routeInvokes({
      git_merge: { conflicted: true, output: "CONFLICT (content): Merge conflict in a.ts" },
      git_status: { ...EMPTY_STATUS, conflicts: [{ path: "a.ts", kind: "bothModified" }] },
      git_branch_state: branchState(),
      git_merge_state: mergeState("merge", { mergingRef: "feature" }),
    });

    await expect(useGitStore.getState().mergeBranch("feature")).resolves.toBe(false);

    expect(useGitStore.getState().opError).toBeNull();
    expect(useGitStore.getState().notice).toMatch(/stopped on conflicts/i);
    expect(useGitStore.getState().conflicts).toHaveLength(1);
  });

  it("turns a refused merge into an opError with a retryable command", async () => {
    routeInvokes({ git_merge: new Error("Your local changes would be overwritten") });

    await expect(useGitStore.getState().mergeBranch("feature")).resolves.toBe(false);

    const error = useGitStore.getState().opError;
    expect(error?.title).toBe("Could not merge feature");
    expect(error?.detail).toMatch(/would be overwritten/);
    expect(error?.command).toBe("git merge feature");
  });

  it("continues the merge and notes it", async () => {
    routeInvokes({
      git_op: undefined,
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
      git_merge_state: mergeState("none"),
    });

    await expect(useGitStore.getState().concludeOp("continue")).resolves.toBe(true);

    // Only the action goes down the wire; the backend derives the argv.
    expect(invokeMock).toHaveBeenCalledWith("git_op", {
      repoRoot: "/repo",
      action: "continue",
    });
    expect(useGitStore.getState().notice).toBe("Merge committed");
  });

  it("reports git's refusal to continue, with the command to retry", async () => {
    routeInvokes({ git_op: new Error("You have unmerged files") });

    await expect(useGitStore.getState().concludeOp("continue")).resolves.toBe(false);

    expect(useGitStore.getState().opError?.detail).toMatch(/unmerged files/);
    expect(useGitStore.getState().opError?.command).toBe("git merge --continue");
    expect(useGitStore.getState().notice).toBeNull();
  });

  it("names the failure after whatever is actually in progress", async () => {
    // The kind never chooses the command, but it does choose the words — and
    // "Could not continue the merge" during a rebase would be a lie.
    useGitStore.setState({ mergeState: mergeState("rebase", { mergingRef: "feature" }) });
    routeInvokes({ git_op: new Error("could not apply abc123") });

    await expect(useGitStore.getState().concludeOp("continue")).resolves.toBe(false);

    expect(useGitStore.getState().opError?.title).toMatch(/continue the rebase/i);
    expect(useGitStore.getState().opError?.command).toBe("git rebase --continue");
  });

  it("skips a commit and notes what happened to it", async () => {
    useGitStore.setState({ mergeState: mergeState("rebase", { mergingRef: "feature" }) });
    routeInvokes({
      git_op: undefined,
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
      git_merge_state: mergeState("none"),
    });

    await expect(useGitStore.getState().concludeOp("skip")).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("git_op", { repoRoot: "/repo", action: "skip" });
    expect(useGitStore.getState().notice).toBe("Skipped that commit");
  });

  it("aborts the merge and notes it", async () => {
    routeInvokes({
      git_op: undefined,
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
      git_merge_state: mergeState("none"),
    });

    await expect(useGitStore.getState().concludeOp("abort")).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("git_op", { repoRoot: "/repo", action: "abort" });
    expect(useGitStore.getState().notice).toBe("Aborted the merge");
  });

  it("resolves a whole path and refreshes", async () => {
    routeInvokes({
      git_resolve_path: undefined,
      git_status: EMPTY_STATUS,
      git_branch_state: branchState(),
      git_merge_state: mergeState("none"),
    });

    await expect(
      useGitStore.getState().resolveConflictPath("gone.ts", "acceptDeletion"),
    ).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("git_resolve_path", {
      repoRoot: "/repo",
      path: "gone.ts",
      resolution: "acceptDeletion",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_status", { path: "/repo" });
  });

  it("reports a failed path resolution without wedging", async () => {
    routeInvokes({ git_resolve_path: new Error("pathspec did not match") });

    await expect(useGitStore.getState().resolveConflictPath("gone.ts", "keepTheirs")).resolves.toBe(
      false,
    );

    expect(useGitStore.getState().opError?.title).toBe("Could not resolve gone.ts");
  });
});

describe("gitStore dismissals", () => {
  it("clears the error and the notice independently", () => {
    useGitStore.setState({
      opError: { title: "t", detail: "d", command: "" },
      notice: "something",
    });

    useGitStore.getState().dismissOpError();
    expect(useGitStore.getState().opError).toBeNull();
    expect(useGitStore.getState().notice).toBe("something");

    useGitStore.getState().dismissNotice();
    expect(useGitStore.getState().notice).toBeNull();
  });
});
