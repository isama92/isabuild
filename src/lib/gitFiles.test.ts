import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  commitPath,
  rollbackPath,
  shellPath,
  singleQuote,
  stagePath,
  unstagePath,
} from "./gitFiles";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("gitFiles", () => {
  it("stages a path, sending no origin when there is none", async () => {
    invokeMock.mockResolvedValue(undefined);
    await stagePath({ repoRoot: "/repo", path: "src/app.ts" });
    expect(invokeMock).toHaveBeenCalledWith("git_stage_path", {
      repoRoot: "/repo",
      path: "src/app.ts",
      origPath: null,
    });
  });

  it("passes the rename origin through, so both index entries are acted on", async () => {
    invokeMock.mockResolvedValue(undefined);
    await unstagePath({ repoRoot: "/repo", path: "new.ts", origPath: "old.ts" });
    expect(invokeMock).toHaveBeenCalledWith("git_unstage_path", {
      repoRoot: "/repo",
      path: "new.ts",
      origPath: "old.ts",
    });
  });

  it("rolls a path back", async () => {
    invokeMock.mockResolvedValue(undefined);
    await rollbackPath({ repoRoot: "/repo", path: "notes.md" });
    expect(invokeMock).toHaveBeenCalledWith("git_rollback_path", {
      repoRoot: "/repo",
      path: "notes.md",
      origPath: null,
    });
  });

  it("commits a path with its message and returns the sha", async () => {
    invokeMock.mockResolvedValue({ sha: "1a2b3c4" });
    const outcome = await commitPath({ repoRoot: "/repo", path: "src/app.ts" }, "fix the thing");
    expect(invokeMock).toHaveBeenCalledWith("git_commit_path", {
      repoRoot: "/repo",
      path: "src/app.ts",
      origPath: null,
      message: "fix the thing",
    });
    expect(outcome).toEqual({ sha: "1a2b3c4" });
  });

  it("propagates a backend rejection rather than swallowing it", async () => {
    invokeMock.mockRejectedValue(new Error("cannot do a partial commit during a merge"));
    await expect(commitPath({ repoRoot: "/repo", path: "a.ts" }, "nope")).rejects.toThrow(
      /partial commit/,
    );
  });
});

describe("singleQuote", () => {
  it("wraps a plain message", () => {
    expect(singleQuote("fix the thing")).toBe("'fix the thing'");
  });

  it("stops the shell expanding anything inside", () => {
    // A commit message is arbitrary user text; double quotes would let $HOME and
    // a backtick run.
    expect(singleQuote("cost $HOME `whoami`")).toBe("'cost $HOME `whoami`'");
  });

  it("escapes an embedded single quote by closing and reopening", () => {
    // A single quote cannot be escaped inside single quotes, so the string is
    // closed, an escaped quote emitted, and the string reopened.
    expect(singleQuote("don't")).toBe("'don'\\''t'");
  });

  it("keeps a multi-line message in one argument", () => {
    expect(singleQuote("subject\n\nbody")).toBe("'subject\n\nbody'");
  });
});

describe("shellPath", () => {
  it("leaves an ordinary path unquoted, so the command reads as typed", () => {
    expect(shellPath("app/Models/Order.php")).toBe("app/Models/Order.php");
    expect(shellPath("src/my-file_2.test.ts")).toBe("src/my-file_2.test.ts");
  });

  it("quotes a path the shell would split or expand", () => {
    expect(shellPath("my file.ts")).toBe("'my file.ts'");
    expect(shellPath("src/[id].tsx")).toBe("'src/[id].tsx'");
    expect(shellPath("weird'name.ts")).toBe("'weird'\\''name.ts'");
  });

  it("quotes a non-ASCII path rather than assuming the shell copes", () => {
    expect(shellPath("app/Modelle/Prämie.php")).toBe("'app/Modelle/Prämie.php'");
  });
});
