// Drives the native File menu from the frontend.
//
// The Rust side only reports *what was clicked* (`menu://action`); everything
// that follows lives here, because it needs things the menu cannot see: whether
// a project is currently open, which paths the recents list holds, and the
// confirmation the user has to give before a running Claude Code session is
// killed.
//
// Quit is the exception and never arrives: `lib.rs` exits the app directly, so
// there is no round trip through a webview that is about to be torn down.

import { useCallback, useEffect, useRef, useState } from "react";
import { onMenuAction, type MenuActionEvent } from "../lib/settings";
import { openSettingsWindow } from "../lib/settingsWindow";
import { useProjectStore } from "../store/projectStore";

/**
 * An action waiting on confirmation. Only ever set while a project is open:
 * both of these end a running Claude Code session, and neither is undoable.
 */
export type PendingMenuAction =
  | { kind: "open-folder" }
  | { kind: "open-recent"; path: string }
  | { kind: "close-project" };

export interface MenuEvents {
  /** The action awaiting confirmation, or null. */
  pending: PendingMenuAction | null;
  /** Carry out the pending action. */
  confirm: () => void;
  /** Abandon it. */
  cancel: () => void;
}

export function useMenuEvents(): MenuEvents {
  const [pending, setPending] = useState<PendingMenuAction | null>(null);

  // Run an action for real. Reads the store imperatively so the listener below
  // never has to be re-registered when the project changes.
  const perform = useCallback((action: PendingMenuAction) => {
    const store = useProjectStore.getState();
    switch (action.kind) {
      case "open-folder":
        void store.openWithPicker();
        break;
      case "open-recent":
        void store.open(action.path);
        break;
      case "close-project":
        void store.close();
        break;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    function handle(event: MenuActionEvent) {
      const store = useProjectStore.getState();
      if (event.action === "settings") {
        void openSettingsWindow().catch((cause: unknown) => {
          useProjectStore.setState({ error: String(cause) });
        });
        return;
      }

      if (event.action === "open-recent") {
        // The menu was built from a list that may since have changed; an index
        // past the end means the click raced a removal, so do nothing.
        const recent = store.recents[event.index];
        if (recent === undefined) return;
        const action: PendingMenuAction = { kind: "open-recent", path: recent.path };
        if (store.project === null) perform(action);
        else setPending(action);
        return;
      }

      if (event.action === "open-folder") {
        const action: PendingMenuAction = { kind: "open-folder" };
        if (store.project === null) perform(action);
        else setPending(action);
        return;
      }

      // close-project. The menu item is disabled with nothing open, but an
      // accelerator or a stale menu could still deliver it.
      if (store.project !== null) setPending({ kind: "close-project" });
    }

    void (async () => {
      const off = await onMenuAction(handle);
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
    // `perform` has an empty dependency list of its own, so this registers the
    // Tauri listener exactly once. Re-registering per render would drop events
    // in the gap between the unlisten and the new subscription.
  }, [perform]);

  // Mirrored into a ref so `confirm` can read the pending action without being
  // re-created, and without doing the work inside a setState updater —
  // StrictMode invokes those twice, which would open the picker (or kill the
  // PTYs) twice over.
  const pendingRef = useRef<PendingMenuAction | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const confirm = useCallback(() => {
    const action = pendingRef.current;
    setPending(null);
    if (action !== null) perform(action);
  }, [perform]);

  const cancel = useCallback(() => setPending(null), []);

  return { pending, confirm, cancel };
}
