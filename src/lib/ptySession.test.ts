import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { attach, restart } from "./ptySession";
import { bytesToBase64 } from "./base64";

const hoisted = vi.hoisted(() => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    write = vi.fn();
    reset = vi.fn();
    focus = vi.fn();
    loadAddon = vi.fn();
    dataHandler: ((data: string) => void) | null = null;
    disposeSpy = vi.fn();

    constructor() {
      terminals.push(this);
    }

    open(container: HTMLElement) {
      this.element = document.createElement("div");
      container.appendChild(this.element);
    }

    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: this.disposeSpy };
    }
  }
  // Instances created by the mocked Terminal constructor, in creation order.
  const terminals: FakeTerminal[] = [];
  // Registered event handlers by event name, plus their unlisten spies.
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const unlistenSpies: Array<ReturnType<typeof vi.fn>> = [];
  const registerListen = (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    const unlisten = vi.fn(() => {
      handlers.delete(name);
    });
    unlistenSpies.push(unlisten);
    return Promise.resolve(unlisten);
  };
  return { FakeTerminal, terminals, handlers, unlistenSpies, registerListen };
});

vi.mock("@xterm/xterm", () => ({ Terminal: hoisted.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(hoisted.registerListen),
}));

const invokeMock = vi.mocked(invoke);

function mockBackend({ exists = false, spawnError }: { exists?: boolean; spawnError?: string } = {}) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "pty_exists") return Promise.resolve(exists);
    if (command === "pty_spawn" && spawnError) return Promise.reject(new Error(spawnError));
    return Promise.resolve(undefined);
  });
}

function callsTo(command: string) {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === command);
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// Session ids must be unique per test: the manager keeps module-level state.
let testId = 0;
const nextId = () => `session-${++testId}`;

let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  hoisted.terminals.length = 0;
  hoisted.handlers.clear();
  hoisted.unlistenSpies.length = 0;
  document.body.replaceChildren();
});

describe("attach", () => {
  it("spawns the pty when it does not exist yet", async () => {
    mockBackend({ exists: false });
    const id = nextId();
    attach(container, { id, cmd: "claude" });
    await flush();

    expect(callsTo("pty_spawn")).toHaveLength(1);
    expect(callsTo("pty_spawn")[0][1]).toMatchObject({ id, cmd: "claude", cols: 80, rows: 24 });
  });

  it("skips spawn and resyncs size when the pty already exists", async () => {
    mockBackend({ exists: true });
    const id = nextId();
    attach(container, { id, cmd: "claude" });
    await flush();

    expect(callsTo("pty_spawn")).toHaveLength(0);
    expect(callsTo("pty_resize")).toHaveLength(1);
  });

  it("writes decoded output events to the terminal", async () => {
    mockBackend();
    const id = nextId();
    attach(container, { id });
    await flush();

    const handler = hoisted.handlers.get(`pty://output/${id}`);
    expect(handler).toBeDefined();
    handler!({ payload: bytesToBase64(new TextEncoder().encode("hello")) });

    const term = hoisted.terminals.at(-1)!;
    expect(term.write).toHaveBeenCalledTimes(1);
    const written = term.write.mock.calls[0][0] as Uint8Array;
    expect(new TextDecoder().decode(written)).toBe("hello");
  });

  it("forwards exit events to onExit", async () => {
    mockBackend();
    const id = nextId();
    const onExit = vi.fn();
    attach(container, { id, onExit });
    await flush();

    hoisted.handlers.get(`pty://exit/${id}`)!({ payload: { exitCode: 127 } });
    expect(onExit).toHaveBeenCalledWith({ exitCode: 127 });
  });

  it("sends terminal input to pty_write base64-encoded", async () => {
    mockBackend();
    const id = nextId();
    attach(container, { id });
    await flush();

    hoisted.terminals.at(-1)!.dataHandler!("ls\r");
    await flush();

    const writes = callsTo("pty_write");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ id });
  });

  it("rolls back partial wiring when the exit listener registration fails", async () => {
    mockBackend();
    const { listen } = await import("@tauri-apps/api/event");
    // First listen (output) works, second (exit) rejects.
    vi.mocked(listen)
      .mockImplementationOnce(
        hoisted.registerListen as unknown as typeof listen,
      )
      .mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    const onError = vi.fn();
    attach(container, { id: nextId(), onError });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    // The already-registered output listener must have been rolled back.
    expect(hoisted.unlistenSpies).toHaveLength(1);
    expect(hoisted.unlistenSpies[0]).toHaveBeenCalledTimes(1);
    expect(hoisted.handlers.size).toBe(0);
  });

  it("skips the WebGL addon on Windows", async () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    mockBackend();
    attach(container, { id: nextId() });
    await flush();

    // Only the fit addon loads; WebGL is skipped (WebView2 black-canvas bug).
    expect(hoisted.terminals.at(-1)!.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("loads the WebGL addon on non-Windows platforms", async () => {
    mockBackend();
    attach(container, { id: nextId() });
    await flush();

    expect(hoisted.terminals.at(-1)!.loadAddon).toHaveBeenCalledTimes(2);
  });

  it("surfaces spawn failures through onError", async () => {
    mockBackend({ exists: false, spawnError: "pty session 'x' already exists" });
    const id = nextId();
    const onError = vi.fn();
    attach(container, { id, onError });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    // Wiring must not proceed after a failed spawn.
    expect(hoisted.handlers.size).toBe(0);
  });
});

