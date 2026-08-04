import { describe, expect, it } from "vitest";
import {
  acceleratorFromEvent,
  actionFor,
  ACTIONS,
  conflictsWith,
  formatAccelerator,
  isBindable,
  labelFor,
  reservedBy,
  matches,
  parseAccelerator,
  resolveBindings,
  type Accelerator,
} from "./keybindings";

/** A KeyboardEvent-shaped object; `matches` only reads these five fields. */
function key(
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {},
): KeyboardEvent {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

function accelerator(text: string): Accelerator {
  const parsed = parseAccelerator(text);
  if (parsed === null) throw new Error(`'${text}' should parse`);
  return parsed;
}

describe("parseAccelerator", () => {
  it("reads a modifier and a letter", () => {
    expect(parseAccelerator("Alt+F")).toEqual({
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
      code: "KeyF",
    });
  });

  it("reads several modifiers in any order", () => {
    expect(parseAccelerator("Shift+Alt+P")).toEqual(parseAccelerator("Alt+Shift+P"));
  });

  it("maps a digit to its physical key, not its character", () => {
    // Layout independence: Alt+1 is the same key on QWERTY and AZERTY.
    expect(parseAccelerator("Alt+1")?.code).toBe("Digit1");
  });

  it("accepts a bare key with no modifier", () => {
    expect(parseAccelerator("Escape")?.code).toBe("Escape");
  });

  it("accepts the platform names for the same modifier", () => {
    expect(parseAccelerator("Cmd+K")).toEqual(parseAccelerator("Meta+K"));
    expect(parseAccelerator("Option+K")).toEqual(parseAccelerator("Alt+K"));
    expect(parseAccelerator("Control+K")).toEqual(parseAccelerator("Ctrl+K"));
  });

  it("is case-insensitive about modifiers and letters", () => {
    expect(parseAccelerator("alt+f")).toEqual(parseAccelerator("Alt+F"));
  });

  it("reads a punctuation key", () => {
    expect(parseAccelerator("Ctrl+,")?.code).toBe("Comma");
  });

  it("reads a function key and an arrow", () => {
    expect(parseAccelerator("F5")?.code).toBe("F5");
    expect(parseAccelerator("Alt+ArrowDown")?.code).toBe("ArrowDown");
  });

  it("rejects an empty string", () => {
    expect(parseAccelerator("")).toBeNull();
    expect(parseAccelerator("  ")).toBeNull();
  });

  it("rejects a modifier with no key", () => {
    expect(parseAccelerator("Alt+")).toBeNull();
    expect(parseAccelerator("Alt")).toBeNull();
  });

  it("rejects a word that names no key", () => {
    expect(parseAccelerator("Alt+Wibble")).toBeNull();
  });

  it("rejects a modifier repeated", () => {
    expect(parseAccelerator("Alt+Alt+F")).toBeNull();
  });

  it("rejects a modifier in the key position", () => {
    expect(parseAccelerator("F+Alt")).toBeNull();
  });
});

describe("formatAccelerator", () => {
  it("round-trips through parse", () => {
    for (const text of ["Alt+1", "Ctrl+Alt+Shift+Meta+K", "Escape", "Alt+ArrowDown", "Ctrl+,"]) {
      expect(formatAccelerator(accelerator(text))).toBe(text);
    }
  });

  it("canonicalises the modifier order, so two spellings compare equal", () => {
    expect(formatAccelerator(accelerator("Shift+Ctrl+P"))).toBe("Ctrl+Shift+P");
  });

  it("canonicalises the platform aliases", () => {
    expect(formatAccelerator(accelerator("Cmd+K"))).toBe("Meta+K");
  });
});

describe("acceleratorFromEvent", () => {
  it("records the key and its modifiers", () => {
    expect(acceleratorFromEvent(key("KeyF", { altKey: true, shiftKey: true }))).toEqual(
      accelerator("Alt+Shift+F"),
    );
  });

  it("ignores a modifier pressed on its own", () => {
    // The recorder sees this continuously while the user holds Alt looking for
    // the key they want; recording it would bind the modifier itself.
    for (const code of ["AltLeft", "ControlRight", "ShiftLeft", "MetaLeft"]) {
      expect(acceleratorFromEvent(key(code, { altKey: true }))).toBeNull();
    }
  });

  it("ignores a key we have no name for", () => {
    // Storing a raw code we cannot display would produce a row nobody can read
    // or retype.
    expect(acceleratorFromEvent(key("MediaTrackNext"))).toBeNull();
  });
});

describe("matches", () => {
  it("fires on the exact combination", () => {
    expect(matches(accelerator("Alt+1"), key("Digit1", { altKey: true }))).toBe(true);
  });

  it("does not fire on a superset of the modifiers", () => {
    // Otherwise Alt+1 would shadow every combination built on top of it.
    expect(matches(accelerator("Alt+1"), key("Digit1", { altKey: true, ctrlKey: true }))).toBe(
      false,
    );
  });

  it("does not fire on a subset of the modifiers", () => {
    expect(matches(accelerator("Alt+1"), key("Digit1"))).toBe(false);
  });

  it("does not fire on a different key", () => {
    expect(matches(accelerator("Alt+1"), key("Digit2", { altKey: true }))).toBe(false);
  });
});

describe("resolveBindings", () => {
  it("uses the default when there is no override", () => {
    const bindings = resolveBindings({});
    expect(bindings["toggle-terminal"]).toEqual(accelerator("Alt+1"));
  });

  it("uses an override in place of the default", () => {
    const bindings = resolveBindings({ "toggle-terminal": "Ctrl+Shift+T" });
    expect(bindings["toggle-terminal"]).toEqual(accelerator("Ctrl+Shift+T"));
  });

  it("treats an empty override as deliberately unbound", () => {
    expect(resolveBindings({ "toggle-terminal": "" })["toggle-terminal"]).toBeNull();
  });

  it("falls back to the default for an override that does not parse", () => {
    // A hand-edited config with a typo should lose the customisation, not the
    // action.
    const bindings = resolveBindings({ "toggle-terminal": "Alt+Wibble" });
    expect(bindings["toggle-terminal"]).toEqual(accelerator("Alt+1"));
  });

  it("ignores an override for an action that no longer exists", () => {
    expect(resolveBindings({ "removed-action": "Alt+9" })["removed-action"]).toBeUndefined();
  });

  it("resolves every registered action", () => {
    const bindings = resolveBindings({});
    for (const action of ACTIONS) {
      expect(bindings).toHaveProperty(action.id);
    }
  });
});

describe("actionFor", () => {
  const bindings = resolveBindings({});

  it("finds the action bound in that scope", () => {
    expect(actionFor(bindings, "workspace", key("Digit1", { altKey: true }))).toBe(
      "toggle-terminal",
    );
  });

  it("ignores an action belonging to another scope", () => {
    // Alt+1 toggles the terminal in the workspace; in a merge window it is
    // nothing, and must not steal the keystroke from the editor.
    expect(actionFor(bindings, "merge", key("Digit1", { altKey: true }))).toBeNull();
  });

  it("finds an action shared by two scopes from either of them", () => {
    expect(actionFor(bindings, "diff", key("Escape"))).toBe("close-window");
    expect(actionFor(bindings, "merge", key("Escape"))).toBe("close-window");
  });

  it("returns null for an unbound keystroke", () => {
    expect(actionFor(bindings, "workspace", key("KeyZ", { altKey: true }))).toBeNull();
  });

  it("fires nothing for an action the user unbound", () => {
    const unbound = resolveBindings({ "toggle-terminal": "" });
    expect(actionFor(unbound, "workspace", key("Digit1", { altKey: true }))).toBeNull();
  });
});

describe("conflictsWith", () => {
  const bindings = resolveBindings({});

  it("reports an action already holding the combination in the same scope", () => {
    expect(conflictsWith(bindings, "git-fetch", accelerator("Alt+1"))).toEqual([
      "toggle-terminal",
    ]);
  });

  it("reports nothing when the combination is free", () => {
    expect(conflictsWith(bindings, "git-fetch", accelerator("Alt+Shift+9"))).toEqual([]);
  });

  it("does not report the action against itself", () => {
    expect(conflictsWith(bindings, "toggle-terminal", accelerator("Alt+1"))).toEqual([]);
  });

  it("allows the same combination in two windows that never both see it", () => {
    // `close-window` lives in the diff and merge windows; the workspace never
    // sees Escape, so a workspace action may use it.
    expect(conflictsWith(bindings, "git-fetch", accelerator("Escape"))).toEqual([]);
  });

  it("reports a conflict when the scopes only partly overlap", () => {
    // `close-window` is in diff and merge; `next-conflict` only in merge. They
    // still collide, in the merge window.
    expect(conflictsWith(bindings, "next-conflict", accelerator("Escape"))).toEqual([
      "close-window",
    ]);
  });

  it("compares canonically, not by the text as typed", () => {
    expect(conflictsWith(bindings, "toggle-terminal", accelerator("Alt+Shift+9"))).toEqual([]);
    expect(conflictsWith(bindings, "git-fetch", accelerator("Alt+2"))).toEqual([
      "toggle-status-panel",
    ]);
  });
});

describe("isBindable", () => {
  it("accepts anything with Ctrl, Alt or Meta", () => {
    for (const text of ["Alt+1", "Ctrl+K", "Meta+K", "Ctrl+Alt+Shift+K"]) {
      expect(isBindable(accelerator(text))).toBe(true);
    }
  });

  it("refuses a bare letter or digit", () => {
    // The workspace handler swallows it in the capture phase before xterm sees
    // it, so binding one makes that character untypable in the terminal.
    expect(isBindable(accelerator("A"))).toBe(false);
    expect(isBindable(accelerator("1"))).toBe(false);
  });

  it("does not count Shift as a modifier", () => {
    // Shift+A is still a letter someone wants to type.
    expect(isBindable(accelerator("Shift+A"))).toBe(false);
  });

  it("accepts the bare keys that type nothing", () => {
    expect(isBindable(accelerator("Escape"))).toBe(true);
    expect(isBindable(accelerator("F5"))).toBe(true);
  });

  it("accepts every shipped default", () => {
    for (const action of ACTIONS) {
      expect(isBindable(accelerator(action.defaultAccelerator))).toBe(true);
    }
  });
});

describe("reservedBy", () => {
  it("names the menu item holding a workspace combination", () => {
    expect(reservedBy("toggle-terminal", accelerator("Ctrl+O"))).toContain("Open Folder");
    expect(reservedBy("toggle-terminal", accelerator("Cmd+,"))).toContain("Settings");
  });

  it("names the hardcoded save in the diff window", () => {
    expect(reservedBy("close-window", accelerator("Ctrl+S"))).toContain("saving");
  });

  it("reserves Ctrl+W in both secondary windows", () => {
    expect(reservedBy("close-window", accelerator("Ctrl+W"))).not.toBeNull();
    expect(reservedBy("next-conflict", accelerator("Ctrl+W"))).not.toBeNull();
  });

  it("names the terminals' editing keys in the workspace", () => {
    expect(reservedBy("toggle-terminal", accelerator("Ctrl+ArrowLeft"))).toContain("word editing");
    expect(reservedBy("toggle-terminal", accelerator("Ctrl+Backspace"))).toContain("word editing");
    expect(reservedBy("toggle-terminal", accelerator("Alt+ArrowRight"))).toContain("word editing");
    expect(reservedBy("toggle-terminal", accelerator("Cmd+ArrowLeft"))).toContain("line editing");
  });

  it("reserves the numpad arrows too, which the terminals also translate", () => {
    // The one spelling the two tables disagree on: with NumLock off the numpad
    // arrows report `key: ArrowLeft`, which `terminalKeys` translates, under a
    // `Numpad4` code, which is what this registry would record.
    expect(reservedBy("toggle-terminal", accelerator("Ctrl+Numpad4"))).toContain("word editing");
    expect(reservedBy("toggle-terminal", accelerator("Alt+Numpad6"))).toContain("word editing");
    expect(reservedBy("toggle-terminal", accelerator("Cmd+Numpad4"))).toContain("line editing");
  });

  it("does not reserve a combination in a scope that never sees it", () => {
    // Ctrl+O is a File-menu accelerator, which only the workspace has.
    expect(reservedBy("close-window", accelerator("Ctrl+O"))).toBeNull();
    // Ctrl+S is hardcoded in the diff window only.
    expect(reservedBy("next-conflict", accelerator("Ctrl+S"))).toBeNull();
    // The editor windows have no terminal, and Ctrl+ArrowLeft is word motion
    // inside CodeMirror there, so refusing it would cost a binding for nothing.
    expect(reservedBy("next-change", accelerator("Ctrl+ArrowLeft"))).toBeNull();
    expect(reservedBy("next-conflict", accelerator("Ctrl+Backspace"))).toBeNull();
  });

  it("reports nothing for a free combination", () => {
    expect(reservedBy("toggle-terminal", accelerator("Alt+9"))).toBeNull();
  });
});

describe("the action registry", () => {
  it("has no two actions sharing an id", () => {
    const ids = ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every action a parseable default", () => {
    for (const action of ACTIONS) {
      expect(parseAccelerator(action.defaultAccelerator)).not.toBeNull();
    }
  });

  it("ships no default that is reserved elsewhere", () => {
    for (const action of ACTIONS) {
      expect(reservedBy(action.id, accelerator(action.defaultAccelerator))).toBeNull();
    }
  });

  it("binds no workspace action to a bare Alt+letter", () => {
    // Readline uses M-f, M-b and friends constantly, and the workspace handler
    // swallows what it binds before the shell can see it.
    for (const action of ACTIONS.filter((a) => a.scopes.includes("workspace"))) {
      const parsed = accelerator(action.defaultAccelerator);
      const bareAltLetter = parsed.alt && !parsed.ctrl && !parsed.meta && /^Key/.test(parsed.code);
      expect(bareAltLetter, `${action.id} uses ${action.defaultAccelerator}`).toBe(false);
    }
  });

  it("ships no defaults that conflict with each other", () => {
    const bindings = resolveBindings({});
    for (const action of ACTIONS) {
      const own = bindings[action.id];
      expect(own).not.toBeNull();
      expect(conflictsWith(bindings, action.id, own!)).toEqual([]);
    }
  });

  it("gives every action at least one scope", () => {
    for (const action of ACTIONS) {
      expect(action.scopes.length).toBeGreaterThan(0);
    }
  });
});

describe("labelFor", () => {
  it("names a registered action", () => {
    expect(labelFor("toggle-terminal")).toBe("Toggle the bottom terminal");
  });

  it("falls back to the id for one we do not have", () => {
    expect(labelFor("removed-action")).toBe("removed-action");
  });
});
