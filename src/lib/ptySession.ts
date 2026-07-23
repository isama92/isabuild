// PTY session manager. This module — not any React component — owns the
// Terminal instances and their wiring to the backend PTY sessions, so a
// component unmount (including dev HMR) detaches listeners without touching
// the PTY, and a remount re-attaches to the still-running session.
//
// Concurrency model: every attach bumps the entry's generation counter and
// captures it. The async init re-checks the generation after each await and
// rolls back if a newer attach (or a detach) has taken over. Combined with the
// backend erroring on duplicate spawn ids, React StrictMode's double effect
// can never double-spawn.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { base64ToBytes, stringToBase64 } from "./base64";

export interface PtyExitInfo {
  exitCode: number;
}

export interface AttachOptions {
  id: string;
  /** Command run through the platform shell; omit for a plain shell. */
  cmd?: string;
  onExit?: (info: PtyExitInfo) => void;
  /** Called when spawning or wiring the session fails. */
  onError?: (error: unknown) => void;
}

export interface AttachHandle {
  detach(): void;
}

interface Entry {
  term: Terminal;
  fit: FitAddon;
  gen: number;
  unlisteners: UnlistenFn[];
  dataDisposable: { dispose(): void } | null;
  resizeObserver: ResizeObserver | null;
  resizeTimer: number | null;
}

const RESIZE_DEBOUNCE_MS = 100; // ConPTY glitches on rapid resize storms

const entries = new Map<string, Entry>();

function createEntry(): Entry {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
    fontSize: 14,
    scrollback: 5000,
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return {
    term,
    fit,
    gen: 0,
    unlisteners: [],
    dataDisposable: null,
    resizeObserver: null,
    resizeTimer: null,
  };
}

function tryWebgl(term: Terminal): void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // WebGL unavailable (headless, driver issues): xterm falls back to the
    // DOM renderer on its own.
  }
}

/**
 * Mount the session's terminal into `container` and wire it to the backend
 * PTY, spawning the PTY only if it does not already exist. Returns
 * immediately; wiring happens asynchronously guarded by the generation
 * counter. The returned `detach` unhooks listeners but NEVER kills the PTY.
 */
export function attach(container: HTMLElement, opts: AttachOptions): AttachHandle {
  let entry = entries.get(opts.id);
  if (!entry) {
    entry = createEntry();
    entries.set(opts.id, entry);
  }
  entry.gen += 1;
  const myGen = entry.gen;
  const e = entry;

  void initialize(container, e, myGen, opts).catch((error: unknown) => {
    if (e.gen === myGen) {
      // Roll back any partially registered wiring (e.g. the output listener
      // when registering the exit listener failed), symmetric with detach.
      teardown(e);
      opts.onError?.(error);
    }
  });

  return {
    detach() {
      if (e.gen !== myGen) return; // superseded by a newer attach
      e.gen += 1;
      teardown(e);
    },
  };
}

async function initialize(
  container: HTMLElement,
  e: Entry,
  myGen: number,
  opts: AttachOptions,
): Promise<void> {
  if (e.term.element) {
    // HMR / StrictMode remount: reparent the live terminal.
    container.appendChild(e.term.element);
  } else {
    e.term.open(container);
    tryWebgl(e.term);
  }
  e.fit.fit();

  const exists = await invoke<boolean>("pty_exists", { id: opts.id });
  if (e.gen !== myGen) return;

  if (exists) {
    // Re-attached to a live session: sync its size to the current layout.
    await invoke("pty_resize", { id: opts.id, cols: e.term.cols, rows: e.term.rows });
  } else {
    await invoke("pty_spawn", {
      id: opts.id,
      cmd: opts.cmd ?? null,
      args: [],
      cwd: null,
      cols: e.term.cols,
      rows: e.term.rows,
    });
  }
  if (e.gen !== myGen) return;

  const unlistenOutput = await listen<string>(`pty://output/${opts.id}`, (event) => {
    e.term.write(base64ToBytes(event.payload));
  });
  if (e.gen !== myGen) {
    unlistenOutput();
    return;
  }
  e.unlisteners.push(unlistenOutput);

  const unlistenExit = await listen<{ exitCode: number }>(
    `pty://exit/${opts.id}`,
    (event) => {
      opts.onExit?.({ exitCode: event.payload.exitCode });
    },
  );
  if (e.gen !== myGen) {
    unlistenExit();
    return;
  }
  e.unlisteners.push(unlistenExit);

  e.dataDisposable = e.term.onData((data) => {
    void invoke("pty_write", { id: opts.id, data: stringToBase64(data) });
  });

  const observer = new ResizeObserver(() => {
    if (e.resizeTimer !== null) {
      window.clearTimeout(e.resizeTimer);
    }
    e.resizeTimer = window.setTimeout(() => {
      e.resizeTimer = null;
      e.fit.fit();
      void invoke("pty_resize", { id: opts.id, cols: e.term.cols, rows: e.term.rows });
    }, RESIZE_DEBOUNCE_MS);
  });
  observer.observe(container);
  e.resizeObserver = observer;
}

function teardown(e: Entry): void {
  for (const unlisten of e.unlisteners.splice(0)) {
    unlisten();
  }
  e.dataDisposable?.dispose();
  e.dataDisposable = null;
  e.resizeObserver?.disconnect();
  e.resizeObserver = null;
  if (e.resizeTimer !== null) {
    window.clearTimeout(e.resizeTimer);
    e.resizeTimer = null;
  }
  // The Terminal stays in the map for the next attach; the PTY keeps running.
}

/**
 * Respawn the PTY for a session whose child exited (the exit removed it from
 * the backend map). The attach-time listeners use id-based event names, so
 * they keep working across the respawn — no re-listen needed.
 */
export async function restart(id: string, cmd?: string): Promise<void> {
  const e = entries.get(id);
  if (!e) {
    throw new Error(`no terminal attached for session '${id}'`);
  }
  e.term.reset();
  await invoke("pty_spawn", {
    id,
    cmd: cmd ?? null,
    args: [],
    cwd: null,
    cols: e.term.cols,
    rows: e.term.rows,
  });
  e.term.focus();
}
