// Turning stored settings into the values the four windows actually render
// with, and pushing them at the surfaces that cannot read CSS.
//
// Three of them cannot: xterm draws to a canvas, Monaco and CodeMirror hold
// their own option objects. So there are two halves here — CSS custom
// properties for everything written in CSS, and an `Appearance` object the
// editor/terminal modules subscribe to. Both come from the same resolve step,
// so they can never disagree.

import { themeById, type Theme } from "../theme/themes";
import type { Settings } from "./settings";

/**
 * Fallback stack, used when no family is chosen. Deliberately not a single
 * family: the first three are common developer fonts and the last two are the
 * macOS and Windows system monospace, so a fresh install renders correctly
 * everywhere without asking.
 *
 * It is also why the setting stores an empty string rather than this string:
 * "no choice made" must stay distinguishable from "chose this exact stack", or
 * a future change to the default could never reach an existing install.
 */
export const DEFAULT_MONO_STACK = "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace";

export interface Appearance {
  /** Ready for CSS `font-family`, xterm and both editors. */
  fontFamily: string;
  fontSize: number;
  theme: Theme;
}

/**
 * CSS custom property carrying the mono font, so stylesheets can use the same
 * value the terminal does without importing anything.
 */
export const FONT_FAMILY_VAR = "--ib-mono-family";
export const FONT_SIZE_VAR = "--ib-mono-size";

/**
 * CSS custom property for a theme token: `bgChrome` becomes `--ib-bg-chrome`.
 *
 * Derived rather than listed, so a token added to `ThemeTokens` is usable in
 * CSS immediately and there is no second list to keep in step.
 */
export function tokenVar(name: string): string {
  return `--ib-${name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`;
}

/**
 * Quote a chosen family so a name with spaces (almost every Nerd Font:
 * "JetBrainsMono Nerd Font Mono") is one family and not several.
 *
 * A family the user typed with quotes already, or a comma-separated stack they
 * pasted in, is passed through untouched: quoting it again would produce one
 * nonsense family name.
 */
function quoteFamily(family: string): string {
  if (family.includes(",") || family.includes("'") || family.includes('"')) return family;
  return `'${family}'`;
}

/**
 * Resolve settings into what to render with. A chosen family keeps the default
 * stack behind it as a fallback, so a font that has since been uninstalled
 * degrades to something readable instead of the browser's proportional default.
 */
export function resolveAppearance(settings: Settings): Appearance {
  const chosen = settings.fontFamily.trim();
  return {
    fontFamily: chosen === "" ? DEFAULT_MONO_STACK : `${quoteFamily(chosen)}, ${DEFAULT_MONO_STACK}`,
    fontSize: settings.fontSize,
    theme: themeById(settings.theme),
  };
}

/**
 * Write the appearance onto an element's inline custom properties.
 *
 * Also sets `data-theme` to the theme id. Nothing in the app styles on it
 * today, since every colour is a token, but it is the escape hatch for the one
 * rule a future theme needs that cannot be expressed as a colour, and it makes
 * the active theme visible when inspecting the DOM.
 */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  root.style.setProperty(FONT_FAMILY_VAR, appearance.fontFamily);
  root.style.setProperty(FONT_SIZE_VAR, `${appearance.fontSize}px`);
  for (const [name, value] of Object.entries(appearance.theme.tokens)) {
    root.style.setProperty(tokenVar(name), value);
  }
  root.dataset.theme = appearance.theme.id;
}

// --- Subscribers -----------------------------------------------------------
//
// xterm, Monaco and CodeMirror each hold their own copy of the font, and each
// needs a different call to change it. Rather than have this module import all
// three (and drag Monaco into the main bundle), they register here.

type AppearanceListener = (appearance: Appearance) => void;

const listeners = new Set<AppearanceListener>();
let current: Appearance | null = null;

/**
 * Follow appearance changes. The listener fires immediately with the current
 * value if one has already been published, so a terminal or editor created
 * after startup is never left on the defaults.
 */
export function onAppearance(listener: AppearanceListener): () => void {
  listeners.add(listener);
  if (current !== null) listener(current);
  return () => listeners.delete(listener);
}

/** The appearance published so far, or null before the first settings read. */
export function currentAppearance(): Appearance | null {
  return current;
}

/**
 * Publish an appearance: writes the CSS variables and notifies every
 * subscriber. Called from each window's settings subscription.
 */
export function publishAppearance(root: HTMLElement, appearance: Appearance): void {
  current = appearance;
  applyAppearance(root, appearance);
  for (const listener of listeners) listener(appearance);
}

/**
 * Test seam: forget the published value, so the next test starts from "nothing
 * has been published yet".
 *
 * Deliberately leaves the subscribers alone. Some are registered at module load
 * (`lib/ptySession` follows the font for every live terminal), and clearing the
 * set would unhook them for the rest of the file with nothing to re-register
 * them.
 */
export function resetAppearance(): void {
  current = null;
}
