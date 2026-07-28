// The view options a window offers, and toggling one.
//
// Reads through the settings store, which is already filled and kept current by
// `useAppearanceSync` in both editor windows — so this costs no extra IPC on
// mount, and a toggle in one diff window reaches every other open window through
// the `settings://changed` broadcast that follows the save.
//
// ## What a toggle writes
//
// `SettingsPatch.viewOptions` replaces the map wholesale, so the write has to be
// the whole intended map rather than the one key that changed. Two things follow,
// and both are deliberate:
//
// - **Only actual overrides are written.** An option sitting on its default is
//   left out, so `config.json` says what you changed and nothing else — the same
//   contract `keybindings` has.
// - **Ids this build does not know are carried through.** A newer version's option
//   would otherwise be erased the first time an older one wrote, so a downgrade to
//   chase a bug would silently lose settings.

import { useCallback, useMemo } from "react";
import { useSettingsStore } from "../store/settingsStore";
import { resolveViewOptions, VIEW_OPTIONS, type ViewOptionState } from "./viewOptions";

export interface ViewOptions {
  /** Resolved state for every option in the registry, id-keyed. */
  state: ViewOptionState;
  toggle: (id: string) => void;
}

/**
 * The map to persist, given the stored one and the change to make.
 *
 * Exported for its test: it is the whole of the interesting behaviour, and driving
 * it through a rendered hook would prove less about it.
 */
export function nextOverrides(
  stored: Record<string, boolean>,
  id: string,
  value: boolean,
): Record<string, boolean> {
  const known = new Set(VIEW_OPTIONS.map((option) => option.id));
  // Anything the registry does not know stays exactly as it was found.
  const next: Record<string, boolean> = {};
  for (const [key, held] of Object.entries(stored)) {
    if (!known.has(key)) next[key] = held;
  }
  const resolved = { ...resolveViewOptions(stored), [id]: value };
  for (const option of VIEW_OPTIONS) {
    if (resolved[option.id] !== option.default) next[option.id] = resolved[option.id];
  }
  return next;
}

/**
 * No scope parameter: the resolved state covers the whole registry, and
 * `viewOptionItems(scope, …)` is what narrows it to the buttons a given window
 * shows. Keeping the two apart means a pane can read an option it does not
 * display a button for.
 */
export function useViewOptions(): ViewOptions {
  const overrides = useSettingsStore((store) => store.settings?.viewOptions);
  const save = useSettingsStore((store) => store.save);

  // Memoised on the stored map's identity, which the store replaces wholesale.
  // Not for the resolving, which is trivial — for the *identity*, so a consumer
  // can put this in a dependency array and have it mean something.
  const state = useMemo(() => resolveViewOptions(overrides ?? {}), [overrides]);

  const toggle = useCallback(
    (id: string) => {
      // Read at click time, not at render time: another window's toggle may have
      // arrived through `settings://changed` in between, and flipping a value that
      // has already moved would undo their change instead of making ours.
      const settings = useSettingsStore.getState().settings;
      // Nothing to merge into yet. Writing here would send a map built from `{}`,
      // and because the patch replaces the map wholesale that would erase every
      // override this build does not recognise — the one thing this module promises
      // not to do. The window is a frame or two, between the toolbar's first paint
      // and the settings read resolving, so swallowing the click beats losing a
      // setting over it.
      if (settings === null) return;
      const stored = settings.viewOptions;
      const current = resolveViewOptions(stored);
      void save({ viewOptions: nextOverrides(stored, id, !current[id]) });
    },
    [save],
  );

  return { state, toggle };
}
