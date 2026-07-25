import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAppearance,
  type Appearance,
  currentAppearance,
  DEFAULT_MONO_STACK,
  FONT_FAMILY_VAR,
  FONT_SIZE_VAR,
  onAppearance,
  publishAppearance,
  resetAppearance,
  resolveAppearance,
  tokenVar,
} from "./appearance";
import type { Settings } from "./settings";
import { DEFAULT_THEME, themeById, THEMES } from "../theme/themes";

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
function subscribe(listener: (appearance: Appearance) => void) {
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

describe("resolveAppearance theme", () => {
  it("resolves the stored id to its theme", () => {
    expect(resolveAppearance(settings({ theme: "vscode-light" })).theme.id).toBe("vscode-light");
  });

  it("falls back to the default for a theme id we do not have", () => {
    // A hand-edited config, or a downgrade. Falling back beats not painting.
    expect(resolveAppearance(settings({ theme: "solarized-mist" })).theme).toBe(DEFAULT_THEME);
  });
});

describe("applyAppearance", () => {
  it("writes both font properties, in px", () => {
    const root = document.createElement("div");
    applyAppearance(root, { fontFamily: "'Fira Code'", fontSize: 16, theme: DEFAULT_THEME });
    expect(root.style.getPropertyValue(FONT_FAMILY_VAR)).toBe("'Fira Code'");
    expect(root.style.getPropertyValue(FONT_SIZE_VAR)).toBe("16px");
  });

  it("writes a custom property for every token in the theme", () => {
    // The CSS reads these by name; a token added to the type but not written
    // here would silently paint as unstyled.
    const root = document.createElement("div");
    applyAppearance(root, { fontFamily: "x", fontSize: 14, theme: DEFAULT_THEME });

    for (const [name, value] of Object.entries(DEFAULT_THEME.tokens)) {
      expect(root.style.getPropertyValue(tokenVar(name))).toBe(value);
    }
  });

  it("records the theme id on the element", () => {
    const root = document.createElement("div");
    applyAppearance(root, {
      fontFamily: "x",
      fontSize: 14,
      theme: themeById("vscode-light"),
    });
    expect(root.dataset.theme).toBe("vscode-light");
  });

  it("replaces every token when the theme changes", () => {
    // Not merged over the previous one: a token that only one theme defined
    // would otherwise survive into the other.
    const root = document.createElement("div");
    applyAppearance(root, { fontFamily: "x", fontSize: 14, theme: DEFAULT_THEME });
    applyAppearance(root, { fontFamily: "x", fontSize: 14, theme: themeById("vscode-light") });

    expect(root.style.getPropertyValue(tokenVar("bg"))).toBe(
      themeById("vscode-light").tokens.bg,
    );
  });
});

describe("tokenVar", () => {
  it("kebab-cases a camelCase token name", () => {
    expect(tokenVar("bg")).toBe("--ib-bg");
    expect(tokenVar("bgChrome")).toBe("--ib-bg-chrome");
    expect(tokenVar("ansiBrightBlack")).toBe("--ib-ansi-bright-black");
  });
});

describe("the theme registry", () => {
  it("gives every theme the same set of tokens", () => {
    // A token missing from one theme is a colour that silently disappears when
    // that theme is chosen.
    const reference = Object.keys(DEFAULT_THEME.tokens).sort();
    for (const theme of THEMES) {
      expect(Object.keys(theme.tokens).sort()).toEqual(reference);
    }
  });

  it("has no two themes sharing an id", () => {
    const ids = THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the default", () => {
    expect(THEMES).toContain(DEFAULT_THEME);
  });

  it("names the default the backend also defaults to", () => {
    // Duplicated across the language boundary, so it is pinned on both sides:
    // the other half is `the_default_theme_id_matches_the_frontend_registry`
    // in src-tauri/src/settings.rs. Changing the default means changing both.
    expect(DEFAULT_THEME.id).toBe("vscode-dark");
  });
});

describe("publishAppearance", () => {
  it("notifies every subscriber and records the value", () => {
    const root = document.createElement("div");
    const first = vi.fn();
    const second = vi.fn();
    subscribe(first);
    subscribe(second);

    const appearance = { fontFamily: "'Fira Code'", fontSize: 15, theme: DEFAULT_THEME };
    publishAppearance(root, appearance);

    expect(first).toHaveBeenCalledWith(appearance);
    expect(second).toHaveBeenCalledWith(appearance);
    expect(currentAppearance()).toEqual(appearance);
  });

  it("replays the current value to a subscriber that arrives late", () => {
    // A terminal or editor created after startup must not be left on the
    // defaults just because it missed the event.
    const appearance = { fontFamily: "'Fira Code'", fontSize: 15, theme: DEFAULT_THEME };
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
    publishAppearance(document.createElement("div"), { fontFamily: "x", fontSize: 12, theme: DEFAULT_THEME });
    expect(listener).not.toHaveBeenCalled();
  });
});
