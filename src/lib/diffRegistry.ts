// The frontend side of the backend's record of which file each diff window shows.
//
// One module per IPC surface, as `gitStatus`, `diffSource` and `gitMerge` are.
// See `src-tauri/src/diffwindows.rs` for why this record has to exist at all and
// why it lives in Rust: in short, a diff window's label is the file it was
// *opened* with, and that stops being true the moment it loads a sibling in place.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DiffParams } from "./diffSource";
import type { FileTarget } from "./fileWindow";

/** Emitted to a single diff window, asking it to load a file in place. */
const SHOW_FILE_EVENT = "diff://show";

/**
 * Tell the backend this window now shows `target`.
 *
 * The backend takes the window from the IPC call rather than a label from here, so
 * a window can only ever register itself.
 */
export function registerDiffWindow(target: FileTarget): Promise<void> {
  return invoke<void>("diff_window_shows", {
    repoRoot: target.repoRoot,
    path: target.path,
  });
}

/**
 * The label to focus for `target`, or null when a window has to be created.
 *
 * `preferredLabel` is the label the caller derived from the path — the window
 * this file belongs to, open or not. When that window is open but has navigated
 * elsewhere, the backend sends it back to this file and returns its label.
 */
export function routeDiffWindow(
  target: DiffParams,
  preferredLabel: string,
): Promise<string | null> {
  return invoke<string | null>("diff_window_route", {
    repoRoot: target.repoRoot,
    path: target.path,
    origPath: target.origPath ?? null,
    preferredLabel,
  });
}

/** Subscribe to the backend asking this window to show another file. */
export function onShowFile(callback: (target: DiffParams) => void): Promise<UnlistenFn> {
  return listen<DiffParams>(SHOW_FILE_EVENT, (event) => callback(event.payload));
}
