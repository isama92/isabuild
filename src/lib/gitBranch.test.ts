import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  createBranch,
  deleteBranch,
  getBranchState,
  renameBranch,
  switchBranch,
  validateBranchName,
} from "./gitBranch";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

afterEach(() => {
  vi.clearAllMocks();
});

describe("gitBranch lib", () => {
  it("getBranchState invokes git_branch_state with the repo root", async () => {
    invokeMock.mockResolvedValue({});
    await getBranchState("/r");
    expect(invokeMock).toHaveBeenCalledWith("git_branch_state", { repoRoot: "/r" });
  });

  it("switchBranch sends a local target with an explicit null track", async () => {
    // Explicitly null, not absent: serde maps it onto Option<String> either way,
    // but sending the field keeps the payload shape stable.
    invokeMock.mockResolvedValue({ branch: "main", stashedFrom: null, restored: false, warnings: [] });
    await switchBranch("/r", { branch: "main" }, "bring");
    expect(invokeMock).toHaveBeenCalledWith("git_switch_branch", {
      repoRoot: "/r",
      target: { branch: "main", track: null },
      policy: "bring",
    });
  });

  it("switchBranch passes the remote ref through for a tracking checkout", async () => {
    invokeMock.mockResolvedValue({ branch: "x", stashedFrom: null, restored: false, warnings: [] });
    await switchBranch("/r", { branch: "x", track: "origin/x" }, "leave");
    expect(invokeMock).toHaveBeenCalledWith("git_switch_branch", {
      repoRoot: "/r",
      target: { branch: "x", track: "origin/x" },
      policy: "leave",
    });
  });

  it("createBranch passes the base, or null when there is none", async () => {
    invokeMock.mockResolvedValue(undefined);
    await createBranch("/r", "feature", "main");
    expect(invokeMock).toHaveBeenLastCalledWith("git_create_branch", {
      repoRoot: "/r",
      name: "feature",
      base: "main",
    });

    await createBranch("/r", "feature");
    expect(invokeMock).toHaveBeenLastCalledWith("git_create_branch", {
      repoRoot: "/r",
      name: "feature",
      base: null,
    });
  });

  it("deleteBranch forwards the force flag", async () => {
    invokeMock.mockResolvedValue(undefined);
    await deleteBranch("/r", "doomed", true);
    expect(invokeMock).toHaveBeenCalledWith("git_delete_branch", {
      repoRoot: "/r",
      name: "doomed",
      force: true,
    });
  });

  it("renameBranch sends both names", async () => {
    invokeMock.mockResolvedValue(undefined);
    await renameBranch("/r", "old", "new");
    expect(invokeMock).toHaveBeenCalledWith("git_rename_branch", {
      repoRoot: "/r",
      from: "old",
      to: "new",
    });
  });

  it("validateBranchName resolves with the reason, or null when usable", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(validateBranchName("/r", "ok")).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("git_validate_branch_name", {
      repoRoot: "/r",
      name: "ok",
    });

    invokeMock.mockResolvedValue("a branch named 'main' already exists");
    await expect(validateBranchName("/r", "main")).resolves.toMatch(/already exists/);
  });
});
