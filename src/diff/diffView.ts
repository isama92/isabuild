// The contract between the diff window's shell and whichever pane is showing the
// diff.
//
// There are two panes — `SplitPanes`, two documents side by side, and
// `UnifiedPane`, one document with HEAD's lines shown above each change — and
// `DiffPane` is the shell that owns everything neither of them should: the
// toolbar, the change map, the view options and the keybindings. A pane renders
// its editors and nothing else, and reports what it measured.
//
// Pure types and one constant. No React, no CodeMirror, so both panes and the
// shell can import it without importing each other.

import type { StripeKind } from "../lib/diffStripes";
import type { Stripe } from "../lib/overviewStripes";
import type { Theme } from "../theme/themes";

/**
 * How long the diff may spend before it settles for a coarse answer.
 *
 * `@codemirror/merge` computes the diff inline, on the thread that is trying to
 * paint the window, and unbounded it is genuinely dangerous: two unrelated
 * 6,000-line files took over five minutes to compare. Its own default —
 * `scanLimit: 500` — is worse than no bound at all, because the limit is counted
 * in *characters*, so any residual range over 16,000 of them returns a single
 * chunk covering the whole file, by a path that still reports `precise: true`.
 *
 * `timeout` is the bound that behaves: it falls back to the package's coarse
 * matcher, and that one does set `precise: false`, so the shell can say so. At
 * 250 ms a realistic file is well under the budget and still exact (19 ms for
 * fifty scattered edits in 2,300 lines), and the pathological cases land around
 * half a second instead of minutes.
 *
 * Shared by both panes: the bound is a property of the algorithm, not of the
 * layout it is drawn in.
 */
export const DIFF_TIMEOUT_MS = 250;

/** What a pane reports upward every time it re-measures. */
export interface DiffMeasurement {
  /**
   * How many chunks the diff has.
   *
   * Kept apart from `stripes.length` on purpose: a stripe needs a *measured*
   * pane to exist at all, so deriving the count from the strip would have the
   * toolbar say "No changes in this file" for a pane that has not been measured
   * yet — and disable navigation over changes that are plainly there. The strip
   * is allowed to be empty until the geometry answers; the count is not.
   */
  changeCount: number;
  /** Whether the diff had to settle for the coarse matcher. */
  imprecise: boolean;
  /** The change map, already classified and positioned. */
  stripes: readonly Stripe<StripeKind>[];
}

/** The live-editor operations the shell drives from the toolbar and the strip. */
export interface DiffPaneHandle {
  /** Move the cursor to the next or previous chunk, and focus the editor. */
  goToChange: (direction: "next" | "previous") => void;
  /** Scroll chunk `index` into view without moving the cursor. */
  seek: (index: number) => void;
}

/**
 * How the window should divide its header.
 *
 * A pane reports its own, in a layout effect, so the header never paints a shape
 * the panes below it do not have. `splitAt` is null until the divider has been
 * measured, which is a different thing from there being no divider — hence the
 * discriminant rather than a nullable number.
 */
export type DiffHeaderLayout =
  | { mode: "split"; splitAt: number | null }
  | { mode: "unified" };

/** Everything a diff pane takes. */
export interface DiffViewProps {
  /** HEAD side. Empty string for a file that is not in HEAD yet. */
  left: string;
  /** Working-tree side: what the editor should hold. */
  right: string;
  /**
   * Increments whenever `right` is a fresh read from disk that should replace
   * the buffer. `right` cannot be that signal on its own: the window freezes it
   * at an older value while it protects unsaved typing, so a later read that
   * lands back on that same string would look unchanged and leave the editor
   * holding content nobody asked it to keep.
   */
  rightRevision: number;
  /** Repo-relative path; drives syntax highlighting. */
  path: string;
  /** False for a deleted file: nothing to edit, and a save must not recreate it. */
  rightEditable: boolean;
  /** Hide long runs of unchanged lines. Both panes honour it, each its own way. */
  collapse: boolean;
  /** The active theme. Passed rather than subscribed, so the shell subscribes once. */
  theme: Theme;
  onRightChange: (value: string) => void;
  onMeasure: (measurement: DiffMeasurement) => void;
  onLayout: (layout: DiffHeaderLayout) => void;
  /** Handed the controller on mount and `null` on unmount. */
  onReady: (handle: DiffPaneHandle | null) => void;
}
