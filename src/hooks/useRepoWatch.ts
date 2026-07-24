// Wires the git store to live updates: fetch status once on mount, then
// re-fetch on every debounced `repo://changed` from the backend watcher.
// Mounted once at the Layout root (like useGlobalKeybindings) so status stays
// current even while the Status panel is collapsed. The `cancelled` guard makes
// the async setup safe under React StrictMode's mount/unmount/remount.

import { useEffect } from "react";
import { onRepoChanged, startWatch } from "../lib/gitStatus";
import { useGitStore } from "../store/gitStore";

export function useRepoWatch(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      await useGitStore.getState().refresh();
      if (cancelled) return;

      const root = useGitStore.getState().repoRoot;
      if (!root) return; // not a repo: show the one-shot status, no watching

      // A watch failure is non-fatal — the panel still shows the initial
      // status, it just won't live-update.
      try {
        await startWatch(root);
      } catch {
        /* ignore */
      }
      if (cancelled) return;

      unlisten = await onRepoChanged(() => {
        void useGitStore.getState().refresh();
      });
      if (cancelled) {
        unlisten();
        unlisten = undefined;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
