// Opening the settings window. A sibling of lib/diffWindow and lib/mergeWindow
// over the same lib/fileWindow core, minus the per-file identity: there is only
// ever one settings window, so the label is the constant `settings` rather than
// a hash, and reopening focuses the one already there.

import { openFileWindow, withTheme } from "./fileWindow";

/** Must match the `windows` pattern in src-tauri/capabilities/settings.json. */
export const SETTINGS_WINDOW_LABEL = "settings";

export function openSettingsWindow(): Promise<void> {
  return openFileWindow({
    label: SETTINGS_WINDOW_LABEL,
    url: `settings.html?${withTheme(new URLSearchParams()).toString()}`,
    title: "isabuild Settings",
    subject: "the settings window",
    width: 760,
    height: 620,
  });
}
