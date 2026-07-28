// Everything a diff or merge window does that has nothing to do with diffing or
// merging.
//
// Both windows independently grew the same six effects: parse the target out of
// their own query string, read and follow the appearance settings, set the
// document title, close on Escape, close on Ctrl/Cmd+W, follow `repo://changed`,
// and intercept their own close so work in hand is not lost. They are here once.
//
// Two things it deliberately does *not* unify:
//
// - **The parser.** `parseDiffParams` and `parseMergeParams` differ in what they
//   accept and in what they say when a window was opened by hand, and both are
//   tested on their own. This takes one as an argument.
// - **The close guard.** The diff window flushes a save and lets a second close
//   through even if the write keeps failing; the merge window asks. Only the
//   "may I go?" answer is shared, so each keeps its own reasoning in its own
//   closure.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppearanceSync } from "../hooks/useAppearance";
import { useWindowKeybindings } from "../hooks/useWindowKeybindings";
import { onRepoChanged } from "../lib/gitStatus";
import type { Scope } from "../lib/keybindings";

/** What the window is looking at, or why it has nothing to look at. */
export interface WindowTarget<P> {
  params?: P;
  error?: string;
}

export interface EditorWindowOptions<P> {
  scope: Scope;
  /** Throws when the window was opened without a target. */
  parse: (search: string) => P;
  /** `document.title` is `${titlePrefix}: ${path}`. */
  titlePrefix: string;
  /** The path to title the window with, out of the parsed params. */
  pathOf: (params: P) => string;
  /** Called on every `repo://changed`. */
  onRepoEvent?: () => void;
  /**
   * Whether the window may close. Returning false keeps it open — the caller is
   * expected to have shown why. Throwing is treated as "close it": a broken guard
   * must not be able to leave a window that cannot be shut.
   *
   * A **plain `true`** and a promise of `true` are not quite the same thing, though
   * both close the window. Plain `true` says "there was nothing outstanding", and
   * the close is then left to Tauri, which destroys the window itself unless
   * `preventDefault` was called. Anything else is intercepted and destroyed here
   * instead. Nothing forces that split — Tauri `await`s this handler in full, so a
   * guard may take as long as it likes (`@tauri-apps/api/window.js`) — but keeping
   * the quiet case on the plain path means the overwhelmingly common close does not
   * route through interception at all.
   */
  onCloseRequest?: () => boolean | Promise<boolean>;
  /** Extra hardcoded accelerator, for the diff window's Ctrl/Cmd+S. */
  accelerator?: { key: string; run: () => void };
}

export function useEditorWindow<P>(options: EditorWindowOptions<P>): WindowTarget<P> {
  const { scope, parse, titlePrefix, pathOf, onRepoEvent, onCloseRequest, accelerator } = options;

  // Reads the settings, follows other windows' changes, and pushes the theme and
  // font at the CSS custom properties the panes read.
  useAppearanceSync();

  // The target never changes for the life of the window: it is in the URL the
  // opener built, and nothing can navigate this webview.
  const [target] = useState<WindowTarget<P>>(() => {
    try {
      return { params: parse(window.location.search) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Callbacks through refs, so a caller passing fresh closures each render (the
  // normal way) does not re-subscribe the window-level listeners every time.
  const repoRef = useRef(onRepoEvent);
  const closeRef = useRef(onCloseRequest);
  const acceleratorRef = useRef(accelerator);
  useEffect(() => {
    repoRef.current = onRepoEvent;
    closeRef.current = onCloseRequest;
    acceleratorRef.current = accelerator;
  }, [accelerator, onCloseRequest, onRepoEvent]);

  const path = useMemo(
    () => (target.params === undefined ? null : pathOf(target.params)),
    // `pathOf` is a plain projection the callers write inline; depending on its
    // identity would re-run this on every render for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target.params],
  );

  useEffect(() => {
    if (path !== null) document.title = `${titlePrefix}: ${path}`;
  }, [path, titlePrefix]);

  // Follow the file: the same watcher event the Status panel refreshes on.
  useEffect(() => {
    if (target.params === undefined || onRepoEvent === undefined) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onRepoChanged(() => {
      repoRef.current?.();
    }).then((handle) => {
      if (cancelled) {
        handle();
        return;
      }
      unlisten = handle;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // `onRepoEvent` is read through a ref; only whether there *is* one matters,
    // and that never changes for a given window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.params]);

  // Work in hand must not vanish with the window. `close()` — ours, the OS
  // button, or the main window taking its secondary windows with it — routes
  // through here, and `destroy()` is what actually goes, which is why the diff
  // and merge capabilities grant both.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void appWindow
      .onCloseRequested(async (event) => {
        const guard = closeRef.current;
        if (guard === undefined) return;
        // Two `try`s, because a guard can fail in two places and they need
        // different answers. Throwing *before* we intercept means Tauri is still
        // free to close the window, so the cheapest safe thing is to get out of the
        // way. Rejecting *after* we intercept means the close is already ours, so
        // we have to finish it by hand.
        let decision: boolean | Promise<boolean>;
        try {
          decision = guard();
        } catch {
          return;
        }
        // A plain `true` means there was nothing to think about, so the close is
        // left to Tauri: it destroys the window itself unless `preventDefault` was
        // called. Anything else and we take the close over — see the option's doc.
        if (decision === true) return;
        event.preventDefault();
        let allowed: boolean;
        try {
          allowed = await decision;
        } catch {
          // A broken guard must not be able to leave a window that cannot be shut,
          // with nothing on screen to explain why.
          allowed = true;
        }
        if (allowed) await appWindow.destroy();
      })
      .then((handle) => {
        if (cancelled) {
          handle();
          return;
        }
        unlisten = handle;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Close-window comes from the settings (default Escape). Bubble phase, and
  // skipped once something else has handled the key: CodeMirror consumes Escape
  // to dismiss its own widgets — the find panel, most visibly — and marks the
  // event handled, so this only closes the window when Escape had nothing else
  // to do.
  const close = useCallback(() => void getCurrentWindow().close(), []);
  useWindowKeybindings(scope, { "close-window": close });

  // Ctrl/Cmd+W, and the caller's own accelerator, stay out of the registry: they
  // are OS conventions rather than preferences, and a user who rebound Ctrl+W
  // away would have no way to close a window that has no menu. `event.key`, not
  // `event.code` — the physical position of W and S moves between layouts, the
  // label does not.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      // Exactly Ctrl/Cmd, no more. `lib/keybindings`' `matches` compares modifiers
      // exactly for the same reason: a binding that fires on any superset shadows
      // every combination built on top of it, so Ctrl+Shift+W would close the window
      // and Ctrl+Shift+S would save when the user meant something else entirely.
      if (event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const extra = acceleratorRef.current;
      if (extra !== undefined && key === extra.key) {
        event.preventDefault();
        extra.run();
        return;
      }
      if (key === "w") {
        event.preventDefault();
        void getCurrentWindow().close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return target;
}
