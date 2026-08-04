// The byte table is the spec, so these tests spell the sequences out rather than
// comparing against the constants: a constant assigned the wrong escape has to
// fail here.
//
// What they cannot assert: that readline or Claude Code *acts* on the bytes, and
// that the OS delivers the combination at all — Ctrl+Arrow never reaches the app
// on macOS, which is the whole reason the Alt rows exist. Both belong to the
// manual pass, on each platform.

import { describe, expect, it } from "vitest";
import {
  isMacUserAgent,
  MAC_TRANSLATIONS,
  sequenceFor,
  TRANSLATIONS,
  type TerminalKeyEvent,
} from "./terminalKeys";
import { formatAccelerator, isBindable, parseAccelerator, reservedBy } from "./keybindings";

function keyDown(key: string, modifiers: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
  return {
    type: "keydown",
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe("sequenceFor", () => {
  // `mac: false` throughout, so a row that only passes on a Mac cannot hide here.
  it.each([
    { name: "Ctrl+ArrowLeft", event: keyDown("ArrowLeft", { ctrlKey: true }), bytes: "\x1bb" },
    { name: "Ctrl+ArrowRight", event: keyDown("ArrowRight", { ctrlKey: true }), bytes: "\x1bf" },
    { name: "Ctrl+Backspace", event: keyDown("Backspace", { ctrlKey: true }), bytes: "\x1b\x7f" },
    { name: "Ctrl+Delete", event: keyDown("Delete", { ctrlKey: true }), bytes: "\x1bd" },
    { name: "Alt+ArrowLeft", event: keyDown("ArrowLeft", { altKey: true }), bytes: "\x1bb" },
    { name: "Alt+ArrowRight", event: keyDown("ArrowRight", { altKey: true }), bytes: "\x1bf" },
    { name: "Alt+Backspace", event: keyDown("Backspace", { altKey: true }), bytes: "\x1b\x7f" },
    { name: "Alt+Delete", event: keyDown("Delete", { altKey: true }), bytes: "\x1bd" },
    { name: "Shift+Enter", event: keyDown("Enter", { shiftKey: true }), bytes: "\x1b\r" },
  ])("translates $name", ({ event, bytes }) => {
    expect(sequenceFor(event, false)).toBe(bytes);
  });

  it("gives Alt+Arrow the same motion as Ctrl+Arrow", () => {
    // Not redundant with the table: on macOS this pair is the *only* word motion
    // that arrives, because Ctrl+Arrow is Mission Control's "move a space".
    expect(sequenceFor(keyDown("ArrowLeft", { altKey: true }), false)).toBe(
      sequenceFor(keyDown("ArrowLeft", { ctrlKey: true }), false),
    );
    expect(sequenceFor(keyDown("ArrowRight", { altKey: true }), false)).toBe(
      sequenceFor(keyDown("ArrowRight", { ctrlKey: true }), false),
    );
  });

  it.each(["ArrowLeft", "ArrowRight", "Backspace", "Delete", "Enter"])(
    "leaves a bare %s to xterm",
    (key) => {
      // The regression to fear: translating these would break ordinary cursor
      // motion, ordinary Backspace and submitting a prompt.
      expect(sequenceFor(keyDown(key), false)).toBeNull();
    },
  );

  it.each([
    {
      name: "Ctrl+Shift+ArrowLeft",
      event: keyDown("ArrowLeft", { ctrlKey: true, shiftKey: true }),
    },
    { name: "Ctrl+Alt+ArrowLeft", event: keyDown("ArrowLeft", { ctrlKey: true, altKey: true }) },
    { name: "Ctrl+Meta+ArrowLeft", event: keyDown("ArrowLeft", { ctrlKey: true, metaKey: true }) },
    {
      name: "Alt+Shift+ArrowRight",
      event: keyDown("ArrowRight", { altKey: true, shiftKey: true }),
    },
    {
      name: "Ctrl+Shift+Backspace",
      event: keyDown("Backspace", { ctrlKey: true, shiftKey: true }),
    },
  ])("matches modifiers exactly, so $name is not ours", ({ event }) => {
    // In a GUI, Ctrl+Shift+Arrow extends a selection by word. A terminal has no
    // input selection to extend, so the keystroke belongs to xterm.
    expect(sequenceFor(event, false)).toBeNull();
  });

  it.each([
    { name: "Meta+ArrowLeft", event: keyDown("ArrowLeft", { metaKey: true }), bytes: "\x01" },
    { name: "Meta+ArrowRight", event: keyDown("ArrowRight", { metaKey: true }), bytes: "\x05" },
    { name: "Meta+Backspace", event: keyDown("Backspace", { metaKey: true }), bytes: "\x15" },
  ])("translates $name on a Mac only", ({ event, bytes }) => {
    expect(sequenceFor(event, true)).toBe(bytes);
    // Meta is Super elsewhere, where `\x15` would discard a typed line.
    expect(sequenceFor(event, false)).toBeNull();
  });

  it("keeps the word rows on a Mac too", () => {
    expect(sequenceFor(keyDown("ArrowLeft", { altKey: true }), true)).toBe("\x1bb");
    expect(sequenceFor(keyDown("Backspace", { ctrlKey: true }), true)).toBe("\x1b\x7f");
  });

  it.each(["keyup", "keypress"])("acts on keydown only, not %s", (type) => {
    // xterm calls the custom handler for all three, so without the guard every
    // translated keystroke would write two or three times.
    expect(sequenceFor(keyDown("ArrowLeft", { ctrlKey: true, type }), false)).toBeNull();
    expect(sequenceFor(keyDown("Enter", { shiftKey: true, type }), false)).toBeNull();
  });

  it("leaves a keystroke inside an IME composition alone", () => {
    // The handler runs before xterm's composition helper, so an arrow meant to
    // move within a pre-edit string must not be sent to the shell.
    const arrow = keyDown("ArrowLeft", { ctrlKey: true, isComposing: true });
    expect(sequenceFor(arrow, false)).toBeNull();
    expect(sequenceFor(keyDown("Enter", { shiftKey: true, isComposing: true }), false)).toBeNull();
  });

  it.each([
    { name: "Ctrl+a", event: keyDown("a", { ctrlKey: true }) },
    { name: "Ctrl+ArrowUp", event: keyDown("ArrowUp", { ctrlKey: true }) },
    { name: "Ctrl+ArrowDown", event: keyDown("ArrowDown", { ctrlKey: true }) },
    { name: "Alt+Enter", event: keyDown("Enter", { altKey: true }) },
  ])("leaves the unmapped $name to xterm", ({ event }) => {
    // The vertical arrows especially: they are history navigation in Claude Code
    // and in every shell.
    expect(sequenceFor(event, true)).toBeNull();
  });
});

describe("isMacUserAgent", () => {
  it("recognises a Mac and nothing else", () => {
    expect(
      isMacUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      ),
    ).toBe(true);
    expect(isMacUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe(
      false,
    );
    expect(isMacUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe(false);
  });
});

describe("the two key tables together", () => {
  const combos = [...Object.keys(TRANSLATIONS), ...Object.keys(MAC_TRANSLATIONS)];

  it.each(combos)("%s is spelled the way an accelerator is", (combo) => {
    // What lets a row be compared with `RESERVED` as a string at all.
    const accelerator = parseAccelerator(combo);
    expect(accelerator, combo).not.toBeNull();
    if (accelerator === null) return;
    expect(formatAccelerator(accelerator)).toBe(combo);
  });

  it.each(combos)("%s cannot be bound to an app action in the workspace", (combo) => {
    // Otherwise the capture-phase listener swallows the key before xterm sees it
    // and editing dies silently. A disjunction because the two layers refuse a
    // combination for different reasons, so what it catches is a row with a real
    // modifier added without a `RESERVED` entry; a Shift-only row such as
    // Shift+Enter is already refused by `isBindable` and needs no entry.
    const accelerator = parseAccelerator(combo);
    if (accelerator === null) return; // reported by the test above
    const refused = !isBindable(accelerator) || reservedBy("toggle-terminal", accelerator) !== null;
    expect(refused, combo).toBe(true);
  });
});
