import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAppearance,
  currentAppearance,
  DEFAULT_MONO_STACK,
  FONT_FAMILY_VAR,
  FONT_SIZE_VAR,
  onAppearance,
  publishAppearance,
  resetAppearance,
  resolveAppearance,
} from "./appearance";
import type { Settings } from "./settings";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings: {},
    lastProject: null,
    recentProjects: [],
    ...overrides,
  };
}

/** Unsubscribed in afterEach: resetAppearance deliberately leaves them alone. */
const subscriptions: (() => void)[] = [];

/** Subscribe and register the unsubscribe for cleanup. */
function subscribe(listener: (appearance: { fontFamily: string; fontSize: number }) => void) {
  subscriptions.push(onAppearance(listener));
}

afterEach(() => {
  for (const off of subscriptions.splice(0)) off();
  resetAppearance();
});

describe("resolveAppearance", () => {
  it("falls back to the built-in stack when no family is chosen", () => {
    expect(resolveAppearance(settings()).fontFamily).toBe(DEFAULT_MONO_STACK);
  });

  it("treats a blank family as no choice", () => {
    expect(resolveAppearance(settings({ fontFamily: "   " })).fontFamily).toBe(DEFAULT_MONO_STACK);
  });

  it("quotes a chosen family so a name with spaces stays one family", () => {
    const { fontFamily } = resolveAppearance(settings({ fontFamily: "JetBrainsMono Nerd Font" }));
    expect(fontFamily).toBe(`'JetBrainsMono Nerd Font', ${DEFAULT_MONO_STACK}`);
  });

  it("keeps the default stack behind the choice as a fallback", () => {
    // A font that has since been uninstalled must degrade to something
    // monospaced, not to the browser's proportional default.
    expect(resolveAppearance(settings({ fontFamily: "Gone Mono" })).fontFamily).toContain(
      DEFAULT_MONO_STACK,
    );
  });

  it("passes a family the user already quoted straight through", () => {
    const { fontFamily } = resolveAppearance(settings({ fontFamily: "'Fira Code'" }));
    expect(fontFamily).toBe(`'Fira Code', ${DEFAULT_MONO_STACK}`);
  });

  it("passes a comma-separated stack straight through", () => {
    const { fontFamily } = resolveAppearance(settings({ fontFamily: "Menlo, monospace" }));
    expect(fontFamily).toBe(`Menlo, monospace, ${DEFAULT_MONO_STACK}`);
  });

  it("carries the font size through unchanged", () => {
    expect(resolveAppearance(settings({ fontSize: 18 })).fontSize).toBe(18);
  });
});

describe("applyAppearance", () => {
  it("writes both custom properties in px", () => {
    const root = document.createElement("div");
    applyAppearance(root, { fontFamily: "'Fira Code'", fontSize: 16 });
    expect(root.style.getPropertyValue(FONT_FAMILY_VAR)).toBe("'Fira Code'");
    expect(root.style.getPropertyValue(FONT_SIZE_VAR)).toBe("16px");
  });
});

describe("publishAppearance", () => {
  it("notifies every subscriber and records the value", () => {
    const root = document.createElement("div");
    const first = vi.fn();
    const second = vi.fn();
    subscribe(first);
    subscribe(second);

    const appearance = { fontFamily: "'Fira Code'", fontSize: 15 };
    publishAppearance(root, appearance);

    expect(first).toHaveBeenCalledWith(appearance);
    expect(second).toHaveBeenCalledWith(appearance);
    expect(currentAppearance()).toEqual(appearance);
  });

  it("replays the current value to a subscriber that arrives late", () => {
    // A terminal or editor created after startup must not be left on the
    // defaults just because it missed the event.
    const appearance = { fontFamily: "'Fira Code'", fontSize: 15 };
    publishAppearance(document.createElement("div"), appearance);

    const listener = vi.fn();
    subscribe(listener);
    expect(listener).toHaveBeenCalledWith(appearance);
  });

  it("does not call a subscriber before anything has been published", () => {
    const listener = vi.fn();
    subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops calling a subscriber once it unsubscribes", () => {
    const listener = vi.fn();
    const off = onAppearance(listener);
    off();
    publishAppearance(document.createElement("div"), { fontFamily: "x", fontSize: 12 });
    expect(listener).not.toHaveBeenCalled();
  });
});
