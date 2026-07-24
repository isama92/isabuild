// Wires the git store to live updates: read status and branch state once on
// mount, then re-read on every debounced `repo://changed` from the backend
// watcher. Mounted once at the Layout root (like useGlobalKeybindings) so both
// stay current even while the Status panel is collapsed. The `cancelled` guard
// makes the async setup safe under React StrictMode's mount/unmount/remount.
//
// The watcher covers `.git` too, so a branch switch, fetch or pull — including
// one the user runs in the bottom terminal — refreshes the branch UI with no
// extra plumbing and no polling. The store skips reads while one of our own
// operations is in flight; see its module note.

import { useEffect } from "react";
import { onRepoChanged, startWatch } from "../lib/gitStatus";
import { useGitStore } from "../store/gitStore";

export function useRepoWatch(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      // Status first: it is what resolves repoRoot, which the branch read needs.
      await useGitStore.getState().refresh();
      if (cancelled) return;

      const root = useGitStore.getState().repoRoot;
      if (!root) return; // not a repo: show the one-shot status, no watching

      await useGitStore.getState().refreshBranch();
      if (cancelled) return;

      // A watch failure is non-fatal — the panel still shows the initial
      // status, it just won't live-update.
      try {
        await startWatch(root);
      } catch {
        /* ignore */
      }
      if (cancelled) return;

      unlisten = await onRepoChanged(() => {
        void useGitStore.getState().refreshAll();
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
