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
//
// This hook is a dumb forwarder and must stay one: overlapping `repo://changed`
// events are coalesced in the store, so a debounce here would only add latency on
// top of the backend's own debounce window.

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

      // Merge state too, not only on later events: a project opened while a merge,
      // rebase, cherry-pick or revert is in progress otherwise shows no banner
      // until some unrelated file happens to change, and that banner is the only
      // route to Continue and Abort.
      await useGitStore.getState().refreshMerge();
      if (cancelled) return;

      // A watch failure is non-fatal — the panel still shows the initial
      // status, it just won't live-update.
      try {
        const summary = await startWatch(root);
        // A *partial* watch is the one worth saying something about: the panel
        // updates for some of the tree and silently not for the rest, which is
        // indistinguishable from a working one. The usual cause is an exhausted
        // inotify budget (`fs.inotify.max_user_watches`).
        if (summary.failed > 0) {
          console.warn(
            `isabuild: watching ${summary.watched} directories, ` +
              `${summary.failed} refused. Changes in part of this repository ` +
              `will not refresh the panel.`,
          );
        }
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
