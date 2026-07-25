// Keyboard shortcuts: what can be bound, how an accelerator is written, and
// whether a keystroke matches one.
//
// Entirely pure. The hooks decide when to listen (`useGlobalKeybindings` in the
// workspace, the window components in the diff and merge windows) and the
// settings window renders the registry; nothing here touches the DOM or the
// store.
//
// ## Physical keys, readable text
//
// Matching is on `KeyboardEvent.code`, so a binding is layout-independent:
// Alt+1 is the same physical key on QWERTY and AZERTY, and Alt+Z does not
// become Alt+W on a French keyboard. But `Digit1` is not something to show a
// user or to hand-edit in `config.json`, so the *stored* and *displayed* form
// is the readable one (`Alt+1`) and this module maps between them.
//
// ## Ctrl/Cmd+W is deliberately not in the registry
//
// Closing a window with Ctrl/Cmd+W is an OS convention, not a preference, and a
// user who rebound it away would have no way back from a window with no menu.
// The diff and merge windows keep it hardcoded alongside the bindable
// `close-window` action.

/** Which windows an action exists in. An action can belong to more than one. */
export type Scope = "workspace" | "diff" | "merge";

export interface KeyAction {
  /** Stable id; the key in `settings.keybindings`. Never change one in place. */
  id: string;
  /** Shown in the settings window. */
  label: string;
  scopes: readonly Scope[];
  /** Accelerator used when the settings hold no override for this action. */
  defaultAccelerator: string;
}

/**
 * Every bindable action.
 *
 * The order is the order the settings window lists them in, grouped by scope.
 *
 * ## Why the workspace defaults are all Alt+<digit>
 *
 * `useGlobalKeybindings` listens in the capture phase and stops propagation, so
 * a bound key never reaches xterm and never reaches the shell. That rules out
 * bare Alt+<letter>: in readline (bash, zsh's emacs mode, and Claude Code's own
 * input) `M-f` and `M-b` are forward-word and backward-word, two of the most
 * used combinations there are, and swallowing them would break word motion in
 * an app whose whole point is an embedded terminal — silently, with nothing
 * connecting the symptom to the cause.
 *
 * Alt+<digit> is not free either: readline reads `M-3` as a numeric argument.
 * But that is rare where word motion is constant, and Alt+1 / Alt+2 have cost
 * exactly that since Part 2. Extending the same scheme keeps the trade in one
 * place rather than spreading it over the alphabet.
 */
export const ACTIONS: readonly KeyAction[] = [
  {
    id: "toggle-terminal",
    label: "Toggle the bottom terminal",
    scopes: ["workspace"],
    defaultAccelerator: "Alt+1",
  },
  {
    id: "toggle-status-panel",
    label: "Toggle the Status panel",
    scopes: ["workspace"],
    defaultAccelerator: "Alt+2",
  },
  {
    id: "git-fetch",
    label: "Fetch",
    scopes: ["workspace"],
    defaultAccelerator: "Alt+3",
  },
  {
    id: "git-pull",
    label: "Pull",
    scopes: ["workspace"],
    defaultAccelerator: "Alt+4",
  },
  {
    id: "git-push",
    label: "Push (or publish the branch)",
    scopes: ["workspace"],
    defaultAccelerator: "Alt+5",
  },
  {
    id: "branch-menu",
    label: "Open the branch menu",
    scopes: ["workspace"],
    defaultAccelerator: "Alt+6",
  },
  {
    id: "close-window",
    label: "Close the window",
    scopes: ["diff", "merge"],
    defaultAccelerator: "Escape",
  },
  {
    id: "next-conflict",
    label: "Next conflict",
    scopes: ["merge"],
    defaultAccelerator: "Alt+ArrowDown",
  },
  {
    id: "previous-conflict",
    label: "Previous conflict",
    scopes: ["merge"],
    defaultAccelerator: "Alt+ArrowUp",
  },
];

export interface Accelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** A `KeyboardEvent.code` value. */
  code: string;
}

/**
 * Readable name to `KeyboardEvent.code`, for the keys whose code is not simply
 * the name. Letters and digits are derived rather than listed.
 */
const NAMED_CODES: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
};

/** Inverse of [`NAMED_CODES`], for display. */
const CODE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(NAMED_CODES).map(([name, code]) => [code, name]),
);

/** Modifier names accepted on input, mapped to the canonical field. */
const MODIFIERS: Record<string, keyof Omit<Accelerator, "code">> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
};

