// Which project the workspace has open, and everything the welcome screen needs
// to choose one.
//
// The backend owns the real answer (`ActiveProject` in Rust, which `git_status`
// and `pty_spawn` read); this store mirrors it so React can render off it. Every
// transition goes through a backend command first and only updates here once it
// resolves — critically for `open` and `close`, which kill the workspace PTYs
// backend-side. Swapping `project` before that returned would remount Layout
// against terminals still running in the old directory.

import { create } from "zustand";
import {
  bootstrap,
  closeProject,
  getRecentProjects,
  openProject,
  pickFolder,
  removeRecentProject,
  type Project,
  type RecentProject,
} from "../lib/settings";
import { initialGitState, useGitStore } from "./gitStore";
import { useLayoutStore } from "./layoutStore";
import { useSettingsStore } from "./settingsStore";

/**
 * Forget everything about the project being left behind.
 *
 * The git store is a module singleton holding the previous repo's root, status
 * and branch state, and a remounted Layout would otherwise render the old
 * repo's file list for one frame and then re-read against a root that is no
 * longer the project.
 *
 * The layout store keeps two *transient* fields that belong to a project rather
 * than to the window: an open branch menu, and a sync operation a keystroke
 * asked for. Both used to be component state and so reset themselves on
 * unmount; since Part 8's keybindings lifted them into the store, a branch menu
 * left open would reappear over the next project's status bar. The panel sizes
 * and visibility beside them are window preferences and deliberately survive.
 *
 * Merge resets (not `setState(x, true)`), so the action closures survive.
 */
function resetForProjectSwitch(): void {
  useGitStore.setState(initialGitState);
  useLayoutStore.setState({ branchMenuOpen: false, pendingGitAction: null });
}

/**
 * `loading` covers the one round trip before the first paint, so neither the
 * welcome screen nor the workspace flashes up before we know which is right.
 */
export type ProjectPhase = "loading" | "welcome" | "open";

export interface ProjectState {
  phase: ProjectPhase;
  project: Project | null;
  recents: RecentProject[];
  /** The launch directory when it is a repo, offered as a one-click open. */
  launchFolder: RecentProject | null;
  /** Why the last open failed, shown on the welcome screen. */
  error: string | null;
  /** A non-blocking message, e.g. settings that could not be read. */
  notice: string | null;
  /** True while an open or close is in flight, to disable the controls. */
  busy: boolean;
  /** Read the persisted state and reopen the last project if there is one. */
  start: () => Promise<void>;
  /** Open a specific folder. */
  open: (path: string) => Promise<void>;
  /** Ask for a folder with the native picker, then open it. */
  openWithPicker: () => Promise<void>;
  /** Return to the welcome screen, stopping everything rooted in the project. */
  close: () => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  /** Re-read the list after anything that reorders it or changes what exists. */
  refreshRecents: () => Promise<void>;
  dismissError: () => void;
  dismissNotice: () => void;
}

/** Data fields only (no actions), so tests can reset via a merge setState. */
export const initialProjectState = {
  phase: "loading" as ProjectPhase,
  project: null as Project | null,
  recents: [] as RecentProject[],
  launchFolder: null as RecentProject | null,
  error: null as string | null,
  notice: null as string | null,
  busy: false,
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  ...initialProjectState,

  start: async () => {
    try {
      const boot = await bootstrap();
      // The settings arrive in the same payload, so the appearance can be
      // applied without a second round trip.
      useSettingsStore.getState().adopt(boot.settings);
      set({
        phase: boot.project ? "open" : "welcome",
        project: boot.project,
        recents: boot.recents,
        launchFolder: boot.launchFolder,
        // A project that would not reopen is shown as an error on the welcome
        // screen; the entry stays in `recents`, marked missing.
        error: boot.projectError,
        notice: boot.settingsWarning,
      });
    } catch (cause) {
      set({
        phase: "welcome",
        error: `could not start: ${String(cause)}`,
      });
    }
  },

  open: async (path) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const project = await openProject(path);
      resetForProjectSwitch();
      set({ phase: "open", project, busy: false });
      await get().refreshRecents();
    } catch (cause) {
      // Stay where we are and say why. A failed open must not strand the user
      // on a blank workspace.
      set({ busy: false, error: String(cause) });
      await get().refreshRecents();
    }
  },

  openWithPicker: async () => {
    if (get().busy) return;
    let picked: string | null;
    try {
      picked = await pickFolder();
    } catch (cause) {
      set({ error: `could not open the folder picker: ${String(cause)}` });
      return;
    }
    if (picked === null) return; // cancelled
    await get().open(picked);
  },

  close: async () => {
    if (get().busy) return;
    set({ busy: true });
    try {
      await closeProject();
      resetForProjectSwitch();
      set({ phase: "welcome", project: null, busy: false, error: null });
      await get().refreshRecents();
    } catch (cause) {
      set({ busy: false, error: `could not close the project: ${String(cause)}` });
    }
  },

  removeRecent: async (path) => {
    try {
      set({ recents: await removeRecentProject(path) });
    } catch (cause) {
      set({ error: `could not update the recent projects: ${String(cause)}` });
    }
  },

  refreshRecents: async () => {
    try {
      set({ recents: await getRecentProjects() });
    } catch {
      /* a stale list is not worth an error banner over the real one */
    }
  },

  dismissError: () => set({ error: null }),
  dismissNotice: () => set({ notice: null }),
}));
