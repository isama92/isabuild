import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getStatus, onRepoChanged, startWatch } from "./gitStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

afterEach(() => {
  vi.clearAllMocks();
});

describe("gitStatus lib", () => {
  it("getStatus invokes git_status with the given path", async () => {
    invokeMock.mockResolvedValue({ repoRoot: "/r", staged: [], unstaged: [] });
    await getStatus("/r");
    expect(invokeMock).toHaveBeenCalledWith("git_status", { path: "/r" });
  });

  it("getStatus passes null when no path is given", async () => {
    invokeMock.mockResolvedValue({ repoRoot: "/r", staged: [], unstaged: [] });
    await getStatus();
    expect(invokeMock).toHaveBeenCalledWith("git_status", { path: null });
  });

  it("startWatch invokes git_watch with the repo root", async () => {
    invokeMock.mockResolvedValue(undefined);
    await startWatch("/r");
    expect(invokeMock).toHaveBeenCalledWith("git_watch", { repoRoot: "/r" });
  });

  it("onRepoChanged subscribes to repo://changed and runs the callback", async () => {
    let fire: (() => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation((name, handler) => {
      fire = () => handler({ event: name, id: 0, payload: undefined });
      return Promise.resolve(unlisten);
    });

    const cb = vi.fn();
    const un = await onRepoChanged(cb);

    expect(listenMock).toHaveBeenCalledWith("repo://changed", expect.any(Function));
    fire!();
    expect(cb).toHaveBeenCalledTimes(1);
    un();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