/** The readable name for a key code, or null when we have no name for it. */
function nameForCode(code: string): string | null {
  if (CODE_NAMES[code] !== undefined) return CODE_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Numpad${code.slice(6)}`;
  if (/^F[1-9][0-9]?$/.test(code)) return code;
  return null;
}

/** The key code for a readable name, or null when it names no key we accept. */
function codeForName(name: string): string | null {
  if (NAMED_CODES[name] !== undefined) return NAMED_CODES[name];
  if (/^[A-Za-z]$/.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  if (/^Numpad[0-9]$/i.test(name)) return `Numpad${name.slice(6)}`;
  if (/^[Ff][1-9][0-9]?$/.test(name)) return name.toUpperCase();
  return null;
}

/**
 * Parse `Alt+Shift+P` into an accelerator, or null when it is not one.
 *
 * Null covers a typo in a hand-edited `config.json` as much as a bad recording,
 * and both want the same answer: fall back to the default rather than bind
 * something nobody asked for.
 */
export function parseAccelerator(text: string): Accelerator | null {
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;

  const accelerator: Accelerator = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    code: "",
  };
  // Everything before the last part must be a modifier; the last must be a key.
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier === undefined) return null;
    if (accelerator[modifier]) return null; // the same modifier twice
    accelerator[modifier] = true;
  }
  const code = codeForName(parts[parts.length - 1]);
  if (code === null) return null;
  accelerator.code = code;
  return accelerator;
}

/**
 * Canonical text for an accelerator. Always the same order, so two spellings of
 * one combination compare equal as strings.
 */
export function formatAccelerator(accelerator: Accelerator): string {
  const parts: string[] = [];
  if (accelerator.ctrl) parts.push("Ctrl");
  if (accelerator.alt) parts.push("Alt");
  if (accelerator.shift) parts.push("Shift");
  if (accelerator.meta) parts.push("Meta");
  parts.push(nameForCode(accelerator.code) ?? accelerator.code);
  return parts.join("+");
}

/** Modifier-only key codes, which cannot be an accelerator on their own. */
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/**
 * The accelerator a keystroke represents, or null when it is not one.
 *
 * Null for a modifier pressed on its own, which is what the settings recorder
 * sees continuously while the user holds Alt looking for the next key.
 */
export function acceleratorFromEvent(event: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): Accelerator | null {
  if (MODIFIER_CODES.test(event.code)) return null;
  if (nameForCode(event.code) === null) return null;
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    code: event.code,
  };
}

/**
 * Whether a keystroke is exactly this accelerator.
 *
 * Modifiers are compared exactly, not as a superset: Alt+1 must not fire on
 * Ctrl+Alt+1, or a binding would shadow every combination built on top of it.
 */
export function matches(accelerator: Accelerator, event: KeyboardEvent): boolean {
  return (
    event.code === accelerator.code &&
    event.ctrlKey === accelerator.ctrl &&
    event.altKey === accelerator.alt &&
    event.shiftKey === accelerator.shift &&
    event.metaKey === accelerator.meta
  );
}

/** An action's accelerator id-keyed, `null` where the action is unbound. */
export type Bindings = Record<string, Accelerator | null>;

/**
 * Resolve the stored overrides against the defaults.
 *
 * Three cases, all reachable from a hand-edited file: no entry means the
 * default, an empty string means deliberately unbound, and an entry that does
 * not parse falls back to the default rather than leaving the action dead with
 * no explanation.
 */
export function resolveBindings(overrides: Record<string, string>): Bindings {
  const bindings: Bindings = {};
  for (const action of ACTIONS) {
    const override = overrides[action.id];
    if (override === undefined) {
      bindings[action.id] = parseAccelerator(action.defaultAccelerator);
      continue;
    }
    if (override.trim() === "") {
      bindings[action.id] = null;
      continue;
    }
    bindings[action.id] = parseAccelerator(override) ?? parseAccelerator(action.defaultAccelerator);
  }
  return bindings;
}

/** The action `event` triggers within `scope`, or null. */
export function actionFor(bindings: Bindings, scope: Scope, event: KeyboardEvent): string | null {
  for (const action of ACTIONS) {
    if (!action.scopes.includes(scope)) continue;
    const accelerator = bindings[action.id];
    if (accelerator !== null && accelerator !== undefined && matches(accelerator, event)) {
      return action.id;
    }
  }
  return null;
}

/**
 * The ids of actions already bound to `accelerator` in a scope `actionId` also
 * lives in.
 *
 * Two actions in different windows may share a combination quite happily; only
 * an overlap in the same window is a conflict, and only then is the second one
 * unreachable.
 */
export function conflictsWith(
  bindings: Bindings,
  actionId: string,
  accelerator: Accelerator,
): string[] {
  const subject = ACTIONS.find((action) => action.id === actionId);
  if (subject === undefined) return [];
  const wanted = formatAccelerator(accelerator);
  return ACTIONS.filter((action) => action.id !== actionId)
    .filter((action) => action.scopes.some((scope) => subject.scopes.includes(scope)))
    .filter((action) => {
      const existing = bindings[action.id];
      return existing != null && formatAccelerator(existing) === wanted;
    })
    .map((action) => action.id);
}

/**
 * Combinations the app has reserved outside the registry, per scope.
 *
 * The native menu's accelerators are handled by the OS before the webview sees
 * a keystroke, and Ctrl/Cmd+W and Ctrl/Cmd+S are hardcoded in the secondary
 * windows. Binding an action to one of these produces a row that looks bound
 * and does nothing (or, for Ctrl+S in the diff window, shadows the save), so
 * the settings window refuses them with a reason.
 *
 * Both the Ctrl and the Meta spelling are listed on every platform, even though
 * `CmdOrCtrl` resolves to exactly one of them per platform. Refusing the
 * inapplicable one costs nothing and keeps a config that travels between a Mac
 * and a Linux box working on both — which is why the refusal says a combination
 * *could* clash rather than asserting it is taken here.
 */
const RESERVED: readonly { accelerator: string; by: string; scopes: readonly Scope[] }[] = [
  { accelerator: "Ctrl+O", by: "Open Folder in the File menu", scopes: ["workspace"] },
  { accelerator: "Meta+O", by: "Open Folder in the File menu", scopes: ["workspace"] },
  { accelerator: "Ctrl+,", by: "Settings in the File menu", scopes: ["workspace"] },
  { accelerator: "Meta+,", by: "Settings in the File menu", scopes: ["workspace"] },
  { accelerator: "Ctrl+Q", by: "Exit in the File menu", scopes: ["workspace"] },
  { accelerator: "Meta+Q", by: "Quit", scopes: ["workspace"] },
  { accelerator: "Ctrl+W", by: "closing the window", scopes: ["diff", "merge"] },
  { accelerator: "Meta+W", by: "closing the window", scopes: ["diff", "merge"] },
  { accelerator: "Ctrl+S", by: "saving in the diff window", scopes: ["diff"] },
  { accelerator: "Meta+S", by: "saving in the diff window", scopes: ["diff"] },
];

/**
 * What has already reserved this combination in a scope `actionId` lives in, or
 * null when nothing has.
 */
export function reservedBy(actionId: string, accelerator: Accelerator): string | null {
  const subject = ACTIONS.find((action) => action.id === actionId);
  if (subject === undefined) return null;
  const wanted = formatAccelerator(accelerator);
  const clash = RESERVED.find(
    (entry) =>
      entry.accelerator === wanted &&
      entry.scopes.some((scope) => subject.scopes.includes(scope)),
  );
  return clash?.by ?? null;
}

/**
 * Keys that may be bound with no Ctrl, Alt or Meta: they type nothing, so
 * swallowing them costs the terminal and the editors nothing.
 */
const BARE_ALLOWED = /^(Escape|F[1-9][0-9]?)$/;

/**
 * Whether this combination is safe to bind at all.
 *
 * Without this, recording a bare `a` binds the letter: the workspace handler
 * swallows it in the capture phase before xterm sees it, and the window handler
 * cancels the insertion the editor would otherwise make, so that letter becomes
 * untypable. Shift alone does not count as a modifier, because Shift+A is still
 * a letter someone wants to type.
 *
 * Only the settings window enforces this. A hand-edited `config.json` is
 * trusted, as everywhere else: someone who binds `a` by hand can unbind it the
 * same way.
 */
export function isBindable(accelerator: Accelerator): boolean {
  if (accelerator.ctrl || accelerator.alt || accelerator.meta) return true;
  return BARE_ALLOWED.test(accelerator.code);
}

/** Display label for an action id, for a conflict message. */
export function labelFor(actionId: string): string {
  return ACTIONS.find((action) => action.id === actionId)?.label ?? actionId;
}
