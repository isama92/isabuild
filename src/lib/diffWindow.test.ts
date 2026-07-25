import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { diffWindowLabel, diffWindowUrl, openDiffWindow } from "./diffWindow";

// The constructor doubles as the creation call, so the mock records its args
// and hands back a stub whose `once` fires the outcome we choose per test.
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

describe("diffWindowLabel", () => {
  it("is stable for the same file and distinct across paths", () => {
    const target = { repoRoot: "/r", path: "src/a.ts" };
    expect(diffWindowLabel(target)).toBe(diffWindowLabel({ ...target }));
    expect(diffWindowLabel(target)).not.toBe(diffWindowLabel({ ...target, path: "src/b.ts" }));
    // Same basename in different directories must not share a window.
    expect(diffWindowLabel({ repoRoot: "/r", path: "one/mod.rs" })).not.toBe(
      diffWindowLabel({ repoRoot: "/r", path: "two/mod.rs" }),
    );
  });

  it("is the exact label it has always been", () => {
    // Pinned to a literal on purpose. The label is how an already-open window is
    // found again, and the hash inputs moved once already during the extraction
    // into lib/fileWindow — invisibly, because the separator between the two
    // fields is a NUL. Nothing else in the suite would have noticed.
    expect(diffWindowLabel({ repoRoot: "/repo", path: "src/app.ts" })).toBe(
      "diff-src_app_ts-cb9eaf13",
    );
  });

  it("cannot confuse a space in the repo root with the field separator", () => {
    // With a printable separator these two hash alike, and because the slug keeps
    // only the tail of the path they can slugify alike too — the wrong-file
    // collision the repo root is in the hash to prevent.
    expect(diffWindowLabel({ repoRoot: "/repo", path: "a b/x.ts" })).not.toBe(
      diffWindowLabel({ repoRoot: "/repo a", path: "b/x.ts" }),
    );
  });

  it("distinguishes the same relative path in two repositories", () => {
    // Every checkout has a src/a.ts; focusing the wrong repo's window would
    // show, and auto-save to, the wrong file.
    expect(diffWindowLabel({ repoRoot: "/repo-one", path: "src/a.ts" })).not.toBe(
      diffWindowLabel({ repoRoot: "/repo-two", path: "src/a.ts" }),
    );
  });

  it("only uses characters Tauri accepts in a label", () => {
    const label = diffWindowLabel({
      repoRoot: "/r",
      path: "app/Services/Weird Name (1)/[id].blade.php",
    });
    expect(label).toMatch(/^diff-[a-zA-Z0-9_]+-[0-9a-f]{8}$/);
  });

  it("stays short for a deeply nested path", () => {
    const deep = `${"nested/".repeat(40)}file.ts`;
    // 'diff-' + 40 slug chars + '-' + 8 hex.
    expect(diffWindowLabel({ repoRoot: "/r", path: deep }).length).toBeLessThanOrEqual(54);
  });
});

describe("diffWindowUrl", () => {
  it("encodes the target into the diff document's query string", () => {
    const url = diffWindowUrl({ repoRoot: "/home/dev/my repo", path: "src/a b.ts" });
    expect(url).toBe("diff.html?repo=%2Fhome%2Fdev%2Fmy+repo&path=src%2Fa+b.ts");
  });

  it("includes the rename origin only when present", () => {
    expect(diffWindowUrl({ repoRoot: "/r", path: "new.ts", origPath: "old.ts" })).toContain(
      "&orig=old.ts",
    );
    expect(diffWindowUrl({ repoRoot: "/r", path: "new.ts" })).not.toContain("orig=");
  });
});

describe("openDiffWindow", () => {
  it("creates a window for the file with its target in the url", async () => {
    await openDiffWindow({ repoRoot: "/r", path: "src/a.ts" });

    expect(created).toHaveLength(1);
    expect(created[0].label).toBe(diffWindowLabel({ repoRoot: "/r", path: "src/a.ts" }));
    expect(created[0].options.url).toBe(diffWindowUrl({ repoRoot: "/r", path: "src/a.ts" }));
    expect(created[0].options.title).toBe("Diff: src/a.ts");
  });

  it("unminimizes and focuses the existing window instead of opening a second", async () => {
    const setFocus = vi.fn().mockResolvedValue(undefined);
    const unminimize = vi.fn().mockResolvedValue(undefined);
    getByLabelMock.mockResolvedValue({ setFocus, unminimize } as unknown as WebviewWindow);

    await openDiffWindow({ repoRoot: "/r", path: "src/a.ts" });

    // Focus alone leaves a minimised window hidden, which reads as a dead click.
    expect(unminimize).toHaveBeenCalledTimes(1);
    expect(setFocus).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  it("rejects with the reason when the window cannot be created", async () => {
    outcome = "error";
    await expect(openDiffWindow({ repoRoot: "/r", path: "src/a.ts" })).rejects.toThrow(
      /could not open the diff window: window creation denied/,
    );
  });
});
