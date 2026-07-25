// Keeping a window's appearance in step with the settings.
//
// Every window needs the same three things: the current settings, a
// subscription so another window's change arrives here too, and the resolved
// appearance pushed at the CSS variables and the canvas/editor subscribers.
// Only the *first* of those differs — the main window already has the settings
// from its bootstrap call, secondary windows have to ask.

import { useEffect } from "react";
import { publishAppearance, resolveAppearance } from "../lib/appearance";
import { followSettings, useSettingsStore } from "../store/settingsStore";

/**
 * Publish the appearance whenever the settings change, and follow changes made
 * in other windows. Assumes something else performs the initial read; use
 * [`useAppearanceSync`] when nothing does.
 */
export function useAppearance(): void {
  const settings = useSettingsStore((state) => state.settings);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const off = await followSettings();
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (settings === null) return;
    // On the root element, so every stylesheet in the document sees it and the
    // value survives React re-rendering the tree beneath it.
    publishAppearance(document.documentElement, resolveAppearance(settings));
  }, [settings]);
}

/** As [`useAppearance`], plus the initial read. For the secondary windows. */
export function useAppearanceSync(): void {
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);
  useAppearance();
}
