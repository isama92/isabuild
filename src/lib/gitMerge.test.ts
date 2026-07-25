import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  abortMerge,
  continueMerge,
  getConflictFile,
  getMergeState,
  mergeRef,
  parseMergeParams,
  resolveConflict,
  resolvePath,
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

  it("reads one conflicted file", async () => {
    invokeMock.mockResolvedValue({
      path: "a.ts",
      lines: [],
      blocks: [],
      revision: "abc",
      binary: false,
    });
    await getConflictFile("/repo", "a.ts");
    expect(invokeMock).toHaveBeenCalledWith("git_conflict_file", {
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

  it("continues and aborts with only the repo root", async () => {
    invokeMock.mockResolvedValue(undefined);
    await continueMerge("/repo");
    expect(invokeMock).toHaveBeenCalledWith("git_merge_continue", { repoRoot: "/repo" });
    await abortMerge("/repo");
    expect(invokeMock).toHaveBeenCalledWith("git_merge_abort", { repoRoot: "/repo" });
  });

  it("sends the revision along with a per-conflict choice", async () => {
    // The revision is the guard against resolving a hunk that has moved; losing
    // it here would defeat the whole check.
    invokeMock.mockResolvedValue({ remaining: 0, staged: true });
    await resolveConflict("/repo", "a.ts", 2, "both", "deadbeef");
    expect(invokeMock).toHaveBeenCalledWith("git_resolve_conflict", {
      repoRoot: "/repo",
      path: "a.ts",
      index: 2,
      choice: "both",
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
    await expect(resolveConflict("/repo", "a.ts", 0, "ours", "stale")).rejects.toThrow(
      /changed on disk/,
    );
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
