import { useGitStore } from "../store/gitStore";
import { useLayoutStore } from "../store/layoutStore";
import type { ChangeStatus, FileEntry } from "../lib/gitStatus";

// Right-side git status region: changed files grouped into Staged Changes and
// Changes (VS Code style), colored by status. Rows are display-only for now;
// click-to-diff is Part 4. Live data comes from the git store, refreshed by
// useRepoWatch at the Layout root.

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

function FileRow({ entry }: { entry: FileEntry }) {
  // Full path (with rename origin) on hover; split so the filename reads first
  // and the directory is dimmed behind it.
  const title = entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path;
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
  return (
    <li className="status-row" title={title}>
      <span className={`status-badge status-badge--${entry.status}`} aria-label={entry.status}>
        {STATUS_BADGE[entry.status]}
      </span>
      <span className="status-path">
        {dir && <span className="status-path-dir">{dir}</span>}
        <span className="status-path-name">{name}</span>
      </span>
    </li>
  );
}

function StatusGroup({ title, entries }: { title: string; entries: FileEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section className="status-group">
      <h3 className="status-group-title">
        {title} <span className="status-group-count">{entries.length}</span>
      </h3>
      <ul className="status-list">
        {entries.map((entry) => (
          // Within a group each path is unique (one record per path).
          <FileRow key={`${entry.status}:${entry.path}`} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

export function StatusPanel() {
  const setStatusPanelVisible = useLayoutStore((state) => state.setStatusPanelVisible);
  const phase = useGitStore((state) => state.phase);
  const error = useGitStore((state) => state.error);
  const staged = useGitStore((state) => state.staged);
  const unstaged = useGitStore((state) => state.unstaged);

  const isEmpty = staged.length === 0 && unstaged.length === 0;

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
        {phase === "error" ? (
          <p className="status-empty">{error ?? "Could not read git status."}</p>
        ) : isEmpty && phase === "ready" ? (
          <p className="status-empty">No changes</p>
        ) : (
          <>
            <StatusGroup title="Staged Changes" entries={staged} />
            <StatusGroup title="Changes" entries={unstaged} />
          </>
        )}
      </div>
    </>
  );
}
