// The merge window: one OS window per conflicted file, dedicated to resolving it.
//
// It owns everything around the editor: which file it points at (its own query
// string), reading the index stages, the divergence banner, the buffer, the single
// write, and closing.
//
// The write model is the one thing to understand before reading on. The buffer
// lives **in memory until the user says otherwise**: deciding the last conflict
// offers to stage the file, and nothing reaches disk or the index until that button
// is pressed. There is still exactly one write, so none of the diff window's
// auto-save machinery is here — no debounce, no `shouldAdoptDiskContent` guard
// against our own echo, no write chain.
//
// It used to write the instant the marker count hit zero, which was one keystroke
// away from a staged file nobody had read. Resolving a conflict and *reviewing* the
// result are two different acts, and the second one is the reason the panes are
// aligned at all. In exchange three things need care:
//
// - **A reload must not take the buffer away.** `repo://changed` fires for anything
//   in the repository, and the user may be halfway through resolving. A reload with
//   an untouched buffer is adopted; with a touched one it becomes a notice offering
//   to reload, and the buffer stays.
// - **Closing with work outstanding must ask**, and "outstanding" now includes a
//   file that is fully decided but not staged: neither is on disk anywhere, so both
//   go with the window. This is what `merge.json` needs `core:window:allow-destroy`
//   for.
// - **A refusal is the user's to answer, not ours to retry.** The button stays, so a
//   refusal the file has moved past is one more press away, and nothing here has to
//   guard against a write retrying itself; the effect that needed that guard is gone.
//   The one refusal a second press cannot fix is a stale revision, which is why the
//   notice for that case sends the user to Reload it rather than to the button.

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
  /**
   * Rendered mirrors of `touchedRef` and `writtenRef`.
   *
   * The refs stay authoritative: the close handler and the async paths have to read
   * the newest values synchronously, which is what they are for. What a ref cannot
   * do is bring a render with it, and whether to offer staging is a question about
   * exactly those two facts, so it is asked of state instead. Every assignment to
   * one sets the other, in the same breath.
   */
  const [touched, setTouched] = useState(false);
  const [written, setWritten] = useState<string | null>(null);

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
   * Kept so a read that succeeds afterwards does not quietly clear a refusal the
   * user still has to act on: the file moving under us is news about the write, and
   * a fresh `getConflictStages` says nothing about it either way.
   */
  const refusedRef = useRef<string | null>(null);
  /**
   * Whether a write is in flight, for `commit`'s own re-entrancy guard.
   *
   * The `busy` state cannot serve: it is captured at render, so two clicks landing
   * in one render would both see `false`. The button is disabled while busy, which
   * makes this belt and braces, but `chooseWholeFile` guards its write and these two
   * are siblings.
   */
  const busyRef = useRef(false);

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
    setTouched(false);
    refusedRef.current = null;
    // What was written belonged to the file state being replaced. Keeping it would
    // outlive its meaning: a conflict recreated in this same window session (`git
    // checkout --merge`) and then resolved to byte-identical text would compare
    // equal to it, and the window would decline to offer staging for work that has
    // never been staged.
    writtenRef.current = null;
    setWritten(null);
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
    // so it goes with the window. Since the write is the user's own act now, a file
    // that is fully decided but unstaged is just as unsaved as an undecided one, and
    // it gets its own sentence rather than the wrong one.
    onCloseRequest: () => {
      const buffered = bufferRef.current;
      if (!touchedRef.current || buffered === null) return true;
      if (buffered === writtenRef.current) return true;
      const undecided = countConflictMarkers(buffered) > 0;
      // A promise rather than the bare boolean, deliberately: that is what makes
      // the hook intercept the close and `destroy` the window, where a plain
      // `close` would re-enter this same handler. The dialog itself still opens
      // synchronously, during the event.
      return Promise.resolve(
        window.confirm(
          undecided
            ? "This file still has unresolved conflicts, and the changes in this window have not been written anywhere. Close and lose them?"
            : "Every conflict is decided, but the file has not been staged, so the result is not written anywhere. Close and lose it?",
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
    setTouched(true);
    setBuffer(text);
  }, []);

  /**
   * Write the resolved buffer and stage it.
   *
   * The user's own act, from the notice that appears once every conflict is
   * decided. The revision guard is the backend's, and a refusal (the file moved
   * under us, a marker we miscounted) surfaces as an error with the buffer intact.
   *
   * **The panes stay editable while this is in flight, deliberately**, and that is
   * what the guard on clearing `touched` is about. Locking them for the length of
   * one IPC call would be a cursor that stops taking input for no reason the user
   * can see; the buffer is theirs throughout. So the text that comes back here may
   * no longer be the text in the editor, and saying "nothing has been touched" then
   * would strand that edit: unstageable, because `stageable` needs `touched`, and
   * dropped with no prompt on close, because the close guard bails on the same flag.
   * `touched` therefore only clears when the buffer really is what was written.
   */
  const commit = useCallback(
    async (text: string) => {
      const params = target.params;
      if (!params || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await writeResolved(params.repoRoot, params.path, text, stagesRef.current?.revision ?? "");
        writtenRef.current = text;
        setWritten(text);
        refusedRef.current = null;
        if (bufferRef.current === text) {
          touchedRef.current = false;
          setTouched(false);
        }
        setNotice("Every conflict is resolved, and the file is staged.");
        setError(null);
      } catch (cause) {
        refusedRef.current = text;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [target.params],
  );

  /**
   * Whether there is a finished resolution nobody has staged yet.
   *
   * `touchedRef` is what keeps this away from a file that arrived with no conflicts
   * in it: there is nothing to stage until the user has done something. Comparing
   * against the text already written is what makes the notice go away afterwards,
   * including when our own write comes back through the watcher.
   */
  const stageable = buffer !== null && outstanding === 0 && touched && buffer !== written;

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
    setTouched(true);
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
  if (stageable) {
    // The offer, rather than the deed. Reviewing what a resolution came to is a
    // separate act from making it, and this is the pause that allows it.
    notices.push({
      id: "stage",
      tone: "info",
      text: (
        <>
          Every conflict is decided. Read the result over, then{" "}
          <button
            type="button"
            className="ew-button"
            disabled={busy}
            title="Write this file and stage it"
            onClick={() => {
              if (buffer !== null) void commit(buffer);
            }}
          >
            Stage this file
          </button>
        </>
      ),
    });
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
              setTouched(false);
              if (target.params) load(target.params);
            }}
          >
            Reload it
          </button>{" "}
          to start from what is there now. Staging what you have will be refused until you do,
          because it was built on the file as it was.
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
