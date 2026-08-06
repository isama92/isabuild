// The diff window: one OS window per file, entirely dedicated to the diff.
//
// It owns what surrounds the editor: loading both sides, the per-pane headers,
// auto-save, following the file when someone else changes it, and deciding whether
// it may close. Everything an editor window does that is not about diffing — the
// target, the title, the appearance, the close keys, the watcher subscription — is
// `editor/useEditorWindow`, shared with the merge window.
//
// Auto-save and live refresh are the two halves that have to be kept from
// fighting each other. Edits are debounced to disk; our own write comes back
// through the same `repo://changed` watcher that tells us the file changed, so
// every refresh runs through `shouldAdoptDiskContent` before it is allowed to
// touch the buffer. The buffer itself lives in a ref, not in state: it must not
// flow back down into DiffPane as the content to display.

import { useCallback, useEffect, useRef, useState } from "react";
import { DiffPane } from "./DiffPane";
import type { DiffHeaderLayout } from "./diffView";
import { EditorWindow, type Notice } from "../editor/EditorWindow";
import { useEditorWindow, type WindowTarget } from "../editor/useEditorWindow";
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
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imprecise, setImprecise] = useState(false);
  /**
   * How to divide the header, as the pane below reports it.
   *
   * A discriminant rather than a nullable number: "not measured yet" and "there is
   * no divider" are different answers, and a header that treated them the same
   * would lay a one-document view out as two halves for its first frame.
   */
  const [layout, setLayout] = useState<DiffHeaderLayout>({ mode: "split", splitAt: null });
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
  /** Whether a failing close has already been refused once; see `onCloseRequest`. */
  const insistedRef = useRef(false);

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

  const writeBuffer = useCallback(async (params: DiffParams) => {
    const current = diffRef.current;
    // Read the buffer here, not when the flush was requested: by now an earlier
    // write may have already persisted this content, or the user may have typed
    // on, and either way the newest content is the one worth writing.
    const value = bufferRef.current;
    if (!current || value === lastWrittenRef.current) {
      return true;
    }
    savesInFlightRef.current += 1;
    try {
      await writeWorkingFile(params, value, current.eol);
      lastWrittenRef.current = value;
      setSaveError(null);
      return true;
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      savesInFlightRef.current -= 1;
    }
  }, []);

  /** Whether the editor holds something that is not on disk yet. */
  const hasUnsavedEdit = () =>
    diffRef.current !== null &&
    diffRef.current.right !== null &&
    bufferRef.current !== lastWrittenRef.current;

  // Both sides are re-read as a unit: the initial load and every refresh. The
  // state updates happen in the promise callbacks, never synchronously, so an
  // effect can call this without cascading renders.
  const load = useCallback(
    (params: DiffParams) => {
      void getFileDiff(params).then(applyFetched, (cause: unknown) => {
        setPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [applyFetched],
  );

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
  const flushSave = useCallback(
    (params: DiffParams): Promise<boolean> => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const result = saveChainRef.current.then(() => writeBuffer(params));
      // The chain must survive a rejection, or every later save is skipped.
      saveChainRef.current = result.catch(() => undefined);
      return result;
    },
    [writeBuffer],
  );

  // Annotated rather than inferred, and deliberately so: the callbacks below read
  // `target` to find out which file they are acting on, and without the annotation
  // that self-reference leaves TypeScript inferring `any` for the whole thing.
  const target: WindowTarget<DiffParams> = useEditorWindow<DiffParams>({
    scope: "diff",
    parse: parseDiffParams,
    titlePrefix: "Diff",
    pathOf: (params) => params.path,
    onRepoEvent: () => {
      if (target.params) load(target.params);
    },
    // An edit must not be lost when the window goes away. `close()` — ours, the
    // OS button, or the main window taking its diff windows with it — routes
    // through here. The test is "is there something not on disk", not "is a timer
    // pending": a save that has already fired still has to be waited for, and a
    // save that failed still has to be retried rather than dropped. A failure
    // keeps the window open with the error visible; the user can close again to
    // insist, which re-runs the write.
    onCloseRequest: () => {
      const params = target.params;
      if (!params) return true;
      if (!hasUnsavedEdit() && savesInFlightRef.current === 0) return true;
      return flushSave(params).then((saved) => {
        if (saved || insistedRef.current) return true;
        // The next close goes through even if the write keeps failing, so a
        // read-only file can never trap the window open.
        insistedRef.current = true;
        return false;
      });
    },
    // Ctrl/Cmd+S has nothing to save that auto-save would not, but muscle memory
    // deserves an answer: write immediately.
    accelerator: {
      key: "s",
      run: () => {
        if (target.params) void flushSave(target.params);
      },
    },
  });

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
      const params = target.params;
      if (!params) return;
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave(params);
      }, SAVE_DEBOUNCE_MS);
    },
    [flushSave, target.params],
  );

  useEffect(() => {
    if (target.params) load(target.params);
  }, [load, target.params]);

  // Losing focus is the other way edits can be left hanging (clicking away to
  // the main window, or the OS close button on platforms that blur first).
  useEffect(() => {
    const params = target.params;
    if (!params) return;
    const flush = () => {
      if (hasUnsavedEdit()) void flushSave(params);
    };
    window.addEventListener("blur", flush);
    return () => window.removeEventListener("blur", flush);
  }, [flushSave, target.params]);

  const leftPath = diff?.origPath ?? diff?.path ?? target.params?.path ?? "";
  const leftSha = diff?.headSha ?? "(no commits yet)";
  const isNewFile = diff !== null && diff.left === null && !diff.binary;
  const isDeleted = diff !== null && diff.right === null && !diff.binary;
  const loadError = target.error ?? error;
  const failed = target.error !== undefined || phase === "error";

  const notices: Notice[] = [];
  if (failed) {
    notices.push({
      id: "load",
      tone: "error",
      text: loadError ?? "Could not read this file.",
    });
  }
  if (saveError !== null) {
    notices.push({ id: "save", tone: "error", text: `Could not save: ${saveError}` });
  }
  if (imprecise) {
    notices.push({
      id: "imprecise",
      tone: "warn",
      text: "This file is too different to compare exactly; the changes shown are approximate.",
    });
  }

  return (
    <EditorWindow
      className="diff-window"
      notices={notices}
      header={
        <>
          <div
            className="diff-header-side"
            style={
              layout.mode === "split" && layout.splitAt !== null
                ? { flex: `0 0 ${layout.splitAt}px` }
                : undefined
            }
          >
            <span className="diff-sha">{leftSha}</span>
            <span className="diff-header-path">{isNewFile ? "(new file)" : leftPath}</span>
          </div>
          <div className="diff-header-side diff-header-side--right">
            <span className="diff-header-path">Current version</span>
            {isDeleted && <span className="diff-header-note">(deleted)</span>}
          </div>
        </>
      }
    >
      {!failed && phase === "loading" && <p className="ew-notice">Loading diff…</p>}
      {!failed && phase === "ready" && diff !== null && diff.binary && (
        <p className="ew-notice">Binary file — no text diff to show.</p>
      )}
      {!failed && phase === "ready" && diff !== null && !diff.binary && (
        <DiffPane
          left={diff.left ?? ""}
          right={diff.right ?? ""}
          rightRevision={rightRevision}
          path={diff.path}
          rightEditable={!isDeleted}
          onRightChange={handleRightChange}
          onLayout={setLayout}
          onImprecise={setImprecise}
        />
      )}
    </EditorWindow>
  );
}
