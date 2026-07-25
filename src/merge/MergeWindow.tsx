// The merge window: one OS window per conflicted file, dedicated to resolving it.
//
// It owns which file it points at (its own query string), reading the conflicts,
// applying a choice, and following the file when someone else changes it.
//
// Simpler than the diff window in one important way: the pane is read-only, so
// there is no buffer to reconcile against disk and no auto-save to keep from
// fighting the watcher. Every write goes through the backend, which re-reads the
// file, checks the revision, and stages it when the last conflict goes.
//
// The revision is the whole reason a resolution cannot be applied blind. Between
// the read that produced these blocks and the click that resolves one, the file
// can have been rewritten — by Claude Code in the main window's terminal, by an
// editor, by `git checkout`. The backend refuses a stale revision, and this
// window's answer to that is to reload and say so.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ConflictBlocks } from "./ConflictBlocks";
import { binaryConflictActions } from "../lib/conflictView";
import { onRepoChanged } from "../lib/gitStatus";
import {
  getConflictFile,
  parseMergeParams,
  resolveConflict,
  resolvePath,
  type ConflictChoice,
  type ConflictFile,
  type MergeParams,
  type PathResolution,
} from "../lib/gitMerge";

type Phase = "loading" | "ready" | "error";

export function MergeWindow() {
  // The target never changes for the life of the window.
  const target = useMemo<{ params?: MergeParams; error?: string }>(() => {
    try {
      return { params: parseMergeParams(window.location.search) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const [file, setFile] = useState<ConflictFile | null>(null);
  const [phase, setPhase] = useState<Phase>(target.error ? "error" : "loading");
  const [error, setError] = useState<string | null>(target.error ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!target.params) return;
    void getConflictFile(target.params.repoRoot, target.params.path).then(
      (fetched) => {
        setFile(fetched);
        setPhase("ready");
        setError(null);
      },
      (cause: unknown) => {
        setPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [target.params]);

  useEffect(() => {
    load();
  }, [load]);

  // Follow the file: the same watcher event the Status panel refreshes on. Our
  // own writes come back through here too, which is exactly how the pane
  // re-renders after a resolution — no optimistic update to get wrong.
  useEffect(() => {
    if (!target.params) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onRepoChanged(() => {
      load();
    }).then((handle) => {
      if (cancelled) {
        handle();
        return;
      }
      unlisten = handle;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [load, target.params]);

  useEffect(() => {
    if (target.params) {
      document.title = `Conflicts: ${target.params.path}`;
    }
  }, [target.params]);

  // Esc / Ctrl+W close, matching the diff window. Bubble phase and skipped once
  // something else has handled the key.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const accel = event.ctrlKey || event.metaKey;
      if (event.key === "Escape" || (accel && event.key.toLowerCase() === "w")) {
        event.preventDefault();
        void getCurrentWindow().close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function choose(index: number, choice: ConflictChoice) {
    if (!target.params || !file || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await resolveConflict(
        target.params.repoRoot,
        target.params.path,
        index,
        choice,
        file.revision,
      );
      setNotice(
        outcome.staged
          ? "Every conflict in this file is resolved, and the file is staged."
          : `${outcome.remaining} ${outcome.remaining === 1 ? "conflict" : "conflicts"} left in this file.`,
      );
      setError(null);
    } catch (cause) {
      // Most often the revision guard: the file moved under us. Reloading is
      // both the fix and the honest thing to show.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      // Reload either way: on success to pick up the rewritten file, on failure
      // to show what is actually on disk now.
      load();
    }
  }

  async function chooseWholeFile(resolution: PathResolution) {
    if (!target.params || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await resolvePath(target.params.repoRoot, target.params.path, resolution);
      setNotice("Resolved and staged.");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      load();
    }
  }

  const conflictCount = file?.blocks.length ?? 0;

  return (
    <div className="merge-window">
      <div className="merge-header">
        <span className="merge-header-path">{target.params?.path ?? "No file"}</span>
        {phase === "ready" && file !== null && !file.binary && (
          <span className="merge-header-count">
            {conflictCount === 0
              ? "no conflicts left"
              : `${conflictCount} ${conflictCount === 1 ? "conflict" : "conflicts"}`}
          </span>
        )}
      </div>

      {error !== null && (
        <p className="merge-notice merge-notice--error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && <p className="merge-notice">{notice}</p>}

      <div className="merge-body">
        {phase === "loading" && <p className="merge-notice">Loading conflicts…</p>}

        {phase === "ready" && file !== null && file.binary && (
          <div className="merge-whole-file">
            <p className="merge-notice">
              This file is binary, so there is nothing to merge line by line. Keep one side of it
              whole.
            </p>
            <div className="merge-block-actions">
              {binaryConflictActions().map((action) => (
                <button
                  key={action.resolution}
                  type="button"
                  className="merge-choice"
                  disabled={busy}
                  title={action.title}
                  onClick={() => void chooseWholeFile(action.resolution)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {phase === "ready" && file !== null && !file.binary && conflictCount === 0 && (
          // Deliberately not self-closing. The window is closed by the person who
          // opened it: an OS window vanishing on its own reads as a crash, and
          // after an abort this is also how you find out the markers are gone.
          <div className="merge-whole-file">
            <p className="merge-notice">
              No conflict markers left in this file. If you resolved it by hand, mark it resolved
              so git stops treating it as conflicted.
            </p>
            {/* The escape hatch for a file fixed outside the app — in the diff
                window, in the terminal, by Claude Code. git reports the path as
                unmerged until something stages it, so without this button the row
                would stay in Conflicts with Continue disabled and the only way on
                would be the shell. Harmless when the file is already staged: this
                just stages it again. */}
            <div className="merge-block-actions">
              <button
                type="button"
                className="merge-choice"
                disabled={busy}
                title="Stage this file exactly as it is now"
                onClick={() => void chooseWholeFile("markResolved")}
              >
                Mark resolved
              </button>
            </div>
          </div>
        )}

        {phase === "ready" && file !== null && !file.binary && conflictCount > 0 && (
          <ConflictBlocks
            lines={file.lines}
            blocks={file.blocks}
            busy={busy}
            onResolve={(index, choice) => void choose(index, choice)}
          />
        )}
      </div>
    </div>
  );
}
