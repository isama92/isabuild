// The diff window: one OS window per file, entirely dedicated to the diff.
//
// It owns everything around the editor: which file it points at (its own query
// string), loading both sides, the per-pane headers, auto-save, following the
// file when someone else changes it, and closing.
//
// Auto-save and live refresh are the two halves that have to be kept from
// fighting each other. Edits are debounced to disk; our own write comes back
// through the same `repo://changed` watcher that tells us the file changed, so
// every refresh runs through `shouldAdoptDiskContent` before it is allowed to
// touch the buffer. The buffer itself lives in a ref, not in state: it must not
// flow back down into DiffPane as the content to display.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DiffPane } from "./DiffPane";
import { onRepoChanged } from "../lib/gitStatus";
import { shouldAdoptDiskContent } from "../lib/diffSync";
import {
  getFileDiff,
  parseDiffParams,
  writeWorkingFile,
  type DiffParams,
  type FileDiff,
} from "../lib/diffSource";

const SAVE_DEBOUNCE_MS = 400;

type Phase = "loading" | "ready" | "error";

export function DiffWindow() {
  // The target never changes for the life of the window.
  const target = useMemo<{ params?: DiffParams; error?: string }>(() => {
    try {
      return { params: parseDiffParams(window.location.search) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [phase, setPhase] = useState<Phase>(target.error ? "error" : "loading");
  const [error, setError] = useState<string | null>(target.error ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [originalWidth, setOriginalWidth] = useState<number | null>(null);
  /**
   * Bumped every time we adopt disk content. `diff.right` alone cannot drive
   * the pane: while a buffer is kept it stays frozen at an older value, so an
   * adopt that happens to land back on that same string would be invisible to
   * an equality-checked prop and leave the editor holding the newer buffer.
   */
  const [rightRevision, setRightRevision] = useState(0);

  // Mirrors of the state the async paths need to read without re-subscribing.
  const diffRef = useRef<FileDiff | null>(null);
  const bufferRef = useRef<string>("");
  const lastWrittenRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  /** Serialises writes; see `flushSave`. */
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const savesInFlightRef = useRef(0);

  const savePending = () => saveTimerRef.current !== null || savesInFlightRef.current > 0;

  const applyFetched = useCallback((fetched: FileDiff) => {
    const previous = diffRef.current;
    const keepBuffer =
      previous !== null &&
      !shouldAdoptDiskContent({
        fetched: fetched.right,
        buffer: bufferRef.current,
        lastWritten: lastWrittenRef.current,
        savePending: savePending(),
      });

    // Keeping the buffer must not hold back the HEAD side: a new commit still
    // has to show up in the left pane and its header.
    let next = fetched;
    if (keepBuffer) {
      next = { ...fetched, right: previous.right };
    } else {
      bufferRef.current = fetched.right ?? "";
      lastWrittenRef.current = fetched.right;
      setRightRevision((revision) => revision + 1);
    }
    diffRef.current = next;
    setDiff(next);
    setPhase("ready");
    setError(null);
  }, []);

  // Both sides are re-read as a unit: the initial load and every refresh. The
  // state updates happen in the promise callbacks, never synchronously, so an
  // effect can call this without cascading renders.
  const load = useCallback(() => {
    if (!target.params) return;
    void getFileDiff(target.params).then(applyFetched, (cause: unknown) => {
      setPhase("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [applyFetched, target.params]);

  const writeBuffer = useCallback(async (): Promise<boolean> => {
    const current = diffRef.current;
    // Read the buffer here, not when the flush was requested: by now an earlier
    // write may have already persisted this content, or the user may have typed
    // on, and either way the newest content is the one worth writing.
    const value = bufferRef.current;
    if (!target.params || !current || value === lastWrittenRef.current) {
      return true;
    }
    savesInFlightRef.current += 1;
    try {
      await writeWorkingFile(target.params, value, current.eol);
      lastWrittenRef.current = value;
      setSaveError(null);
      return true;
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      savesInFlightRef.current -= 1;
    }
  }, [target.params]);

  /**
   * Write the buffer now, cancelling any queued save. Returns false when the
   * write failed.
   *
   * Writes are chained rather than fired in parallel: the debounce, the
   * blur-flush and the close-flush can all ask at once, and two overlapping
   * `fs::write`s land in arbitrary order — which would leave the older content
   * on disk and `lastWritten` describing the wrong thing, with nothing queued to
   * correct it.
   */
  const flushSave = useCallback((): Promise<boolean> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const result = saveChainRef.current.then(writeBuffer);
    // The chain must survive a rejection, or every later save is skipped.
    saveChainRef.current = result.catch(() => undefined);
    return result;
  }, [writeBuffer]);

  /** Whether the editor holds something that is not on disk yet. */
  const hasUnsavedEdit = () =>
    diffRef.current !== null &&
    diffRef.current.right !== null &&
    bufferRef.current !== lastWrittenRef.current;

  // Auto-save: debounced so a burst of keystrokes is one write, and skipped
  // when an edit lands back on the content already on disk (reverting a block
  // you had just changed, or a refresh we adopted).
  const handleRightChange = useCallback(
    (value: string) => {
      bufferRef.current = value;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!diffRef.current || diffRef.current.right === null) return; // deleted: read-only
      if (value === lastWrittenRef.current) return;
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, SAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Follow the file: the same watcher event the Status panel refreshes on.
  useEffect(() => {
    if (!target.params) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onRepoChanged(() => {
      void load();
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

  // An edit must not be lost when the window goes away. `close()` — ours, the
  // OS button, or the main window taking its diff windows with it — routes
  // through here. The test is "is there something not on disk", not "is a timer
  // pending": a save that has already fired still has to be waited for, and a
  // save that failed still has to be retried rather than dropped. A failure
  // keeps the window open with the error visible; the user can close again to
  // insist, which re-runs the write.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let insisted = false;
    void appWindow
      .onCloseRequested(async (event) => {
        if (!hasUnsavedEdit() && savesInFlightRef.current === 0) return;
        event.preventDefault();
        const saved = await flushSave();
        if (saved || insisted) {
          await appWindow.destroy();
          return;
        }
        // Next close goes through even if the write keeps failing, so a
        // read-only file can never trap the window open.
        insisted = true;
      })
      .then((handle) => {
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
  }, [flushSave]);

  // Losing focus is the other way edits can be left hanging (clicking away to
  // the main window, or the OS close button on platforms that blur first).
  useEffect(() => {
    const flush = () => {
      if (hasUnsavedEdit()) void flushSave();
    };
    window.addEventListener("blur", flush);
    return () => window.removeEventListener("blur", flush);
  }, [flushSave]);

  // Bubble phase, and skipped once something else has handled the key: Monaco
  // consumes Escape to dismiss its own widgets (the find bar, most visibly) and
  // marks the event handled, so this only closes the window when Escape had
  // nothing else to do. `event.key`, not `event.code`, for the letters — the
  // physical position of W and S moves between layouts, the label does not.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const accel = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // Ctrl/Cmd+S has nothing to save that auto-save would not, but muscle
      // memory deserves an answer: write immediately.
      if (accel && key === "s") {
        event.preventDefault();
        void flushSave();
        return;
      }
      if (event.key === "Escape" || (accel && key === "w")) {
        event.preventDefault();
        void getCurrentWindow().close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flushSave]);

  useEffect(() => {
    if (target.params) {
      document.title = `Diff: ${target.params.path}`;
    }
  }, [target.params]);

  const leftPath = diff?.origPath ?? diff?.path ?? target.params?.path ?? "";
  const leftSha = diff?.headSha ?? "(no commits yet)";
  const isNewFile = diff !== null && diff.left === null && !diff.binary;
  const isDeleted = diff !== null && diff.right === null && !diff.binary;

  return (
    <div className="diff-window">
      <div className="diff-header">
        <div
          className="diff-header-side"
          style={originalWidth === null ? undefined : { flex: `0 0 ${originalWidth}px` }}
        >
          <span className="diff-sha">{leftSha}</span>
          <span className="diff-header-path">{isNewFile ? "(new file)" : leftPath}</span>
        </div>
        <div className="diff-header-side diff-header-side--right">
          <span className="diff-header-path">Current version</span>
          {isDeleted && <span className="diff-header-note">(deleted)</span>}
        </div>
      </div>

      {saveError !== null && (
        <p className="diff-notice diff-notice--error" role="alert">
          Could not save: {saveError}
        </p>
      )}

      <div className="diff-body">
        {phase === "loading" && <p className="diff-notice">Loading diff…</p>}
        {phase === "error" && (
          <p className="diff-notice diff-notice--error" role="alert">
            {error ?? "Could not read this file."}
          </p>
        )}
        {phase === "ready" && diff !== null && diff.binary && (
          <p className="diff-notice">Binary file — no text diff to show.</p>
        )}
        {phase === "ready" && diff !== null && !diff.binary && (
          <DiffPane
            left={diff.left ?? ""}
            right={diff.right ?? ""}
            rightRevision={rightRevision}
            path={diff.path}
            rightEditable={!isDeleted}
            onRightChange={handleRightChange}
            onOriginalWidth={setOriginalWidth}
          />
        )}
      </div>
    </div>
  );
}
