// The merge window: one OS window per conflicted file, dedicated to resolving it.
//
// It owns everything around the editor: which file it points at (its own query
// string), reading the index stages, the divergence banner, the buffer, the single
// write, and closing.
//
// The write model is the one thing to understand before reading on. The buffer
// lives **in memory until every conflict is decided**; the instant the marker count
// reaches zero it is written once and staged, and there is no Save button. That is
// why none of the diff window's auto-save machinery is here — no debounce, no
// `shouldAdoptDiskContent` guard against our own echo, no write chain. In exchange
// two things do need care:
//
// - **A reload must not take the buffer away.** `repo://changed` fires for anything
//   in the repository, and the user may be halfway through resolving. A reload with
//   an untouched buffer is adopted; with a touched one it becomes a notice offering
//   to reload, and the buffer stays.
// - **Closing with work outstanding must ask.** An undecided buffer is not on disk
//   anywhere, so the close is intercepted and confirmed. This is what `merge.json`
//   needs `core:window:allow-destroy` for.

import { useCallback, useEffect, useRef, useState } from "react";
import { MergePanes } from "./MergePanes";
import { EditorWindow, type Notice } from "../editor/EditorWindow";
import { useEditorWindow, type WindowTarget } from "../editor/useEditorWindow";
import { binaryConflictActions } from "../lib/conflictView";
import { countConflictMarkers } from "../lib/mergeChunks";
import {
  getConflictStages,
  parseMergeParams,
  resolvePath,
  writeResolved,
  type ConflictStages,
  type MergeParams,
  type PathResolution,
} from "../lib/gitMerge";

type Phase = "loading" | "ready" | "error";

/** Which text the editor was seeded from, once a diverged file has been decided. */
type Source = "rebuild" | "disk";

/** Whether a path has two sides of text to merge line by line at all. */
function isMergeable(stages: ConflictStages): boolean {
  return !stages.binary && stages.stages.includes(2) && stages.stages.includes(3);
}

