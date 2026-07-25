import { useState } from "react";
import { MergeBanner } from "./MergeBanner";
import { useGitStore } from "../store/gitStore";
import { useLayoutStore } from "../store/layoutStore";
import { conflictHasMarkers, type ChangeStatus, type ConflictEntry, type FileEntry } from "../lib/gitStatus";
import { conflictActions, conflictLabel } from "../lib/conflictView";
import type { PathResolution } from "../lib/gitMerge";
import { openDiffWindow } from "../lib/diffWindow";
import { openMergeWindow } from "../lib/mergeWindow";

// Right-side git status region: changed files grouped into Conflicts, Staged
// Changes and Changes (VS Code style), colored by status. Live data comes from
// the git store, refreshed by useRepoWatch at the Layout root.
//
// Clicking a row opens that file's diff in its own window (Part 4) — one window
// per file, deduped, so clicking the same file again just focuses it. Every
// row is clickable: untracked, deleted and binary files each render their own
// state in the diff window rather than being dead ends here.
//
// Conflicts (Part 6) come first, because they block everything else, and they
// route to the merge window instead. The ones with no conflict markers — a file
// one side deleted, say — have nothing to show in a window, so they carry their
// whole-file resolutions inline.

// Single-letter badge per status: the git letter for tracked changes, "U" for
// untracked.
const STATUS_BADGE: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "U",
};

function FileRow({ entry, onOpen }: { entry: FileEntry; onOpen: (entry: FileEntry) => void }) {
  // Full path (with rename origin) on hover; split so the filename reads first
  // and the directory is dimmed behind it.
  const title = entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path;
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
  return (
    <li title={title}>
      {/* A button, not a click handler on the li: keyboard focus, Enter/Space
          and the accessible role all come for free. */}
      <button type="button" className="status-row" onClick={() => onOpen(entry)}>
        <span className={`status-badge status-badge--${entry.status}`} aria-label={entry.status}>
          {STATUS_BADGE[entry.status]}
        </span>
        <span className="status-path">
          {dir && <span className="status-path-dir">{dir}</span>}
          <span className="status-path-name">{name}</span>
        </span>
      </button>
    </li>
  );
}

