import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { initialGitState, useGitStore } from "./gitStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  useGitStore.setState(initialGitState);
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