export function MergeWindow() {
  const [stages, setStages] = useState<ConflictStages | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The result buffer. Null until a source has been chosen. */
  const [buffer, setBuffer] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  /** Set when a watcher event arrived that we declined to adopt. */
  const [staleOnDisk, setStaleOnDisk] = useState(false);

  // Mirrors for the async paths and the close handler, which must read the
  // newest values without re-subscribing.
  const stagesRef = useRef<ConflictStages | null>(null);
  const bufferRef = useRef<string | null>(null);
  const touchedRef = useRef(false);
  /** Text of our one successful write, so the reload it causes is not a surprise. */
  const writtenRef = useRef<string | null>(null);
  /**
   * Text of the last write the backend *refused*.
   *
   * Without it a refusal loops: the effect below fires on `busy` returning to
   * false, every guard still passes, and the same doomed write goes out again —
   * holding the op lock each time and starving the main window's git operations.
   * A refusal is only worth retrying once the buffer or the file has changed, and
   * comparing the text is exactly that test.
   */
  const refusedRef = useRef<string | null>(null);

  const outstanding = buffer === null ? 0 : countConflictMarkers(buffer);

  /**
   * Take a freshly read set of stages.
   *
   * Three outcomes, and the two that are *not* "adopt it" matter more:
   *
   * - **Nothing about this file moved.** `repo://changed` fires for anything in the
   *   repository, and with Claude Code writing files in the terminal next door that
   *   is the common case. Returning early is not just an optimisation: pushing a new
   *   `stages` object of identical content would churn the editor props for no
   *   reason, and warning about a file nobody touched would be a lie.
   * - **It moved, and the user has unsaved work.** Then *nothing* is updated — not
   *   the buffer, not the stages, not even the revision. Replacing the stages would
   *   change the key `MergePanes` is mounted under and rebuild the editors around
   *   chunk spans that no longer describe the buffer. Keeping the stale revision is
   *   deliberate too: the write that follows is refused with "reload it and try
   *   again", which is the truth.
   * - Otherwise, adopt it.
   */
  const adopt = useCallback((fetched: ConflictStages) => {
    const previous = stagesRef.current;
    const hadBuffer = bufferRef.current !== null;
    const sameFile =
      previous !== null &&
      fetched.revision === previous.revision &&
      fetched.stages.join(",") === previous.stages.join(",");
    if (sameFile && hadBuffer) {
      setPhase("ready");
      // A read succeeding clears a read that failed — but not a write the backend
      // refused, which is still true and still needs acting on.
      if (refusedRef.current === null) setError(null);
      return;
    }
    if (hadBuffer && touchedRef.current) {
      setPhase("ready");
      setStaleOnDisk(true);
      return;
    }
    stagesRef.current = fetched;
    setStages(fetched);
    setPhase("ready");
    setError(null);
    setStaleOnDisk(false);
    touchedRef.current = false;
    refusedRef.current = null;
    if (!isMergeable(fetched)) {
      bufferRef.current = null;
      setBuffer(null);
      setSource(null);
      return;
    }
    // A diverged file gets no buffer yet: the banner asks which text to open, and
    // guessing is what would lose an edit made outside the app.
    if (fetched.diverged) {
      bufferRef.current = null;
      setBuffer(null);
      setSource(null);
      return;
    }
    bufferRef.current = fetched.result;
    setBuffer(fetched.result);
    setSource("rebuild");
  }, []);

  const load = useCallback(
    (params: MergeParams) => {
      void getConflictStages(params.repoRoot, params.path).then(adopt, (cause: unknown) => {
        setPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [adopt],
  );

  // Annotated rather than inferred: the callbacks below read `target` to find out
  // which file they are acting on, and without the annotation that self-reference
  // leaves TypeScript inferring `any` for the whole thing.
  const target: WindowTarget<MergeParams> = useEditorWindow<MergeParams>({
    scope: "merge",
    parse: parseMergeParams,
    titlePrefix: "Conflicts",
    pathOf: (params) => params.path,
    // Follow the file: the same watcher event the Status panel refreshes on. Our
    // own write comes back through here too, which is how the panes end up showing
    // the resolved state without an optimistic update to get wrong.
    onRepoEvent: () => {
      if (target.params) load(target.params);
    },
    // Closing with work outstanding has to ask: the buffer is not on disk anywhere,
    // so it goes with the window.
    onCloseRequest: () => {
      if (!touchedRef.current || bufferRef.current === null) return true;
      if (countConflictMarkers(bufferRef.current) === 0) return true;
      // A promise rather than the bare boolean, deliberately: that is what makes
      // the hook intercept the close and `destroy` the window, where a plain
      // `close` would re-enter this same handler. The dialog itself still opens
      // synchronously, during the event.
      return Promise.resolve(
        window.confirm(
          "This file still has unresolved conflicts, and the changes in this window have not been written anywhere. Close and lose them?",
        ),
      );
    },
  });

  useEffect(() => {
    if (target.params) load(target.params);
  }, [load, target.params]);

  const handleChange = useCallback((text: string) => {
    bufferRef.current = text;
    touchedRef.current = true;
    setBuffer(text);
  }, []);

  /**
   * Write the resolved buffer and stage it.
   *
   * Called from the effect below the moment the marker count hits zero, so there
   * is nothing for the user to press. The revision guard is the backend's, and a
   * refusal (the file moved under us, a marker we miscounted) surfaces as an error
   * with the buffer intact.
   */
  const commit = useCallback(
    async (text: string) => {
      const params = target.params;
      if (!params) return;
      setBusy(true);
      try {
        await writeResolved(params.repoRoot, params.path, text, stagesRef.current?.revision ?? "");
        writtenRef.current = text;
        refusedRef.current = null;
        touchedRef.current = false;
        setNotice("Every conflict is resolved, and the file is staged.");
        setError(null);
      } catch (cause) {
        // Remembered so the effect below does not send the same doomed write again
        // the moment `busy` clears.
        refusedRef.current = text;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [target.params],
  );

  // The single write. Guarded on `writtenRef` so the reload our own write triggers
  // does not write again, on `refusedRef` so a refusal does not loop, and on `busy`
  // so a burst of edits cannot overlap.
  useEffect(() => {
    if (buffer === null || busy) return;
    if (outstanding > 0) return;
    if (buffer === writtenRef.current || buffer === refusedRef.current) return;
    if (!touchedRef.current) return;
    void commit(buffer);
  }, [buffer, busy, commit, outstanding]);

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
      load(target.params);
    }
  }

  /** Open a diverged file from one of the two texts. */
  function chooseSource(next: Source) {
    const current = stagesRef.current;
    if (!current) return;
    const text = next === "disk" ? current.disk : current.result;
    bufferRef.current = text;
    // Counts as touched: neither text is what is staged, so reaching zero
    // conflicts still has to write.
    touchedRef.current = true;
    setBuffer(text);
    setSource(next);
    setStaleOnDisk(false);
  }

  const resolvedElsewhere =
    phase === "ready" && stages !== null && stages.stages.length === 0;
  const wholeFileOnly =
    phase === "ready" && stages !== null && !resolvedElsewhere && !isMergeable(stages);
  const needsSource =
    phase === "ready" && stages !== null && isMergeable(stages) && buffer === null;

  const loadError = target.error ?? error;
  const failed = target.error !== undefined || phase === "error";

  const notices: Notice[] = [];
  if (loadError !== null && loadError !== undefined) {
    notices.push({ id: "error", tone: "error", text: loadError });
  }
  if (notice !== null) {
    notices.push({ id: "notice", tone: "info", text: notice });
  }
  if (staleOnDisk) {
    // Declined a reload rather than clobbering the buffer. Saying so and offering
    // the reload is the honest version of "we ignored that".
    notices.push({
      id: "stale",
      tone: "warn",
      text: (
        <>
          This file changed on disk while you were working on it.{" "}
          <button
            type="button"
            className="merge-inline-button"
            onClick={() => {
              touchedRef.current = false;
              if (target.params) load(target.params);
            }}
          >
            Reload it
          </button>{" "}
          to start from what is there now, or carry on and your version will be written.
        </>
      ),
    });
  }

  return (
    <EditorWindow
      className="merge-window"
      notices={notices}
      header={
        <>
          <span className="merge-header-path">{target.params?.path ?? "No file"}</span>
          {buffer !== null && (
            <span className="merge-header-count">
              {outstanding === 0
                ? "no conflicts left"
                : `${outstanding} ${outstanding === 1 ? "conflict" : "conflicts"} to decide`}
            </span>
          )}
          {source === "disk" && (
            <span className="merge-header-source">opened from the file on disk</span>
          )}
        </>
      }
    >
      {!failed && phase === "loading" && <p className="ew-notice">Loading conflicts…</p>}

      {needsSource && stages !== null && (
        <div className="merge-whole-file">
          <p className="ew-notice">
            This file changed since git wrote it — something edited it outside this window. Pick
            which version to work from.
          </p>
          <div className="merge-block-actions">
            <button
              type="button"
              className="ew-button"
              title="Keep the edits already in the file and resolve what is left"
              onClick={() => chooseSource("disk")}
            >
              Use the file on disk
            </button>
            <button
              type="button"
              className="ew-button"
              title="Discard those edits and rebuild the merge from git's three versions"
              onClick={() => chooseSource("rebuild")}
            >
              Start over from the merge
            </button>
          </div>
        </div>
      )}

      {wholeFileOnly && stages !== null && (
        <div className="merge-whole-file">
          <p className="ew-notice">
            {stages.binary
              ? "This file is binary, so there is nothing to merge line by line. Keep one side of it whole."
              : "Only one side of this file has any content, so there is nothing to merge line by line. Keep a whole side, or accept the deletion, from the Status panel."}
          </p>
          {stages.binary && (
            <div className="merge-block-actions">
              {binaryConflictActions().map((action) => (
                <button
                  key={action.resolution}
                  type="button"
                  className="ew-button"
                  disabled={busy}
                  title={action.title}
                  onClick={() => void chooseWholeFile(action.resolution)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {resolvedElsewhere && (
        // Deliberately not self-closing. The window is closed by the person who
        // opened it: an OS window vanishing on its own reads as a crash, and
        // after an abort this is also how you find out the conflict is gone.
        <div className="merge-whole-file">
          <p className="ew-notice">
            git no longer reports this file as conflicted — it has been resolved and staged, here
            or somewhere else.
          </p>
          {/* Still offered, because a file resolved by hand outside the app can
              reach this state with the working tree edited but nothing staged. */}
          <div className="merge-block-actions">
            <button
              type="button"
              className="ew-button"
              disabled={busy}
              title="Stage this file exactly as it is now"
              onClick={() => void chooseWholeFile("markResolved")}
            >
              Mark resolved
            </button>
          </div>
        </div>
      )}

      {phase === "ready" && stages !== null && buffer !== null && (
        // Keyed on the revision so a reload we adopted rebuilds the editors
        // rather than patching four coordinate systems in place.
        <MergePanes
          key={`${stages.revision}-${source}`}
          path={stages.path}
          stages={stages}
          value={buffer}
          onChange={handleChange}
          busy={busy}
        />
      )}
    </EditorWindow>
  );
}
