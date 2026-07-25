import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  getConflictStages,
  getMergeState,
  mergeRef,
  opCommand,
  opFailureTitle,
  opFamily,
  opSuccessNotice,
  parseMergeParams,
  resolvePath,
  runOp,
  writeResolved,
  type MergeKind,
} from "./gitMerge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

afterEach(() => {
  vi.clearAllMocks();
});

describe("gitMerge lib", () => {
  it("reads the merge state for a repo", async () => {
    invokeMock.mockResolvedValue({ kind: "none", mergingRef: null });
    await getMergeState("/repo");
    expect(invokeMock).toHaveBeenCalledWith("git_merge_state", { repoRoot: "/repo" });
  });

  it("reads the index stages of one conflicted file", async () => {
    invokeMock.mockResolvedValue({
      path: "a.ts",
      base: [],
      ours: [],
      theirs: [],
      stages: [1, 2, 3],
      chunks: [],
      result: "",
      disk: "",
      oursLabel: "HEAD",
      theirsLabel: "feature",
      revision: "abc",
      diverged: false,
      binary: false,
    });
    await getConflictStages("/repo", "a.ts");
    expect(invokeMock).toHaveBeenCalledWith("git_conflict_stages", {
      repoRoot: "/repo",
      path: "a.ts",
    });
  });

  it("merges a ref by name", async () => {
    invokeMock.mockResolvedValue({ conflicted: false, output: "" });
    await mergeRef("/repo", "feature");
    expect(invokeMock).toHaveBeenCalledWith("git_merge", {
      repoRoot: "/repo",
      reference: "feature",
    });
  });

  it("passes a remote-tracking ref through unchanged", async () => {
    // `git merge origin/main` is an everyday thing to want and needs no local
    // branch, so the ref must not be rewritten on the way down.
    invokeMock.mockResolvedValue({ conflicted: false, output: "" });
    await mergeRef("/repo", "origin/main");
    expect(invokeMock).toHaveBeenCalledWith("git_merge", {
      repoRoot: "/repo",
      reference: "origin/main",
    });
  });

  it("sends only the action, never a command family", async () => {
    // The whole point of the single `git_op` command: the backend reads the state
    // and picks the argv, so a stale frontend cannot send `rebase --abort` at a
    // merge.
    invokeMock.mockResolvedValue(undefined);
    for (const action of ["continue", "skip", "abort"] as const) {
      await runOp("/repo", action);
      expect(invokeMock).toHaveBeenCalledWith("git_op", { repoRoot: "/repo", action });
    }
  });

  it("sends the revision along with a resolved file", async () => {
    // The revision is the guard against writing over a file that has moved; losing
    // it here would defeat the whole check.
    invokeMock.mockResolvedValue({ remaining: 0, staged: true });
    await writeResolved("/repo", "a.ts", "resolved\n", "deadbeef");
    expect(invokeMock).toHaveBeenCalledWith("git_write_resolved", {
      repoRoot: "/repo",
      path: "a.ts",
      text: "resolved\n",
      revision: "deadbeef",
    });
  });

  it("resolves a whole path", async () => {
    invokeMock.mockResolvedValue(undefined);
    await resolvePath("/repo", "gone.ts", "acceptDeletion");
    expect(invokeMock).toHaveBeenCalledWith("git_resolve_path", {
      repoRoot: "/repo",
      path: "gone.ts",
      resolution: "acceptDeletion",
    });
  });

  it("propagates a backend rejection rather than swallowing it", async () => {
    invokeMock.mockRejectedValue(new Error("'a.ts' changed on disk since it was read"));
    await expect(writeResolved("/repo", "a.ts", "x", "stale")).rejects.toThrow(/changed on disk/);
  });
});

describe("operation naming", () => {
  it("maps each kind to its git subcommand", () => {
    expect(opFamily("merge")).toBe("merge");
    expect(opFamily("rebase")).toBe("rebase");
    expect(opFamily("cherryPick")).toBe("cherry-pick");
    expect(opFamily("revert")).toBe("revert");
  });

  it("has no family for the states with nothing to conclude", () => {
    // A bare pile of conflicted paths is finished by resolving them, so the banner
    // must not offer a button at all.
    expect(opFamily("none")).toBeNull();
    expect(opFamily("conflictsOnly")).toBeNull();
  });

  it("builds the command a failure dialog offers to retry", () => {
    expect(opCommand("rebase", "continue")).toBe("git rebase --continue");
    expect(opCommand("cherryPick", "skip")).toBe("git cherry-pick --skip");
    expect(opCommand("conflictsOnly", "abort")).toBeNull();
  });

  it("names a failure after the operation that failed", () => {
    expect(opFailureTitle("rebase", "abort")).toMatch(/abort the rebase/i);
    expect(opFailureTitle("revert", "continue")).toMatch(/continue the revert/i);
  });

  it("says a merge was committed but a rebase was continued", () => {
    // A merge continue *is* the commit; the replaying families may have more
    // commits to go, so claiming they finished would be wrong.
    expect(opSuccessNotice("merge", "continue")).toBe("Merge committed");
    expect(opSuccessNotice("rebase", "continue")).toBe("Continued the rebase");
    expect(opSuccessNotice("cherryPick", "abort")).toBe("Aborted the cherry-pick");
    expect(opSuccessNotice("rebase", "skip")).toBe("Skipped that commit");
  });

  it("never produces an empty phrase for a state with no family", () => {
    // Only reachable from a stale state, and "Aborted the " reads as a bug.
    const kinds: MergeKind[] = ["none", "conflictsOnly"];
    for (const kind of kinds) {
      expect(opSuccessNotice(kind, "abort")).toBe("Aborted the operation");
      expect(opFailureTitle(kind, "continue")).toBe("Could not continue the operation");
    }
  });
});

describe("parseMergeParams", () => {
  it("reads the repo and path out of the window's query string", () => {
    expect(parseMergeParams("?repo=%2Frepo&path=src%2Fapp.ts")).toEqual({
      repoRoot: "/repo",
      path: "src/app.ts",
    });
  });

  it("throws when either half is missing", () => {
    // Only reachable by opening the document by hand; the window renders the
    // message rather than an empty pane.
    expect(() => parseMergeParams("")).toThrow(/without a repository and file path/);
    expect(() => parseMergeParams("?repo=%2Frepo")).toThrow(/without a repository/);
    expect(() => parseMergeParams("?path=a.ts")).toThrow(/without a repository/);
  });
});
