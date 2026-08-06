import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onShowFile, registerDiffWindow, routeDiffWindow } from "./diffRegistry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockResolvedValue(undefined);
});

describe("registerDiffWindow", () => {
  it("names the file, and no label — the backend takes that from the window", () => {
    void registerDiffWindow({ repoRoot: "/r", path: "src/a.ts" });
    expect(invokeMock).toHaveBeenCalledWith("diff_window_shows", {
      repoRoot: "/r",
      path: "src/a.ts",
    });
  });

  it("surfaces a failure rather than swallowing it", async () => {
    invokeMock.mockRejectedValue(new Error("no such window"));
    await expect(registerDiffWindow({ repoRoot: "/r", path: "src/a.ts" })).rejects.toThrow(
      "no such window",
    );
  });
});

describe("routeDiffWindow", () => {
  it("passes the target and the label the file belongs to", () => {
    void routeDiffWindow({ repoRoot: "/r", path: "src/a.ts" }, "diff-a");
    expect(invokeMock).toHaveBeenCalledWith("diff_window_route", {
      repoRoot: "/r",
      path: "src/a.ts",
      origPath: null,
      preferredLabel: "diff-a",
    });
  });

  it("sends a rename origin as null when there is none", () => {
    void routeDiffWindow({ repoRoot: "/r", path: "src/a.ts", origPath: "old.ts" }, "diff-a");
    expect(invokeMock).toHaveBeenCalledWith(
      "diff_window_route",
      expect.objectContaining({ origPath: "old.ts" }),
    );
  });

  it("hands back the label to focus", async () => {
    invokeMock.mockResolvedValue("diff-elsewhere");
    await expect(routeDiffWindow({ repoRoot: "/r", path: "a.ts" }, "diff-a")).resolves.toBe(
      "diff-elsewhere",
    );
  });

  it("hands back null when a window has to be created", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(routeDiffWindow({ repoRoot: "/r", path: "a.ts" }, "diff-a")).resolves.toBeNull();
  });
});

describe("onShowFile", () => {
  it("unwraps the payload, so the caller never sees the event envelope", async () => {
    const seen = vi.fn();
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation((_name, handler) => {
      deliver = handler as typeof deliver;
      return Promise.resolve(vi.fn());
    });

    await onShowFile(seen);
    deliver?.({ payload: { repoRoot: "/r", path: "src/b.ts" } });

    expect(listenMock).toHaveBeenCalledWith("diff://show", expect.any(Function));
    expect(seen).toHaveBeenCalledWith({ repoRoot: "/r", path: "src/b.ts" });
  });
});