describe("detach", () => {
  it("removes listeners but never kills the pty", async () => {
    mockBackend();
    const id = nextId();
    const handle = attach(container, { id });
    await flush();
    expect(hoisted.unlistenSpies).toHaveLength(2);

    handle.detach();

    for (const spy of hoisted.unlistenSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(hoisted.terminals.at(-1)!.disposeSpy).toHaveBeenCalledTimes(1);
    expect(callsTo("pty_kill")).toHaveLength(0);
  });

  it("is idempotent", async () => {
    mockBackend();
    const handle = attach(container, { id: nextId() });
    await flush();
    handle.detach();
    handle.detach();
    expect(hoisted.unlistenSpies[0]).toHaveBeenCalledTimes(1);
  });
});

describe("StrictMode double effect", () => {
  it("attach, immediate detach, re-attach spawns exactly once", async () => {
    mockBackend({ exists: false });
    const id = nextId();

    const first = attach(container, { id });
    first.detach();
    const second = attach(container, { id });
    await flush();

    expect(callsTo("pty_spawn")).toHaveLength(1);
    // Only the surviving attach's listeners remain registered.
    expect(hoisted.handlers.size).toBe(2);
    second.detach();
  });

  it("reuses the same terminal instance across re-attach", async () => {
    mockBackend();
    const id = nextId();
    const first = attach(container, { id });
    await flush();
    first.detach();

    const other = document.createElement("div");
    document.body.appendChild(other);
    attach(other, { id });
    await flush();

    expect(hoisted.terminals).toHaveLength(1);
    expect(other.contains(hoisted.terminals[0].element)).toBe(true);
  });
});

describe("restart", () => {
  it("resets the terminal and respawns with current dimensions", async () => {
    mockBackend();
    const id = nextId();
    attach(container, { id, cmd: "claude" });
    await flush();
    invokeMock.mockClear();
    mockBackend();

    await restart(id, "claude");

    expect(hoisted.terminals.at(-1)!.reset).toHaveBeenCalledTimes(1);
    expect(callsTo("pty_spawn")).toHaveLength(1);
    expect(callsTo("pty_spawn")[0][1]).toMatchObject({ id, cmd: "claude" });
  });

  it("rejects for a session that was never attached", async () => {
    await expect(restart("never-attached")).rejects.toThrow(/no terminal attached/);
  });
});
