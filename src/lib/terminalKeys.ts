// What a keystroke sends to the PTY when xterm's own encoding is not what a line
// editor reads. Entirely pure: the wiring — one custom key handler per session —
// lives in `ptySession`, which is also the only place that knows a session id.
//
// ## Why anything needs translating
//
// The editing keys every other text field on the machine has are not swallowed
// on the way to the shell; they arrive encoded as something the line editor at
// the other end does not read that way. xterm sends Ctrl+ArrowLeft as
// `CSI 1;5D`, Ctrl+ArrowRight as `CSI 1;5C` and Ctrl+Backspace as a bare `^H` —
// and `^H` is readline's `backward-delete-char`, one character, which is why
// Ctrl+Backspace deleted a letter rather than a word.
//
// The meta forms this table sends instead are the one spelling all three line
// editors involved accept out of the box. The CSI forms are not: readline's
// default emacs keymap does bind them to word motion (so Ctrl+Arrow already
// worked at a bash prompt, with no inputrc at all), but zsh binds neither, and
// Claude Code is not readline and reads no inputrc. `^H` is bound to a
// single-character delete in all of them, which is why Ctrl+Backspace was broken
// everywhere while Ctrl+Arrow was broken only in some places.
//
// ## Keyed on `key`, not `code` as `lib/keybindings` is
//
// Every row is a named non-typing key, whose `key` is already
// layout-independent and happens to be the same string the accelerator grammar
// uses — so a row can be handed to `parseAccelerator` and compared with
// `RESERVED`, which is what the cross-module test does. It also picks up the
// numpad arrows with NumLock off for free, since those report `key: ArrowLeft`
// under a `Numpad4` code. A row for a *letter* would not be safe this way:
// `key` for a letter follows the layout and the Shift state.
//
// ## Why not xterm's `macOptionIsMeta`
//
// It looks like a one-line replacement for the Alt rows and is not. It does
// nothing for Ctrl+Arrow, which is the combination actually asked for; it does
// nothing for Option+Arrow either, because xterm's arrow cases never consult it
// and go through the CSI path regardless; and it makes Option+letter send
// ESC+letter on macOS, which is exactly how a Mac types é and è. Leave it off.

/** readline `backward-word` (M-b). */
export const BACKWARD_WORD = "\x1bb";
/** readline `forward-word` (M-f). */
export const FORWARD_WORD = "\x1bf";
/** readline `backward-kill-word` (M-DEL), the macOS Option+Backspace gesture. */
export const BACKWARD_KILL_WORD = "\x1b\x7f";
/** readline `kill-word` (M-d). */
export const KILL_WORD = "\x1bd";
/** readline `beginning-of-line` (C-a). */
export const LINE_START = "\x01";
/** readline `end-of-line` (C-e). */
export const LINE_END = "\x05";
/**
 * readline `unix-line-discard` (C-u): kills backwards to the start of the line
 * in bash, the whole line in zsh. Either is what a Mac user pressing
 * Cmd+Backspace is asking for.
 */
export const KILL_LINE_BACKWARD = "\x15";

/**
 * What Shift+Enter sends instead of a bare CR: meta+Return.
 *
 * xterm encodes Shift+Enter as `\r`, indistinguishable from Enter, so without
 * this the key submits the prompt rather than extending it. `\x1b\r` is the
 * sequence iTerm2 and VS Code bind for Shift+Enter — and what Claude Code's own
 * `/terminal-setup` writes — so Claude Code reads it as meta+Return and inserts
 * a newline.
 *
 * Sent in the shell terminal too, deliberately. No byte sequence inserts a
 * newline at a bash or zsh prompt (LF *is* accept-line there), and `\x1b\r` is
 * unbound in readline, so Shift+Enter becomes a no-op in the shell rather than
 * submitting a line the user did not mean to run.
 */
export const SHIFT_ENTER = "\x1b\r";

