import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getFileDiff, parseDiffParams, writeWorkingFile, type FileDiff } from "./diffSource";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const diff: FileDiff = {
  path: "src/a.ts",
  origPath: null,
  headSha: "abc1234",
  left: "one\n",
  right: "two\n",
  binary: false,
  eol: "lf",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("diffSource lib", () => {
  it("getFileDiff invokes git_file_diff with the target", async () => {
    invokeMock.mockResolvedValue(diff);
    await getFileDiff({ repoRoot: "/r", path: "src/a.ts" });
    expect(invokeMock).toHaveBeenCalledWith("git_file_diff", {
      repoRoot: "/r",
      path: "src/a.ts",
      origPath: null,
    });
  });

  it("getFileDiff passes the rename origin when there is one", async () => {
    invokeMock.mockResolvedValue(diff);
    await getFileDiff({ repoRoot: "/r", path: "new.ts", origPath: "old.ts" });
    expect(invokeMock).toHaveBeenCalledWith("git_file_diff", {
      repoRoot: "/r",
      path: "new.ts",
      origPath: "old.ts",
    });
  });

  it("writeWorkingFile invokes write_working_file with the content and eol", async () => {
    invokeMock.mockResolvedValue(undefined);
    await writeWorkingFile({ repoRoot: "/r", path: "src/a.ts" }, "edited\n", "crlf");
    expect(invokeMock).toHaveBeenCalledWith("write_working_file", {
      repoRoot: "/r",
      path: "src/a.ts",
      content: "edited\n",
      eol: "crlf",
    });
  });

  it("parses repo, path and rename origin out of the query string", () => {
    expect(
      parseDiffParams("?repo=%2Fhome%2Fdev%2Frepo&path=src%2Fa%20b.ts&orig=src%2Fold.ts"),
    ).toEqual({
      repoRoot: "/home/dev/repo",
      path: "src/a b.ts",
      origPath: "src/old.ts",
    });
  });

  it("leaves the rename origin undefined when absent", () => {
    expect(parseDiffParams("?repo=/r&path=a.ts")).toEqual({
      repoRoot: "/r",
      path: "a.ts",
      origPath: undefined,
    });
  });

  it("throws when the window was opened without a repo or path", () => {
    expect(() => parseDiffParams("")).toThrow(/without a repository and file path/);
    expect(() => parseDiffParams("?repo=/r")).toThrow(/without a repository and file path/);
    expect(() => parseDiffParams("?path=a.ts")).toThrow(/without a repository and file path/);
  });
});
