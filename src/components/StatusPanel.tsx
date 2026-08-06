import { useState } from "react";
import { MergeBanner } from "./MergeBanner";
import { FileContextMenu } from "./FileContextMenu";
import { CommitFileDialog, RollbackFileDialog } from "./FileDialogs";
import { useGitStore } from "../store/gitStore";
import { useLayoutStore } from "../store/layoutStore";
import { conflictHasMarkers, type ChangeStatus, type ConflictEntry, type FileEntry } from "../lib/gitStatus";
import { conflictActions, conflictLabel } from "../lib/conflictView";
import { isStagedAndModified } from "../lib/changedFiles";
import {
  changeLabel,
  conflictTooltip,
  copyValues,
  entryTooltip,
  type FileAction,
  type FileGroup,
  type FileTarget,
} from "../lib/fileActions";
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
//
// Right-clicking a row (or pressing Menu / Shift+F10 on it) opens its own menu:
// commit, rollback, stage or unstage, and the three forms of its path. What the
// menu offers is decided in `lib/fileActions`; the two irreversible items go
// through a dialog first, and every git call goes through the store so a failure
// lands in the same modal as every other mutation.

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

/**
 * Open a row's context menu from the keyboard.
 *
 * The Menu key and Shift+F10 are the two platform conventions, and without them
 * the whole feature would be mouse-only. Anchored to the row rather than to a
 * cursor that has not moved.
 */
function menuKeyPosition(event: React.KeyboardEvent): { x: number; y: number } | null {
  const wanted = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
  if (!wanted) return null;
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}

/** Everything a row needs to open its own menu, from either input device. */
interface RowMenuProps {
  onMenu: (target: FileTarget, at: { x: number; y: number }) => void;
}

