import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { diffWindowLabel } from "./diffWindow";
import { mergeWindowLabel, mergeWindowUrl, openMergeWindow } from "./mergeWindow";

// Same harness as diffWindow.test.ts: the constructor doubles as the creation
// call, so the mock records its args and fires the outcome we choose per test.
const created: { label: string; options: Record<string, unknown> }[] = [];
let outcome: "created" | "error" = "created";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  // A plain function, not an arrow: production code calls it with `new`.
  WebviewWindow: Object.assign(
    vi.fn(function (
      this: Record<string, unknown>,
      label: string,
      options: Record<string, unknown>,
    ) {
      created.push({ label, options });
      this.once = (event: string, handler: (payload: { payload: string }) => void) => {
        if (
          (outcome === "created" && event === "tauri://created") ||
          (outcome === "error" && event === "tauri://error")
        ) {
          handler({ payload: "window creation denied" });
        }
        return Promise.resolve(() => {});
      };
    }),
    { getByLabel: vi.fn() },
  ),
}));

const getByLabelMock = vi.mocked(WebviewWindow.getByLabel);

beforeEach(() => {
  created.length = 0;
  outcome = "created";
  getByLabelMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("mergeWindowLabel", () => {
  it("is stable for the same file and prefixed for the capability match", () => {
    const target = { repoRoot: "/repo", path: "src/app.ts" };
    expect(mergeWindowLabel(target)).toBe(mergeWindowLabel({ ...target }));
    // capabilities/merge.json matches `merge-*`; a label that lost the prefix
    // would open a window with no permission to close itself.
    expect(mergeWindowLabel(target).startsWith("merge-")).toBe(true);
  });

  it("differs per file and per repository", () => {
    expect(mergeWindowLabel({ repoRoot: "/repo", path: "a.ts" })).not.toBe(
      mergeWindowLabel({ repoRoot: "/repo", path: "b.ts" }),
    );
    // The same relative path exists in every checkout; focusing another repo's
    // window would resolve conflicts in the wrong file.
    expect(mergeWindowLabel({ repoRoot: "/one", path: "a.ts" })).not.toBe(
      mergeWindowLabel({ repoRoot: "/two", path: "a.ts" }),
    );
  });

  it("never collides with the diff window for the same file", () => {
    // Both windows can be open on one file at once, so their labels must differ
    // even though they hash the same identity.
    const target = { repoRoot: "/repo", path: "src/app.ts" };
    expect(mergeWindowLabel(target)).not.toBe(diffWindowLabel(target));
  });

  it("contains only characters Tauri accepts in a label", () => {
    const label = mergeWindowLabel({ repoRoot: "/repo", path: "src/deep/path/file name.ts" });
    expect(label).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("mergeWindowUrl", () => {
  it("carries the repo and path in the query string", () => {
    const url = mergeWindowUrl({ repoRoot: "/repo", path: "src/app.ts" });
    const query = new URLSearchParams(url.slice(url.indexOf("?")));
    expect(url.startsWith("merge.html?")).toBe(true);
    expect(query.get("repo")).toBe("/repo");
    expect(query.get("path")).toBe("src/app.ts");
  });

  it("escapes a path with characters a query string would eat", () => {
    const url = mergeWindowUrl({ repoRoot: "/repo", path: "src/a&b=c.ts" });
    const query = new URLSearchParams(url.slice(url.indexOf("?")));
    expect(query.get("path")).toBe("src/a&b=c.ts");
  });
});

describe("openMergeWindow", () => {
  it("creates a window pointed at the merge document", async () => {
    await openMergeWindow({ repoRoot: "/repo", path: "src/app.ts" });
    expect(created).toHaveLength(1);
    expect(created[0].options.url).toBe(mergeWindowUrl({ repoRoot: "/repo", path: "src/app.ts" }));
    expect(created[0].options.title).toBe("Conflicts: src/app.ts");
  });

  it("focuses the existing window instead of opening a second one", async () => {
    const existing = { unminimize: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn() };
    getByLabelMock.mockResolvedValue(existing as never);

    await openMergeWindow({ repoRoot: "/repo", path: "src/app.ts" });

    expect(created).toHaveLength(0);
    // Unminimize first: focusing a minimised window does nothing on its own.
    expect(existing.unminimize).toHaveBeenCalled();
    expect(existing.setFocus).toHaveBeenCalled();
  });

  it("rejects with a message that names the window, not its label", async () => {
    outcome = "error";
    await expect(openMergeWindow({ repoRoot: "/repo", path: "src/app.ts" })).rejects.toThrow(
      /could not open the merge window: window creation denied/,
    );
  });
});
