import { useState } from "react";
import { useGitStore } from "../store/gitStore";
import { useLayoutStore } from "../store/layoutStore";
import type { ChangeStatus, FileEntry } from "../lib/gitStatus";
import { openDiffWindow } from "../lib/diffWindow";

// Right-side git status region: changed files grouped into Staged Changes and
// Changes (VS Code style), colored by status. Live data comes from the git
// store, refreshed by useRepoWatch at the Layout root.
//
// Clicking a row opens that file's diff in its own window (Part 4) — one window
// per file, deduped, so clicking the same file again just focuses it. Every
// row is clickable: untracked, deleted and binary files each render their own
// state in the diff window rather than being dead ends here.

// Single-letter badge per status: the git letter for tracked changes, "U" for
// untracked, "!" for a conflict.
const STATUS_BADGE: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "U",
  unmerged: "!",
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

export function StatusPanel() {
  const setStatusPanelVisible = useLayoutStore((state) => state.setStatusPanelVisible);
  const phase = useGitStore((state) => state.phase);
  const error = useGitStore((state) => state.error);
  const repoRoot = useGitStore((state) => state.repoRoot);
  const staged = useGitStore((state) => state.staged);
  const unstaged = useGitStore((state) => state.unstaged);
  const [openError, setOpenError] = useState<string | null>(null);

  const isEmpty = staged.length === 0 && unstaged.length === 0;

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
        {/* Outside the branches below: a failure to open a diff window must stay
            readable even if the file list empties in the meantime. */}
        {openError !== null && (
          <p className="status-empty status-open-error" role="alert">
            {openError}
          </p>
        )}
        {phase === "error" ? (
          <p className="status-empty">{error ?? "Could not read git status."}</p>
        ) : isEmpty && phase === "ready" ? (
          <p className="status-empty">No changes</p>
        ) : (
          <>
            <StatusGroup title="Staged Changes" entries={staged} onOpen={openDiff} />
            <StatusGroup title="Changes" entries={unstaged} onOpen={openDiff} />
          </>
        )}
      </div>
    </>
  );
}