/**
 * Combination to bytes, on every platform.
 *
 * Keys are canonical accelerator text in the order `formatAccelerator` produces,
 * so a row parses with `parseAccelerator` and compares with `RESERVED` as a
 * string. Both terminals get the whole table, since they share `attach`: bash
 * and zsh's emacs mode bind all four meta forms by default, and in zsh's vi mode
 * they are unbound — but so is `CSI 1;5D`, so that is not a regression, just not
 * a help.
 *
 * The Alt rows are not a nicety. On macOS, Ctrl+Arrow is Mission Control's "move
 * a space" and never reaches the webview at all, so Option+Arrow is the only
 * word motion that arrives there. Alt+Backspace is listed even though it is
 * already what xterm encodes, so that the whole matrix is in one place and an
 * xterm upgrade cannot quietly change one row of it.
 */
export const TRANSLATIONS: Readonly<Record<string, string>> = {
  "Ctrl+ArrowLeft": BACKWARD_WORD,
  "Ctrl+ArrowRight": FORWARD_WORD,
  "Ctrl+Backspace": BACKWARD_KILL_WORD,
  "Ctrl+Delete": KILL_WORD,
  "Alt+ArrowLeft": BACKWARD_WORD,
  "Alt+ArrowRight": FORWARD_WORD,
  "Alt+Backspace": BACKWARD_KILL_WORD,
  "Alt+Delete": KILL_WORD,
  "Shift+Enter": SHIFT_ENTER,
};

/**
 * macOS only: the Cmd gestures every native text field there has.
 *
 * Line motion rather than word motion, and gated because `Meta` is Super on
 * Linux and Windows — where `\x15` would silently discard a typed line if a
 * window manager ever let Super+Backspace through. Nothing is lost by gating:
 * xterm's arrow cases bail out on `metaKey` with no key at all, so Cmd+Arrow
 * sends nothing today. Cmd+Backspace is the one that currently misbehaves rather
 * than doing nothing — the backspace case never checks `metaKey`, so it deletes
 * a single character.
 */
export const MAC_TRANSLATIONS: Readonly<Record<string, string>> = {
  "Meta+ArrowLeft": LINE_START,
  "Meta+ArrowRight": LINE_END,
  "Meta+Backspace": KILL_LINE_BACKWARD,
};

/** The fields a decision needs. A real `KeyboardEvent` satisfies it. */
export interface TerminalKeyEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  /** Optional so a synthetic event need not name it; a real one always has it. */
  isComposing?: boolean;
}

/** Whether this user agent is a Mac, i.e. whether [`MAC_TRANSLATIONS`] apply. */
export function isMacUserAgent(userAgent: string): boolean {
  return userAgent.includes("Mac");
}

const IS_MAC = isMacUserAgent(navigator.userAgent);

/** Canonical accelerator text for a keystroke, in [`TRANSLATIONS`]'s spelling. */
function comboOf(event: TerminalKeyEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(event.key);
  return parts.join("+");
}

/**
 * The bytes this keystroke should send instead, or null to leave it to xterm.
 *
 * Modifiers match exactly rather than as a superset, the same rule `matches()`
 * states for app keybindings, and for free here: `comboOf` spells out every
 * modifier held, so Ctrl+Shift+ArrowLeft composes a string that is not a key of
 * either table. That is deliberate — in a GUI that gesture extends a selection
 * by word, and a terminal has no input selection to extend, so it belongs to
 * xterm.
 *
 * `mac` is a parameter with the user agent only as its default, because a table
 * that sniffed the platform itself would leave the Cmd rows untestable.
 */
export function sequenceFor(event: TerminalKeyEvent, mac: boolean = IS_MAC): string | null {
  // xterm calls the custom handler for keydown, keyup *and* keypress; without
  // this every translated keystroke would write two or three times.
  if (event.type !== "keydown") return null;
  // The handler runs before xterm hands the event to its composition helper, so
  // returning a sequence mid-composition would send an arrow meant to move
  // inside an IME pre-edit straight to the shell.
  if (event.isComposing === true) return null;

  const combo = comboOf(event);
  if (TRANSLATIONS[combo] !== undefined) return TRANSLATIONS[combo];
  if (mac && MAC_TRANSLATIONS[combo] !== undefined) return MAC_TRANSLATIONS[combo];
  return null;
}