function FileRow({
  entry,
  group,
  onOpen,
  onMenu,
}: {
  entry: FileEntry;
  group: Extract<FileGroup, "staged" | "unstaged">;
  onOpen: (entry: FileEntry) => void;
} & RowMenuProps) {
  // State and full path (with rename origin) on hover: the badge is one letter
  // and staged-ness is only implied by which group the row sits in, so neither
  // is readable without this.
  const title = entryTooltip(entry, group === "staged");
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
  const target: FileTarget = {
    path: entry.path,
    origPath: entry.origPath,
    group,
    status: entry.status,
  };
  return (
    <li title={title}>
      {/* A button, not a click handler on the li: keyboard focus, Enter/Space
          and the accessible role all come for free. */}
      <button
        type="button"
        className="status-row"
        onClick={() => onOpen(entry)}
        onContextMenu={(event) => {
          // preventDefault suppresses the webview's own menu, which otherwise
          // opens on top of ours.
          event.preventDefault();
          onMenu(target, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          const at = menuKeyPosition(event);
          if (!at) return;
          event.preventDefault();
          onMenu(target, at);
        }}
      >
        <span
          className={`status-badge status-badge--${entry.status}`}
          aria-label={changeLabel(entry.status)}
        >
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
  group,
  entries,
  onOpen,
  onMenu,
}: {
  title: string;
  group: Extract<FileGroup, "staged" | "unstaged">;
  entries: FileEntry[];
  onOpen: (entry: FileEntry) => void;
} & RowMenuProps) {
  if (entries.length === 0) return null;
  return (
    <section className="status-group">
      <h3 className="status-group-title">
        {title} <span className="status-group-count">{entries.length}</span>
      </h3>
      <ul className="status-list">
        {entries.map((entry) => (
          // Within a group each path is unique (one record per path).
          <FileRow
            key={`${entry.status}:${entry.path}`}
            entry={entry}
            group={group}
            onOpen={onOpen}
            onMenu={onMenu}
          />
        ))}
      </ul>
    </section>
  );
}

function ConflictRow({
  entry,
  onOpen,
  onResolve,
  onMenu,
}: {
  entry: ConflictEntry;
  onOpen: (entry: ConflictEntry) => void;
  onResolve: (entry: ConflictEntry, resolution: PathResolution) => void;
} & RowMenuProps) {
  const slash = entry.path.lastIndexOf("/");
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
  const kindLabel = conflictLabel(entry.kind);
  const actions = conflictActions(entry.kind);
  const openable = conflictHasMarkers(entry.kind);
  // `kind` and no `status`: a conflict has its own vocabulary, and the kind is
  // what says whether rolling the row back restores the file or deletes it. The
  // menu it gets is the reduced one (no commit, no staging — see `fileMenuItems`).
  const target: FileTarget = { path: entry.path, group: "conflicts", kind: entry.kind };

  function openMenu(event: React.MouseEvent) {
    event.preventDefault();
    onMenu(target, { x: event.clientX, y: event.clientY });
  }

  function openMenuFromKeyboard(event: React.KeyboardEvent) {
    const at = menuKeyPosition(event);
    if (!at) return;
    event.preventDefault();
    onMenu(target, at);
  }

  const label = (
    <>
      <span className="status-badge status-badge--conflict" aria-label={kindLabel}>
        {"!"}
      </span>
      <span className="status-path">
        {dir && <span className="status-path-dir">{dir}</span>}
        <span className="status-path-name">{name}</span>
      </span>
    </>
  );

  return (
    <li title={conflictTooltip(entry)}>
      {/* A button only when there is something to open. A row that cannot lead
          anywhere must not look like it can — but it can still be right-clicked,
          which is why the menu is wired to both forms. */}
      {openable ? (
        <button
          type="button"
          className="status-row"
          onClick={() => onOpen(entry)}
          onContextMenu={openMenu}
          onKeyDown={openMenuFromKeyboard}
        >
          {label}
        </button>
      ) : (
        // Focusable despite having nothing to open, so the Menu key can reach its
        // context menu: the alternative is a row whose only actions are
        // mouse-only. Not a button, because there is still nothing to activate.
        <div
          className="status-row status-row--static"
          tabIndex={0}
          onContextMenu={openMenu}
          onKeyDown={openMenuFromKeyboard}
        >
          {label}
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
  onMenu,
}: {
  entries: ConflictEntry[];
  onOpen: (entry: ConflictEntry) => void;
  onResolve: (entry: ConflictEntry, resolution: PathResolution) => void;
} & RowMenuProps) {
  if (entries.length === 0) return null;
  return (
    <section className="status-group status-group--conflicts">
      <h3 className="status-group-title">
        Conflicts <span className="status-group-count">{entries.length}</span>
      </h3>
      <ul className="status-list">
        {entries.map((entry) => (
          <ConflictRow
            key={entry.path}
            entry={entry}
            onOpen={onOpen}
            onResolve={onResolve}
            onMenu={onMenu}
          />
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
  const mergeKind = useGitStore((state) => state.mergeState?.kind ?? "none");
  const [openError, setOpenError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ target: FileTarget; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ kind: "commit" | "rollback"; target: FileTarget } | null>(
    null,
  );

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
   * A menu item was chosen.
   *
   * The two destructive-or-irreversible actions open a dialog; the rest run
   * straight away. Every git call goes through the store, so a failure reaches
   * the same `opError` modal with git's own words and "Retry in terminal" as
   * every other mutation in the app.
   */
  function runAction(action: FileAction, target: FileTarget) {
    const git = useGitStore.getState();
    switch (action) {
      case "commit":
      case "rollback":
        setDialog({ kind: action, target });
        return;
      case "stage":
        void git.stageFile(target);
        return;
      case "unstage":
        void git.unstageFile(target);
        return;
      case "copyRelative":
      case "copyAbsolute":
      case "copyName":
        void copyPath(action, target);
        return;
    }
  }

  async function copyPath(action: FileAction, target: FileTarget) {
    // repoRoot only matters for the absolute form; the other two are derivable
    // without it, so a missing root does not have to block them.
    const values = copyValues(repoRoot ?? "", target.path);
    const text =
      action === "copyAbsolute"
        ? values.absolute
        : action === "copyName"
          ? values.name
          : values.relative;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard permission, or no clipboard: say so rather than leaving the
      // user believing a path they will later paste is on it. Same route as a
      // failed diff-window open, since neither is a git failure.
      setOpenError(`Could not copy ${text} to the clipboard.`);
    }
  }

  /**
   * Whether this path is in both groups, i.e. staged and then changed again.
   *
   * Shared with `lib/changedFiles`, which dedupes the diff window's file list on
   * the same fact. Only the predicate is shared: this panel renders such a path as
   * two rows on purpose — they say different things and offer different actions —
   * while the diff window shows one diff for it either way.
   */
  function isAlsoModified(target: FileTarget): boolean {
    return isStagedAndModified({ staged, unstaged }, target.path);
  }

  function onMenu(target: FileTarget, at: { x: number; y: number }) {
    setOpenError(null);
    setMenu({ target, ...at });
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
        <ConflictGroup
          entries={conflicts}
          onOpen={openConflict}
          onResolve={resolveConflict}
          onMenu={onMenu}
        />
        <StatusGroup
          title="Staged Changes"
          group="staged"
          entries={staged}
          onOpen={openDiff}
          onMenu={onMenu}
        />
        <StatusGroup
          title="Changes"
          group="unstaged"
          entries={unstaged}
          onOpen={openDiff}
          onMenu={onMenu}
        />
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
      {menu !== null && (
        <FileContextMenu
          target={menu.target}
          x={menu.x}
          y={menu.y}
          // Not just a merge: git refuses a pathspec commit during a rebase,
          // cherry-pick or revert too, and `kind` names all of them.
          operationInProgress={mergeKind !== "none" && mergeKind !== "conflictsOnly"}
          onAction={runAction}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog?.kind === "commit" && (
        <CommitFileDialog
          target={dialog.target}
          alsoModified={isAlsoModified(dialog.target)}
          onCommit={(message) => {
            setDialog(null);
            void useGitStore.getState().commitFile(dialog.target, message);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "rollback" && (
        <RollbackFileDialog
          target={dialog.target}
          onRollback={() => {
            setDialog(null);
            void useGitStore.getState().rollbackFile(dialog.target);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