function StatusGroup({
  title,
  entries,
  onOpen,
}: {
  title: string;
  entries: FileEntry[];
  onOpen: (entry: FileEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="status-group">
      <h3 className="status-group-title">
        {title} <span className="status-group-count">{entries.length}</span>
      </h3>
      <ul className="status-list">
        {entries.map((entry) => (
          // Within a group each path is unique (one record per path).
          <FileRow key={`${entry.status}:${entry.path}`} entry={entry} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function ConflictRow({
  entry,
  onOpen,
  onResolve,
}: {
  entry: ConflictEntry;
  onOpen: (entry: ConflictEntry) => void;
  onResolve: (entry: ConflictEntry, resolution: PathResolution) => void;
}) {
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
  const kindLabel = conflictLabel(entry.kind);
  const actions = conflictActions(entry.kind);
  const openable = conflictHasMarkers(entry.kind);

  return (
    <li title={`${entry.path} — ${kindLabel}`}>
      {/* A button only when there is something to open. A row that cannot lead
          anywhere must not look like it can. */}
      {openable ? (
        <button type="button" className="status-row" onClick={() => onOpen(entry)}>
          <span className="status-badge status-badge--conflict" aria-label={entry.kind}>
            {"!"}
          </span>
          <span className="status-path">
            {dir && <span className="status-path-dir">{dir}</span>}
            <span className="status-path-name">{name}</span>
          </span>
        </button>
      ) : (
        <div className="status-row status-row--static">
          <span className="status-badge status-badge--conflict" aria-label={entry.kind}>
            {"!"}
          </span>
          <span className="status-path">
            {dir && <span className="status-path-dir">{dir}</span>}
            <span className="status-path-name">{name}</span>
          </span>
        </div>
      )}
      {actions.length > 0 && (
        <div className="conflict-actions">
          <span className="conflict-kind">{kindLabel}</span>
          {actions.map((action) => (
            <button
              key={action.resolution}
              type="button"
              className={
                action.destructive
                  ? "conflict-action conflict-action--danger"
                  : "conflict-action"
              }
              title={action.title}
              onClick={() => onResolve(entry, action.resolution)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function ConflictGroup({
  entries,
  onOpen,
  onResolve,
}: {
  entries: ConflictEntry[];
  onOpen: (entry: ConflictEntry) => void;
  onResolve: (entry: ConflictEntry, resolution: PathResolution) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="status-group status-group--conflicts">
      <h3 className="status-group-title">
        Conflicts <span className="status-group-count">{entries.length}</span>
      </h3>
      <ul className="status-list">
        {entries.map((entry) => (
          <ConflictRow key={entry.path} entry={entry} onOpen={onOpen} onResolve={onResolve} />
        ))}
      </ul>
    </section>
  );
}

export function StatusPanel() {
  const setStatusPanelVisible = useLayoutStore((state) => state.setStatusPanelVisible);
  const phase = useGitStore((state) => state.phase);
  const error = useGitStore((state) => state.error);
  const repoRoot = useGitStore((state) => state.repoRoot);
  const staged = useGitStore((state) => state.staged);
  const unstaged = useGitStore((state) => state.unstaged);
  const conflicts = useGitStore((state) => state.conflicts);
  const [openError, setOpenError] = useState<string | null>(null);

  const isEmpty = staged.length === 0 && unstaged.length === 0 && conflicts.length === 0;

  function openDiff(entry: FileEntry) {
    if (!repoRoot) {
      // Only reachable before the first successful status fetch, which is also
      // the only time there are no rows to click.
      setOpenError("No repository resolved yet.");
      return;
    }
    setOpenError(null);
    openDiffWindow({ repoRoot, path: entry.path, origPath: entry.origPath }).catch(
      (cause: unknown) => {
        setOpenError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }

  function openConflict(entry: ConflictEntry) {
    if (!repoRoot) {
      setOpenError("No repository resolved yet.");
      return;
    }
    setOpenError(null);
    openMergeWindow({ repoRoot, path: entry.path }).catch((cause: unknown) => {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    });
  }

  function resolveConflict(entry: ConflictEntry, resolution: PathResolution) {
    // Failures land in the store's opError modal, which BranchStatus renders —
    // the same route every other git mutation takes.
    void useGitStore.getState().resolveConflictPath(entry.path, resolution);
  }

  /**
   * The render table, in priority order. `phase` is the *settled* state, so none
   * of these arms can be reached by a read in flight: a refresh leaves the phase
   * and the lists it found alone, and the previous result stays on screen until
   * the new one replaces it.
   *
   * Guard clauses rather than nested ternaries on purpose. The Part 9 flicker
   * lived in a four-deep ternary here, where "the empty state is gated on the
   * phase" was true but unreadable.
   */
  function changesBody() {
    if (phase === "error") {
      // Kept during a retry, deliberately: `error` is only cleared on success,
      // so the switch back to data is atomic. A placeholder here would just make
      // a broken repo alternate instead of a clean one.
      return <p className="status-empty">{error ?? "Could not read git status."}</p>;
    }
    if (phase === "idle") {
      // Nothing has been read yet: first mount, or straight after a project
      // switch, which resets this store to `idle`. NOT a refreshing indicator —
      // that reset is the *only* route back to `idle` once a read has settled, so
      // this cannot alternate with "No changes" the way an in-flight flag would.
      return <p className="status-empty">Loading changes…</p>;
    }
    // `phase` is necessarily "ready" here, so the empty state no longer gates on
    // it. That gate is what a clean repo failed on every single read.
    if (isEmpty) {
      return <p className="status-empty">No changes</p>;
    }
    return (
      <>
        {/* Conflicts first: nothing else can be committed until they are gone. */}
        <ConflictGroup entries={conflicts} onOpen={openConflict} onResolve={resolveConflict} />
        <StatusGroup title="Staged Changes" entries={staged} onOpen={openDiff} />
        <StatusGroup title="Changes" entries={unstaged} onOpen={openDiff} />
      </>
    );
  }

  return (
    <>
      <div className="panel-header">
        <span className="panel-header-title">Status</span>
        <button
          type="button"
          className="panel-close"
          aria-label="Close status panel"
          title="Close Status (Alt+2)"
          onClick={() => setStatusPanelVisible(false)}
        >
          {"×"}
        </button>
      </div>
      <div className="panel-body status-panel-body">
        {/* Above the branches below: the merge banner has to stay visible even
            when the last conflict has just been resolved, because that is
            exactly when Continue becomes the thing to click. */}
        <MergeBanner />
        {/* Outside the branches too: a failure to open a diff window must stay
            readable even if the file list empties in the meantime. */}
        {openError !== null && (
          <p className="status-empty status-open-error" role="alert">
            {openError}
          </p>
        )}
        {changesBody()}
      </div>
    </>
  );
}
