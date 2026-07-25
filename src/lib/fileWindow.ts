// Opening a per-file window from the main window, shared by the diff window
// (Part 4) and the merge window (Part 6). Both want the same three things: one
// window per file, a label that is a pure function of that file, and a creation
// failure that surfaces instead of vanishing.
//
// Extracted from lib/diffWindow so the Tauri label rules live in exactly one
// place. The label format is unchanged, deliberately: a diff window's label is
// how an already-open window is found again.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentAppearance } from "./appearance";
import { DEFAULT_THEME } from "../theme/themes";
import { THEME_PARAM } from "../theme/initialTheme";

export interface FileTarget {
  /** Repository root, as resolved by `git_status`. */
  repoRoot: string;
  /** Repo-relative path with forward slashes, as git reports it. */
  path: string;
}

/**
 * Window label for a target: `<prefix>-<slug>-<hash>`, a readable slug of the
 * path plus an FNV-1a hash of repo root *and* path, so two files that slugify
 * the same still get separate windows.
 *
 * Tauri only accepts alphanumerics, `-`, `/`, `:` and `_` in a label, and `/`
 * would read as a nested path in event names, so the slug keeps neither.
 *
 * The repo root belongs in the hash: the same relative path exists in every
 * checkout, and focusing another repo's window would show — and write to — the
 * wrong file.
 *
 * The two fields are joined with NUL because no path can contain one. A printable
 * separator would make `("/repo", "a b/x.ts")` and `("/repo a", "b/x.ts")` hash
 * alike, and since the slug keeps only the tail of the path, those two can also
 * slugify the same — which is exactly the wrong-file collision the repo root is in
 * the hash to prevent.
 */
export function fileWindowLabel(prefix: string, target: FileTarget): string {
  const identity = `${target.repoRoot}\0${target.path}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i += 1) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const slug = target.path.replace(/[^a-zA-Z0-9]+/g, "_").slice(-40);
  return `${prefix}-${slug}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface OpenFileWindowOptions {
  label: string;
  /** Document URL, including the query string carrying the target. */
  url: string;
  title: string;
  /**
   * What to call this window if it cannot be opened, e.g. "the diff window". The
   * failure is shown to the user, and a label like `diff-src_a_ts-44df0b71` says
   * nothing to them.
   */
  subject: string;
  width: number;
  height: number;
}

/**
 * Focus the window already open for this label, or create it. Rejects with an
 * actionable message when creation fails, so the caller can surface it rather
 * than leaving a click that did nothing.
 */
export async function openFileWindow(options: OpenFileWindowOptions): Promise<void> {
  const existing = await WebviewWindow.getByLabel(options.label);
  if (existing) {
    // Unminimize first: focusing a minimised window does nothing on its own, so
    // the second click on a file would look like it did nothing at all.
    await existing.unminimize();
    await existing.setFocus();
    return;
  }

  const created = new WebviewWindow(options.label, {
    url: options.url,
    title: options.title,
    width: options.width,
    height: options.height,
  });

  // The constructor is fire-and-forget: creation failures only arrive as an
  // event, so await the outcome to keep them from being swallowed. (Registering
  // the listeners after the constructor's own invoke is the pattern Tauri
  // documents; in the worst case a very fast success leaves this promise
  // pending, which costs nothing — the window is open either way.)
  await new Promise<void>((resolve, reject) => {
    void created.once("tauri://created", () => resolve());
    void created.once<string>("tauri://error", (event) => {
      reject(new Error(`could not open ${options.subject}: ${event.payload}`));
    });
  });
}

/**
 * Add the opener's theme id to a new window's query string.
 *
 * A new document paints before it can read the settings, and every colour in
 * the CSS is a custom property that is unset until then. The opener already
 * knows the answer, so it says so in the URL and the new window is right on its
 * first frame rather than flashing the default and correcting itself.
 */
export function withTheme(params: URLSearchParams): URLSearchParams {
  params.set(THEME_PARAM, currentAppearance()?.theme.id ?? DEFAULT_THEME.id);
  return params;
}
