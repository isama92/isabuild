// Painting a window in the right colours on its very first frame.
//
// Every colour in the CSS is `var(--ib-…)`, and those custom properties are
// written by `applyAppearance` once the settings have been read. Between the
// document loading and that read resolving, the variables are unset and the
// window paints as unstyled — so this runs synchronously at module load, before
// React renders anything.
//
// The main window has nothing better than the default to go on: its settings
// arrive with `bootstrap`, one IPC round trip later. A light-theme user sees a
// dark frame for that long. The secondary windows do better, because whoever
// opened them already knew the theme and puts its id in the URL.
//
// It *publishes* rather than merely applying, because the CSS variables are
// only half the story: xterm, Monaco and CodeMirror seed themselves from
// `currentAppearance()`, and leaving that null would paint the chrome in the
// right theme with a dark editor filling most of the window.

import { DEFAULT_MONO_STACK, publishAppearance } from "../lib/appearance";
import { DEFAULT_THEME, themeById, type Theme } from "./themes";

/** Query-string key carrying the theme id to a secondary window. */
export const THEME_PARAM = "theme";

/** The theme named in `search`, or the default when it names none we know. */
export function themeFromSearch(search: string): Theme {
  const id = new URLSearchParams(search).get(THEME_PARAM);
  return id === null ? DEFAULT_THEME : themeById(id);
}

/**
 * Paint the document in `search`'s theme (or the default), with the built-in
 * font stack. Both are corrected by the real settings a moment later.
 */
export function applyInitialTheme(search: string): void {
  publishAppearance(document.documentElement, {
    // The built-in stack rather than the stored family, which is not knowable
    // synchronously either. Writing the fallback explicitly, not leaving the
    // property unset: an unset custom property makes every rule that reads it
    // invalid at computed-value time, which is worse than the wrong font.
    fontFamily: DEFAULT_MONO_STACK,
    fontSize: 14,
    theme: themeFromSearch(search),
  });
}
