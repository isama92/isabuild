// Thin wrapper over the Part 8 settings, project and menu commands, plus the
// two events they emit. Same split as lib/gitStatus: this module knows the IPC
// surface, the stores decide when to call it. Types mirror the Rust structs in
// src-tauri/src/settings.rs, project.rs and fonts.rs.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Settings {
  schemaVersion: number;
  /** Theme id from the registry in src/theme/themes.ts. */
  theme: string;
  /** Monospace family; empty means the built-in stack. */
  fontFamily: string;
  fontSize: number;
  /** Keybinding overrides only, action id to accelerator. */
  keybindings: Record<string, string>;
  /** Editor-window view overrides only, option id to whether it is on. */
  viewOptions: Record<string, boolean>;
  lastProject: string | null;
  recentProjects: string[];
}

/** Every field optional: an omitted field is left as it is on disk. */
export interface SettingsPatch {
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  keybindings?: Record<string, string>;
  viewOptions?: Record<string, boolean>;
}

export interface Project {
  /** `git rev-parse --show-toplevel`. The project *is* the repo root. */
  repoRoot: string;
  name: string;
}

/**
 * Whether a remembered project can still be opened, and if not, why. Mirrors
 * Rust `RecentState`: "missing" is a folder that has been deleted or unmounted,
 * "notARepo" one that is still there but no longer part of a repository.
 */
export type RecentState = "ok" | "missing" | "notARepo";

export interface RecentProject {
  path: string;
  name: string;
  state: RecentState;
}

export interface FontFamily {
  name: string;
  monospaced: boolean;
}

/** Everything the app needs before its first render, in one round trip. */
export interface Bootstrap {
  settings: Settings;
  recents: RecentProject[];
  /** The reopened project, or null for the welcome screen. */
  project: Project | null;
  /** Why `lastProject` did not reopen, if it did not. */
  projectError: string | null;
  /** Why the settings file was replaced by defaults, if it was. */
  settingsWarning: string | null;
  /**
   * The repository the app was launched from, when nothing else is open. The
   * *repo root*, not the launch directory, so it compares equal to a recents
   * entry.
   */
  launchFolder: RecentProject | null;
}

export function bootstrap(): Promise<Bootstrap> {
  return invoke<Bootstrap>("bootstrap");
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("settings_get");
}

/** Persist a partial change. Resolves with the settings as saved. */
export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return invoke<Settings>("settings_update", { patch });
}

export function listFonts(): Promise<FontFamily[]> {
  return invoke<FontFamily[]>("list_fonts");
}

/** Native folder picker. Resolves to null when the user cancels. */
export function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

/**
 * Open `path` as the project. Rejects with an actionable message when it is
 * gone, is not a folder, or is not inside a git repository.
 *
 * Switching projects kills the workspace PTYs *inside this command*, before it
 * resolves — so by the time the caller swaps its store, nothing is still running
 * in the old directory.
 */
export function openProject(path: string): Promise<Project> {
  return invoke<Project>("project_open", { path });
}

export function closeProject(): Promise<void> {
  return invoke<void>("project_close");
}

export function getRecentProjects(): Promise<RecentProject[]> {
  return invoke<RecentProject[]>("recent_projects");
}

/** Forget one recent project. Resolves with the list as it now stands. */
export function removeRecentProject(path: string): Promise<RecentProject[]> {
  return invoke<RecentProject[]>("recent_remove", { path });
}

/**
 * Subscribe to `settings://changed`, emitted to every window whenever settings
 * are saved anywhere. Carries the new settings, so a listener never has to
 * round-trip to read them back.
 */
export function onSettingsChanged(callback: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>("settings://changed", (event) => callback(event.payload));
}

/** What the native menu reports. Mirrors the payloads emitted in lib.rs. */
export type MenuActionEvent =
  | { action: "open-folder" }
  | { action: "close-project" }
  | { action: "settings" }
  | { action: "open-recent"; index: number };

/**
 * Subscribe to `menu://action`. Only the main window receives it: the menu is
 * the workspace's, and the frontend owns the confirm dialog and the swap that
 * each action leads to.
 */
export function onMenuAction(callback: (event: MenuActionEvent) => void): Promise<UnlistenFn> {
  return listen<MenuActionEvent>("menu://action", (event) => callback(event.payload));
}
