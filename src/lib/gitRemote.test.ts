import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cancelRemoteOp, remoteOpCommand, runRemoteOp } from "./gitRemote";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

/** Handlers registered by the code under test, keyed by event name. */
let handlers: Map<string, (event: { event: string; id: number; payload: unknown }) => void>;
let unlisteners: Map<string, ReturnType<typeof vi.fn>>;
/** Event names in registration order, to assert against the invoke ordering. */
let registrationLog: string[];

function fire(name: string, payload: unknown) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`nothing is listening to ${name}`);
  handler({ event: name, id: 0, payload });
}

beforeEach(() => {
  handlers = new Map();
  unlisteners = new Map();
  registrationLog = [];
  listenMock.mockImplementation((name, handler) => {
    registrationLog.push(`listen:${name}`);
    handlers.set(name, handler as (event: { event: string; id: number; payload: unknown }) => void);
    const unlisten = vi.fn();
    unlisteners.set(name, unlisten);
    return Promise.resolve(unlisten);
  });
  invokeMock.mockImplementation((command: string) => {
    registrationLog.push(`invoke:${command}`);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runRemoteOp", () => {
  it("registers both listeners BEFORE invoking, so no early line is missed", async () => {
    const running = await runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } });
    expect(registrationLog).toEqual([
      `listen:git://progress/${running.opId}`,
      `listen:git://done/${running.opId}`,
      "invoke:git_remote_op",
    ]);
  });

  it("passes the op id and a fully-populated spec to the backend", async () => {
    const running = await runRemoteOp({
      repoRoot: "/r",
      spec: { kind: "push", remote: "origin", branch: "main", setUpstream: true },
    });
    expect(invokeMock).toHaveBeenCalledWith("git_remote_op", {
      repoRoot: "/r",
      opId: running.opId,
      spec: { kind: "push", remote: "origin", branch: "main", setUpstream: true },
    });
  });

  it("defaults the optional spec fields rather than omitting them", async () => {
    const running = await runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } });
    expect(invokeMock).toHaveBeenCalledWith("git_remote_op", {
      repoRoot: "/r",
      opId: running.opId,
      spec: { kind: "fetch", remote: "origin", branch: null, setUpstream: false },
    });
  });

  it("gives every op a distinct id so concurrent listeners cannot cross-talk", async () => {
    const first = await runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } });
    const second = await runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } });
    expect(first.opId).not.toBe(second.opId);
  });

  it("forwards each progress line verbatim", async () => {
    const onProgress = vi.fn();
    const running = await runRemoteOp({
      repoRoot: "/r",
      spec: { kind: "fetch", remote: "origin" },
      onProgress,
    });
    fire(`git://progress/${running.opId}`, "remote: Enumerating objects: 12, done.");
    fire(`git://progress/${running.opId}`, "Receiving objects:  50% (1/2)");
    expect(onProgress).toHaveBeenNthCalledWith(1, "remote: Enumerating objects: 12, done.");
    expect(onProgress).toHaveBeenNthCalledWith(2, "Receiving objects:  50% (1/2)");
  });

  it("resolves with the outcome when the terminal event arrives", async () => {
    const running = await runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } });
    fire(`git://done/${running.opId}`, { exitCode: 0, output: "", cancelled: false });
    await expect(running.result).resolves.toEqual({ exitCode: 0, output: "", cancelled: false });
  });

  it("resolves rather than rejecting on a non-zero exit", async () => {
    // A failed git op is a result to display, not an exception.
    const running = await runRemoteOp({ repoRoot: "/r", spec: { kind: "push", remote: "origin", branch: "main" } });
    fire(`git://done/${running.opId}`, {
      exitCode: 1,
      output: "! [rejected] main -> main (fetch first)",
      cancelled: false,
    });
    await expect(running.result).resolves.toEqual({
      exitCode: 1,
      output: "! [rejected] main -> main (fetch first)",
      cancelled: false,
    });
  });

  it("reports a cancellation through the same terminal event", async () => {
    const running = await runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } });
    fire(`git://done/${running.opId}`, { exitCode: -1, output: "", cancelled: true });
    await expect(running.result).resolves.toMatchObject({ cancelled: true });
  });

  it("unsubscribes both listeners once the op is done", async () => {
    const running = await runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } });
    fire(`git://done/${running.opId}`, { exitCode: 0, output: "", cancelled: false });
    await running.result;
    expect(unlisteners.get(`git://progress/${running.opId}`)).toHaveBeenCalledTimes(1);
    expect(unlisteners.get(`git://done/${running.opId}`)).toHaveBeenCalledTimes(1);
  });

  it("drops its listeners when the op cannot be started at all", async () => {
    // Nothing will ever emit for this id, so leaving them registered would leak
    // for the lifetime of the window.
    invokeMock.mockRejectedValueOnce(new Error("another git operation is still running"));
    await expect(
      runRemoteOp({ repoRoot: "/r", spec: { kind: "fetch", remote: "origin" } }),
    ).rejects.toThrow(/another git operation/);
    for (const unlisten of unlisteners.values()) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});

describe("cancelRemoteOp", () => {
  it("invokes git_cancel_op with the op id", async () => {
    await cancelRemoteOp("fetch-3");
    expect(invokeMock).toHaveBeenCalledWith("git_cancel_op", { opId: "fetch-3" });
  });
});

describe("remoteOpCommand", () => {
  it("describes each op the way a user would run it by hand", () => {
    expect(remoteOpCommand({ kind: "fetch", remote: "origin" })).toBe("git fetch origin");
    // Bare, matching what the backend runs: the user's config decides.
    expect(remoteOpCommand({ kind: "pull", remote: "origin", branch: "main" })).toBe("git pull");
    expect(remoteOpCommand({ kind: "push", remote: "origin", branch: "main" })).toBe(
      "git push origin main",
    );
    expect(
      remoteOpCommand({ kind: "push", remote: "origin", branch: "main", setUpstream: true }),
    ).toBe("git push --set-upstream origin main");
  });

  it("does not leave a trailing space when there is no branch", () => {
    expect(remoteOpCommand({ kind: "push", remote: "origin" })).toBe("git push origin");
  });
});
