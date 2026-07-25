import { afterEach, describe, expect, it } from "vitest";
import { applyInitialTheme, themeFromSearch, THEME_PARAM } from "./initialTheme";
import { DEFAULT_THEME, themeById } from "./themes";
import { currentAppearance, FONT_FAMILY_VAR, resetAppearance, tokenVar } from "../lib/appearance";

afterEach(() => {
  resetAppearance();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

describe("themeFromSearch", () => {
  it("reads the theme the opener named", () => {
    expect(themeFromSearch(`?${THEME_PARAM}=vscode-light`).id).toBe("vscode-light");
  });

  it("falls back to the default with no parameter", () => {
    // The main window's case: it has nothing to go on until bootstrap resolves.
    expect(themeFromSearch("")).toBe(DEFAULT_THEME);
    expect(themeFromSearch("?repo=/repos/one&path=a.ts")).toBe(DEFAULT_THEME);
  });

  it("falls back to the default for a theme id we do not have", () => {
    expect(themeFromSearch(`?${THEME_PARAM}=solarized-mist`)).toBe(DEFAULT_THEME);
  });

  it("reads the theme alongside the other window parameters", () => {
    const search = `?repo=%2Frepos%2Fone&path=a.ts&${THEME_PARAM}=vscode-light`;
    expect(themeFromSearch(search)).toBe(themeById("vscode-light"));
  });
});

describe("applyInitialTheme", () => {
  it("paints the document before anything has read the settings", () => {
    applyInitialTheme(`?${THEME_PARAM}=vscode-light`);

    const light = themeById("vscode-light");
    expect(document.documentElement.style.getPropertyValue(tokenVar("bg"))).toBe(light.tokens.bg);
    expect(document.documentElement.dataset.theme).toBe("vscode-light");
  });

  it("publishes, so the editors and the terminal see it too", () => {
    // The CSS variables are only half of it: xterm, Monaco and CodeMirror seed
    // themselves from `currentAppearance()`, and merely applying would leave a
    // correctly-themed chrome around a default-themed editor.
    applyInitialTheme(`?${THEME_PARAM}=vscode-light`);
    expect(currentAppearance()?.theme).toBe(themeById("vscode-light"));
  });

  it("writes the font stack explicitly rather than leaving it unset", () => {
    // An unset custom property makes every rule that reads it invalid at
    // computed-value time, which is worse than the wrong font.
    applyInitialTheme("");
    expect(document.documentElement.style.getPropertyValue(FONT_FAMILY_VAR)).not.toBe("");
  });
});
