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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffPane } from "./DiffPane";
import type { DiffHeaderLayout } from "./diffView";
import { EditorToolbar, type ToolbarItem } from "../editor/EditorToolbar";
import { EditorWindow, type Notice } from "../editor/EditorWindow";
import { Icons } from "../editor/icons";
import { useEditorWindow, type NavigableWindowTarget } from "../editor/useEditorWindow";
import { useWindowKeybindings } from "../hooks/useWindowKeybindings";
import {
  changedFiles,
  indexOfPath,
  reanchor,
  type ChangedFile,
} from "../lib/changedFiles";
import { onShowFile, registerDiffWindow } from "../lib/diffRegistry";
import { getStatus } from "../lib/gitStatus";
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
  /** Every file this window can step to, refreshed on each `repo://changed`. */
  const [files, setFiles] = useState<readonly ChangedFile[]>([]);

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
  /**
   * The same, for a refused navigation; see `goToFile` for why it is separate.
   *
   * State rather than a ref, unlike its close-guard counterpart, because it is the
   * only thing that changes when a navigation is refused — nothing else re-renders
   * — and the notice has to grow a sentence explaining how to move on anyway.
   */
  const [navigateInsisted, setNavigateInsisted] = useState(false);
  /** Whether a navigation is already in flight. Alt+ArrowRight autorepeats. */
  const navigatingRef = useRef(false);
  /**
   * Where the window sat before the list last moved; see `reanchor`.
   *
   * Read only from `step`, an event handler, which is why a ref is right here: the
   * toolbar does not need it. "Not in the list" is neither the first entry nor the
   * last, so both buttons fall out enabled without anyone having to remember where
   * the file used to be.
   */
  const lastIndexRef = useRef(0);
  /** Guards overlapping status reads, one per debounced watcher event. */
  const statusInFlightRef = useRef(false);

  /**
   * Which file this window is on, counted rather than named.
   *
   * The params a save or a load carries say *what* to act on, and that is not the
   * same question as *whether the answer is still wanted*. Two places ask it:
   *
   * - **`load`**, where it is the only thing stopping a diff read for the old file
   *   from painting itself over the new one. A refresh in flight when Next File is
   *   pressed does exactly that.
   * - **`writeBuffer`**, where it is a backstop — see its own comment for what
   *   holds that case today and why it is not enough to rely on.
   */
  const generationRef = useRef(0);

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

  const writeBuffer = useCallback(async (params: DiffParams, generation: number) => {
    const current = diffRef.current;
    // Read the buffer here, not when the flush was requested: by now an earlier
    // write may have already persisted this content, or the user may have typed
    // on, and either way the newest content is the one worth writing.
    const value = bufferRef.current;
    // Refuse to write for a file the window has left. `true`, not `false`: a
    // superseded write has nothing left to do, and must not raise a save error or
    // refuse a close.
    //
    // A backstop rather than the mechanism, and worth being exact about which.
    // What actually closes the window today is `goToFile` nulling `diffRef`, two
    // lines below: a stale write finds no diff and returns before it can do
    // anything. But that is a *side effect* of resetting the adopt logic, and the
    // day someone keeps `diffRef` across a load — to hold the header steady, say —
    // the failure it was incidentally preventing is one file being overwritten
    // with the contents of another, silently. Two lines to not depend on that.
    if (generation !== generationRef.current) return true;
    if (!current || value === lastWrittenRef.current) {
      return true;
    }
    savesInFlightRef.current += 1;
    try {
      await writeWorkingFile(params, value, current.eol);
      lastWrittenRef.current = value;
      setSaveError(null);
      // A write that worked leaves nothing to insist about, so the next refusal
      // starts from asking rather than from letting work go.
      setNavigateInsisted(false);
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
      const generation = generationRef.current;
      void getFileDiff(params).then(
        (fetched) => {
          // Arrived for a file this window has already left. Dropping it is the
          // point: applying it would paint the old file's diff over the new one.
          if (generation !== generationRef.current) return;
          applyFetched(fetched);
        },
        (cause: unknown) => {
          if (generation !== generationRef.current) return;
          setPhase("error");
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
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
      // Captured at *request* time, not when the chained write runs — by then the
      // window may be on another file, and that is precisely what the write has to
      // notice. See `generationRef`.
      const generation = generationRef.current;
      const result = saveChainRef.current.then(() => writeBuffer(params, generation));
      // The chain must survive a rejection, or every later save is skipped.
      saveChainRef.current = result.catch(() => undefined);
      return result;
    },
    [writeBuffer],
  );

  /**
   * Re-read the changed-file list.
   *
   * The diff window is its own webview and never mounts the git store, so it asks
   * the backend directly. That is one extra `git status` per open diff window per
   * debounced watcher event — acceptable, and guarded so overlapping events do not
   * stack. A failure keeps the previous list: a broken list must never break the
   * diff, which is the actual job of this window.
   */
  const refreshFiles = useCallback((repoRoot: string) => {
    if (statusInFlightRef.current) return;
    statusInFlightRef.current = true;
    void getStatus(repoRoot)
      .then((status) => {
        // The project was switched under this window. Its own close is already on
        // the way; a list from another repository is worse than a stale one.
        if (status.repoRoot !== repoRoot) return;
        setFiles(changedFiles(status));
      })
      .catch(() => undefined)
      .finally(() => {
        statusInFlightRef.current = false;
      });
  }, []);

  // Annotated rather than inferred, and deliberately so: the callbacks below read
  // `target` to find out which file they are acting on, and without the annotation
  // that self-reference leaves TypeScript inferring `any` for the whole thing.
  const target: NavigableWindowTarget<DiffParams> = useEditorWindow<DiffParams>({
    scope: "diff",
    navigable: true,
    parse: parseDiffParams,
    titlePrefix: "Diff",
    pathOf: (params) => params.path,
    onRepoEvent: () => {
      if (target.params) {
        load(target.params);
        refreshFiles(target.params.repoRoot);
      }
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

  // Registered on mount as well as on every navigation, so a reload — which
  // returns the window to the file in its URL — corrects the backend's record
  // rather than leaving it describing where the window used to be.
  useEffect(() => {
    const params = target.params;
    if (!params) return;
    void registerDiffWindow(params).catch(() => undefined);
    refreshFiles(params.repoRoot);
  }, [refreshFiles, target.params]);

  /**
   * Show another file in this window.
   *
   * The order matters, and every step of it is load-bearing:
   *
   * 1. Refuse to re-enter. Alt+ArrowRight autorepeats, and without this a held key
   *    stacks flushes and loads.
   * 2. Flush into the file being *left*, named explicitly.
   * 3. If that write failed, stay — with the error already on screen — and let a
   *    second press through. `navigateInsistedRef` is separate from the close
   *    guard's `insistedRef` on purpose: refusing a close and refusing a
   *    navigation are different questions about the same file, and sharing the
   *    flag would let a refused navigation silently permit the next close to throw
   *    the work away without asking.
   * 4. Bump the generation, *after* the awaited flush so our own write is not
   *    cancelled by our own bump. Everything still queued for the old file is void
   *    from this instant.
   * 5. Reset the refs. `diffRef` is the subtle one: `applyFetched` keeps the
   *    buffer only when there was a previous diff, so nulling it forces an
   *    unconditional adopt of the new file. Leave it and `shouldAdoptDiskContent`
   *    is asked with the *old* file's `lastWritten`, can decline, and the new
   *    file's diff renders with the old file's text on the right.
   *    `saveChainRef` and `savesInFlightRef` are deliberately left alone: the
   *    chain is still the write-ordering mechanism, and zeroing the counter drives
   *    it negative when the in-flight write lands, which would leave the close
   *    guard's `savesInFlightRef.current === 0` false for the rest of the window's
   *    life.
   *
   * **Known gap.** This does not consult the registry, so with two diff windows
   * open, stepping one of them onto the file the other is showing puts two editors
   * on one path — the state `src-tauri/src/diffwindows.rs` exists to prevent,
   * reached by the front door instead of the back one. It is not destructive (the
   * two converge through `shouldAdoptDiskContent` unless both are being typed in
   * at once) and it needs two windows open to reach, but closing it means choosing
   * between skipping the file, focusing the other window, and allowing it — three
   * different products. Recorded in the README entry as outstanding rather than
   * decided here.
   */
  const goToFile = useCallback(
    async (next: DiffParams) => {
      const from = target.params;
      if (!from || navigatingRef.current) return;
      if (from.path === next.path && from.repoRoot === next.repoRoot) return;
      navigatingRef.current = true;
      try {
        if (hasUnsavedEdit() || savesInFlightRef.current > 0) {
          const saved = await flushSave(from);
          if (!saved && !navigateInsisted) {
            setNavigateInsisted(true);
            return;
          }
        }

        generationRef.current += 1;
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        bufferRef.current = "";
        lastWrittenRef.current = null;
        diffRef.current = null;
        insistedRef.current = false;
        setNavigateInsisted(false);

        setDiff(null);
        setPhase("loading");
        setError(null);
        setSaveError(null);
        setImprecise(false);
        // `layout` is deliberately not reset: the divider is a window preference
        // the user just set, and the new pane reports a fresh value on mount.

        void registerDiffWindow(next).catch(() => undefined);
        // The effect keyed on `target.params` does the load, so there is one load
        // path rather than two that can disagree.
        target.navigate(next);
      } finally {
        navigatingRef.current = false;
      }
    },
    [flushSave, navigateInsisted, target],
  );

  /** Where this window sits in the list, and how long the list is. */
  const position = useMemo(() => {
    const path = target.params?.path;
    return {
      index: path === undefined ? -1 : indexOfPath(files, path),
      total: files.length,
    };
  }, [files, target.params]);

  useEffect(() => {
    if (position.index !== -1) lastIndexRef.current = position.index;
  }, [position.index]);

  const current = target.params;
  const step = useCallback(
    (delta: -1 | 1) => {
      if (current === undefined || files.length === 0) return;
      // `reanchor` rather than `position.index`, so a Next from a file that has
      // just been committed away still goes somewhere sensible.
      const from = reanchor(files, current.path, lastIndexRef.current);
      const to = files[from + delta];
      if (!to) return;
      void goToFile({ repoRoot: current.repoRoot, path: to.path, origPath: to.origPath });
    },
    [current, files, goToFile],
  );

  useWindowKeybindings("diff", {
    "next-file": () => step(1),
    "previous-file": () => step(-1),
  });

  // Through a ref, and mirrored *before* the subscription below, so that one is
  // registered exactly once: re-`listen`ing on every navigation would drop a
  // request that arrived in the gap.
  const goToFileRef = useRef(goToFile);
  useEffect(() => {
    goToFileRef.current = goToFile;
  }, [goToFile]);

  // The backend asking this window to come back to a file it was opened for and
  // has since navigated away from, rather than a second window being opened onto
  // a file already on screen. See `src-tauri/src/diffwindows.rs`.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onShowFile((requested) => {
      void goToFileRef.current(requested);
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
  }, []);

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
    notices.push({
      id: "save",
      tone: "error",
      // The second half only once a navigation has actually been refused, so it
      // reads as an answer to what was just attempted rather than a standing offer
      // to lose work.
      text: navigateInsisted
        ? `Could not save: ${saveError} — press Next file again to move on and lose this change.`
        : `Could not save: ${saveError}`,
    });
  }
  if (imprecise) {
    notices.push({
      id: "imprecise",
      tone: "warn",
      text: "This file is too different to compare exactly; the changes shown are approximate.",
    });
  }

  /**
   * The file-navigation row.
   *
   * Rendered by the window rather than the pane because the pane is unmounted
   * during every load and for a binary file, so a counter there would vanish at
   * exactly the moment it is being used. The ends do not wrap: in a list of
   * twenty-six, silently starting over reads as the button having done nothing.
   */
  const fileItems: ToolbarItem[] = [
    {
      kind: "group",
      id: "files",
      items: [
        {
          kind: "button",
          id: "previous-file",
          label: "Previous changed file",
          tooltip: "Show the previous changed file in this window",
          icon: Icons.previousFile,
          // A file that has left the list is neither the first entry nor the last,
          // so both buttons stay live and `step` reanchors to the slot it held.
          // Disabling them there would leave a counter reporting 26 files above
          // two dead controls.
          disabled: position.total === 0 || position.index === 0,
          onSelect: () => step(-1),
        },
        {
          kind: "button",
          id: "next-file",
          label: "Next changed file",
          tooltip: "Show the next changed file in this window",
          icon: Icons.nextFile,
          disabled: position.total === 0 || position.index === position.total - 1,
          onSelect: () => step(1),
        },
      ],
    },
    {
      kind: "status",
      id: "files-count",
      // An em dash for the position when the file has left the list — it was
      // committed or reverted while open, and the window stays on it rather than
      // closing out from under you.
      text:
        position.total === 0
          ? "No changed files"
          : `${position.index === -1 ? "—" : position.index + 1} / ${position.total} files`,
    },
  ];

  return (
    <EditorWindow
      className="diff-window"
      notices={notices}
      toolbar={<EditorToolbar items={fileItems} label="Changed files" />}
      header={
        layout.mode === "unified" ? (
          // One document, so one header. No divider to track, and no border down
          // the middle, because there is nothing on either side of it.
          <div className="diff-header-side diff-header-side--unified">
            <span className="diff-sha">{leftSha}</span>
            <span className="diff-header-path">{isNewFile ? "(new file)" : leftPath}</span>
            <span className="diff-header-arrow" aria-hidden="true">
              →
            </span>
            <span className="diff-header-path">Current version</span>
            {isDeleted && <span className="diff-header-note">(deleted)</span>}
          </div>
        ) : (
          <>
            <div
              className="diff-header-side"
              style={layout.splitAt === null ? undefined : { flex: `0 0 ${layout.splitAt}px` }}
            >
              <span className="diff-sha">{leftSha}</span>
              <span className="diff-header-path">{isNewFile ? "(new file)" : leftPath}</span>
            </div>
            <div className="diff-header-side diff-header-side--right">
              <span className="diff-header-path">Current version</span>
              {isDeleted && <span className="diff-header-note">(deleted)</span>}
            </div>
          </>
        )
      }
    >
      {!failed && phase === "loading" && <p className="ew-notice">Loading diff…</p>}
      {!failed && phase === "ready" && diff !== null && diff.binary && (
        <p className="ew-notice">Binary file — no text diff to show.</p>
      )}
      {!failed && phase === "ready" && diff !== null && !diff.binary && (
        <DiffPane
          // Insurance, not the mechanism: setting `diff` to null during a
          // navigation already unmounts the pane through the guard above. It is
          // here because if a later change ever kept the pane mounted across a
          // file change, the failures would be severe and silent — the undo
          // history would survive, so Ctrl+Z in the new file would undo into the
          // previous one's text and auto-save it, and the language extensions,
          // appended with `StateEffect.appendConfig` and never removed, would
          // stack for the life of the window.
          key={diff.path}
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
