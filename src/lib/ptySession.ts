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
import { sequenceFor } from "./terminalKeys";
import { currentAppearance, DEFAULT_MONO_STACK, onAppearance } from "./appearance";
import { DEFAULT_THEME, type Theme } from "../theme/themes";

/**
 * xterm's theme, from the app's tokens.
 *
 * The 16 ANSI entries matter as much as the background: the shell picks its own
 * colours from that palette, so a light theme with the dark palette still under
 * it leaves a prompt in colours chosen to sit on black.
 */
function terminalTheme(theme: Theme) {
  const t = theme.tokens;
  return {
    background: t.bg,
    foreground: t.textBright,
    cursor: t.textBright,
    cursorAccent: t.bg,
    selectionBackground: t.selection,
    black: t.ansiBlack,
    red: t.ansiRed,
    green: t.ansiGreen,
    yellow: t.ansiYellow,
    blue: t.ansiBlue,
    magenta: t.ansiMagenta,
    cyan: t.ansiCyan,
    white: t.ansiWhite,
    brightBlack: t.ansiBrightBlack,
    brightRed: t.ansiBrightRed,
    brightGreen: t.ansiBrightGreen,
    brightYellow: t.ansiBrightYellow,
    brightBlue: t.ansiBrightBlue,
    brightMagenta: t.ansiBrightMagenta,
    brightCyan: t.ansiBrightCyan,
    brightWhite: t.ansiBrightWhite,
  };
}

export interface PtyExitInfo {
  exitCode: number;
}

export interface AttachOptions {
  id: string;
  /** Command run through the platform shell; omit for a plain shell. */
  cmd?: string;
  /** Focus the terminal once it is attached and wired. */
  autoFocus?: boolean;
  onExit?: (info: PtyExitInfo) => void;
  /** Called when spawning or wiring the session fails. */
  onError?: (error: unknown) => void;
  /**
   * Called once the session is spawned (or re-attached) and fully wired, so a
   * caller can write to it without polling `pty_exists`. Not called when the
   * attach was superseded or failed.
   */
  onReady?: () => void;
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
  // The appearance may not have been published yet (a terminal can mount before
  // the settings read resolves), so fall back to the same stack it resolves to
  // for an unset family. `applyAppearance` corrects it the moment it arrives.
  const appearance = currentAppearance();
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: appearance?.fontFamily ?? DEFAULT_MONO_STACK,
    fontSize: appearance?.fontSize ?? 14,
    scrollback: 5000,
    theme: terminalTheme(appearance?.theme ?? DEFAULT_THEME),
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
  // WebView2 can hand out a WebGL context that paints nothing (black canvas
  // over a live terminal, seen on Windows 11), which a try/catch cannot
  // detect. The DOM renderer handles our throughput fine, so WebGL stays
  // off on Windows.
  if (navigator.userAgent.includes("Windows")) return;
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
    // Fresh PTY into a possibly-reused terminal (e.g. reopened after the
    // previous session exited): clear any stale scrollback so the new session
    // starts clean. Only runs when no live session exists, so it can never
    // wipe a running terminal.
    e.term.reset();
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

  // Keys whose xterm encoding is not what a line editor reads: Shift+Enter, and
  // word and line editing. The table is `lib/terminalKeys`. Registered here
  // rather than at Terminal construction because it needs the session id, and it
  // is a setter, so a re-attach simply replaces it.
  //
  // A user who binds one of these to an app action in config.json shadows it:
  // useGlobalKeybindings listens in the capture phase precisely so a bound key
  // never reaches xterm. The settings window refuses them (`RESERVED` in
  // `lib/keybindings`), so only a hand-edited file can.
  e.term.attachCustomKeyEventHandler((event) => {
    const sequence = sequenceFor(event);
    if (sequence === null) return true;
    // preventDefault as well as returning false: xterm returns early on a false
    // handler, before its own preventDefault, which would leave the browser
    // applying the key to the hidden textarea xterm manages — a newline for
    // Shift+Enter, a word cut out of it for Ctrl+Backspace — and, on Windows and
    // Linux, letting Alt+ArrowLeft navigate the webview back out of the app.
    event.preventDefault();
    void invoke("pty_write", { id: opts.id, data: stringToBase64(sequence) });
    return false;
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

  // No await since the last generation check, so this attach still owns the
  // entry: safe to grab focus. Mirrors restart(), which also focuses.
  if (opts.autoFocus) {
    e.term.focus();
  }
  opts.onReady?.();
}

/**
 * Type `text` into a live session, as if the user had typed it. Used by
 * "Retry in terminal" (Part 5); deliberately does not append a newline, so the
 * user reviews and runs it themselves rather than having a command execute
 * under them.
 *
 * Rejects when no session with `id` is running.
 */
export function writeText(id: string, text: string): Promise<void> {
  return invoke<void>("pty_write", { id, data: stringToBase64(text) });
}

function teardown(e: Entry): void {
  for (const unlisten of e.unlisteners.splice(0)) {
    unlisten();
  }
  e.dataDisposable?.dispose();
  e.dataDisposable = null;
  // Symmetric with disposing the data handler: a detached terminal must not be
  // able to write to the PTY either. There is no disposable for this one, so
  // restoring the default handler is how it is unhooked.
  e.term.attachCustomKeyEventHandler(() => true);
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

// Follow the font setting for every live terminal. Registered at module load
// (not per attach) because the entries outlive any component: a terminal in a
// hidden region has no mounted React tree to react for it, and would otherwise
// come back in the old font when the region is reopened.
//
// The font change resizes the character cell, so the same pixel box now holds a
// different number of columns and rows. Without the refit and the `pty_resize`
// that follows it, the shell keeps wrapping at the old width and everything
// full-width (Claude Code's boxes, a `git log --graph`) draws ragged.
onAppearance((appearance) => {
  for (const [id, entry] of entries) {
    entry.term.options.fontFamily = appearance.fontFamily;
    entry.term.options.fontSize = appearance.fontSize;
    // Repaints the whole buffer, including scrollback already written in the
    // previous palette: xterm stores cells by ANSI index, not by colour.
    entry.term.options.theme = terminalTheme(appearance.theme);
    // Only meaningful once the terminal is in the DOM; FitAddon throws on a
    // detached element, and an unopened terminal has nothing to measure.
    if (!entry.term.element) continue;
    entry.fit.fit();
    void invoke("pty_resize", { id, cols: entry.term.cols, rows: entry.term.rows }).catch(() => {
      // The session may have exited between the font change and here; the
      // exit path already surfaces that.
    });
  }
});
