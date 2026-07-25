// User settings, shared by every window.
//
// The backend is the single source of truth: this store is a cache that is
// filled once and then kept current by the `settings://changed` event, which
// fires in *all* windows whenever anything saves. That is what lets the settings
// window change the theme and have the workspace, a diff window and a merge
// window all repaint without any of them polling.
//
// Saving goes straight to the backend rather than optimistically here: the file
// write can fail (a read-only config directory), and a UI that had already moved
// on would be lying.

import { create } from "zustand";
import {
  getSettings,
  updateSettings,
  onSettingsChanged,
  type Settings,
  type SettingsPatch,
} from "../lib/settings";

export interface SettingsState {
  /** Null until the first read resolves. */
  settings: Settings | null;
  /** Why the last save failed, or null. */
  error: string | null;
  /** Read the settings and start following changes from other windows. */
  load: () => Promise<void>;
  /** Adopt settings that arrived with an event or a bootstrap payload. */
  adopt: (settings: Settings) => void;
  /** Persist a partial change. */
  save: (patch: SettingsPatch) => Promise<void>;
  dismissError: () => void;
}

/** Data fields only (no actions), so tests can reset via a merge setState. */
export const initialSettingsState = {
  settings: null as Settings | null,
  error: null as string | null,
};

export const useSettingsStore = create<SettingsState>((set) => ({
  ...initialSettingsState,
  load: async () => {
    try {
      set({ settings: await getSettings() });
    } catch (cause) {
      set({ error: `could not read settings: ${String(cause)}` });
    }
  },
  adopt: (settings) => set({ settings }),
  save: async (patch) => {
    try {
      // The command broadcasts to every window including this one, but adopt
      // the result directly too: the round trip through the event loop would
      // otherwise show one frame of the old value in the control just changed.
      set({ settings: await updateSettings(patch), error: null });
    } catch (cause) {
      set({ error: `could not save settings: ${String(cause)}` });
    }
  },
  dismissError: () => set({ error: null }),
}));

/**
 * Follow `settings://changed` for the life of the window. Returns the unlisten
 * handle. Called once per window entry point, next to the first read.
 */
export function followSettings(): Promise<() => void> {
  return onSettingsChanged((settings) => useSettingsStore.getState().adopt(settings));
}
