import { useEffect, useMemo, useRef, useState } from "react";
import { filterBranches } from "../lib/branchView";
import type { BranchState, LocalBranch, RemoteBranch } from "../lib/gitBranch";

// The branch dropdown, GitHub Desktop style: filter as you type, locals first,
// then branches that only exist on a remote.
//
// It opens *upward* because it hangs off the bottom status bar and `#root` is
// `overflow: hidden` — a downward popover would be clipped away entirely.
//
// Rows are buttons, matching the Status panel's rationale: keyboard focus,
// Enter/Space and the accessible role all come for free. ↑/↓ move between them
// explicitly so the filter field can keep the text cursor while you navigate.

/** A row in the flattened, filtered list. */
export type BranchPick =
  | { kind: "local"; branch: LocalBranch }
  | { kind: "remote"; branch: RemoteBranch };

/**
 * The per-row "Merge into <current>" entry. One component for both sections so
 * the disabled reasons cannot drift apart between them — a merge is refused for
 * the same reasons wherever the row lives.
 */
function MergeAction({
  reference,
  into,
  isCurrent,
  busy,
  blocked,
  onMerge,
}: {
  reference: string;
  into: string | null;
  /** The row *is* the current branch, so there is nothing to merge. */
  isCurrent: boolean;
  busy: boolean;
  blocked: string | null;
  onMerge: () => void;
}) {
  const reason = isCurrent
    ? "This is the branch you are on"
    : into === null
      ? "Merging needs a branch checked out"
      : blocked;
  return (
    <button
      type="button"
      disabled={busy || reason !== null}
      title={reason ?? `Merge ${reference} into ${into ?? "the current branch"}`}
      onClick={onMerge}
    >
      {into === null ? "Merge…" : `Merge into ${into}…`}
    </button>
  );
}

interface BranchMenuProps {
  state: BranchState;
  onPick: (pick: BranchPick) => void;
  onNewBranch: () => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
  /** Merge this ref into the current branch. `ref` is a branch or `origin/x`. */
  onMerge: (reference: string) => void;
  onClose: () => void;
  /** Disables every action; set while an operation is running. */
  busy?: boolean;
  /**
   * Why merging is unavailable right now (an unborn HEAD, a merge already in
   * progress), or null when it is available. Shown as the disabled action's
   * tooltip, so a greyed-out Merge always says why.
   */
  mergeBlocked?: string | null;
}

export function BranchMenu({
  state,
  onPick,
  onNewBranch,
  onRename,
  onDelete,
  onMerge,
  onClose,
  busy = false,
  mergeBlocked = null,
}: BranchMenuProps) {
  const [query, setQuery] = useState("");
  // null until the user has moved into the list, so the first ArrowDown lands on
  // the *first* row rather than skipping it.
  const [active, setActive] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { locals, remotes } = useMemo(() => filterBranches(state, query), [state, query]);
  const rows: BranchPick[] = useMemo(
    () => [
      ...locals.map((branch): BranchPick => ({ kind: "local", branch })),
      ...remotes.map((branch): BranchPick => ({ kind: "remote", branch })),
    ],
    [locals, remotes],
  );

  // Filtering shrinks the list under the cursor, so clamp on the way out rather
  // than storing a corrected value: an effect that setState'd here would cause a
  // second render pass on every keystroke.
  const activeRow =
    active === null || rows.length === 0 ? null : Math.min(active, rows.length - 1);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Click outside closes. Mousedown, not click, so a drag that starts outside
  // does not leave the menu open behind a selection.
  useEffect(() => {
    function onMouseDown(event: MouseEvent) {
      const container = containerRef.current;
      if (container && event.target instanceof Node && !container.contains(event.target)) {
        onCloseRef.current();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  function move(delta: number) {
    if (rows.length === 0) return;
    const next =
      activeRow === null
        ? // Entering the list: Down starts at the top, Up wraps to the bottom.
          delta > 0
          ? 0
          : rows.length - 1
        : (activeRow + delta + rows.length) % rows.length;
    setActive(next);
    rowRefs.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    // Letters must reach the filter field, so this only claims the keys that
    // have no meaning while typing a branch name.
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter": {
        // Enter straight from the filter field takes the top match, which is what
        // typing a few characters and hitting Enter should obviously do.
        const pick = rows[activeRow ?? 0];
        if (pick && !busy) {
          event.preventDefault();
          onPick(pick);
        }
        break;
      }
      default:
        break;
    }
  }

  return (
    <div className="branch-menu" ref={containerRef} onKeyDown={onKeyDown}>
      <input
        className="branch-filter"
        type="text"
        value={query}
        placeholder="Filter branches"
        aria-label="Filter branches"
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="branch-menu-list">
        {rows.length === 0 && <p className="branch-menu-empty">No matching branches</p>}

        {locals.length > 0 && <h3 className="branch-menu-heading">Branches</h3>}
        {/* Row indices are positional: locals occupy [0, locals.length), remotes
            follow. `rows` above is built in exactly this order. */}
        {locals.map((branch, rowIndex) => {
          const isCurrent = branch.name === state.current;
          return (
            <div className="branch-row" key={`local:${branch.name}`}>
              <button
                type="button"
                className="branch-row-pick"
                ref={(el) => {
                  rowRefs.current[rowIndex] = el;
                }}
                disabled={busy}
                aria-current={isCurrent}
                // An explicit label: the visible content reads as
                // "✓ main local only", which is not a useful button name.
                aria-label={isCurrent ? `${branch.name}, current branch` : `Switch to ${branch.name}`}
                onFocus={() => setActive(rowIndex)}
                onClick={() => onPick({ kind: "local", branch })}
              >
                <span className="branch-row-mark" aria-hidden="true">
                  {isCurrent ? "✓" : ""}
                </span>
                <span className="branch-row-name">{branch.name}</span>
                {branch.upstream === undefined && (
                  <span className="branch-row-tag">local only</span>
                )}
              </button>
              <button
                type="button"
                className="branch-row-more"
                aria-label={`Actions for ${branch.name}`}
                aria-expanded={menuFor === branch.name}
                disabled={busy}
                onClick={() => setMenuFor(menuFor === branch.name ? null : branch.name)}
              >
                {"⋯"}
              </button>
              {menuFor === branch.name && (
                <div className="branch-row-actions">
                  <MergeAction
                    reference={branch.name}
                    into={state.current}
                    isCurrent={isCurrent}
                    busy={busy}
                    blocked={mergeBlocked}
                    onMerge={() => {
                      setMenuFor(null);
                      onMerge(branch.name);
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy || !isCurrent}
                    // git can only rename via -m from the branch you are on in
                    // the flow we expose; keeping it to the current branch also
                    // keeps the dialog's "from" unambiguous.
                    title={isCurrent ? undefined : "Switch to this branch to rename it"}
                    onClick={() => {
                      setMenuFor(null);
                      onRename(branch.name);
                    }}
                  >
                    Rename…
                  </button>
                  <button
                    type="button"
                    disabled={busy || isCurrent}
                    title={isCurrent ? "You cannot delete the branch you are on" : undefined}
                    onClick={() => {
                      setMenuFor(null);
                      onDelete(branch.name);
                    }}
                  >
                    Delete…
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {remotes.length > 0 && <h3 className="branch-menu-heading">Remote branches</h3>}
        {remotes.map((branch, offset) => {
          const rowIndex = locals.length + offset;
          return (
            <div className="branch-row" key={`remote:${branch.name}`}>
              <button
                type="button"
                className="branch-row-pick"
                ref={(el) => {
                  rowRefs.current[rowIndex] = el;
                }}
                disabled={busy}
                aria-label={`Check out ${branch.name}`}
                onFocus={() => setActive(rowIndex)}
                onClick={() => onPick({ kind: "remote", branch })}
              >
                <span className="branch-row-mark" aria-hidden="true" />
                <span className="branch-row-name">{branch.name}</span>
                <span className="branch-row-tag">check out</span>
              </button>
              {/* Remote rows get the same actions affordance, with merge as its
                  only entry: `git merge origin/main` is an everyday thing to
                  want, and it needs no local branch to exist first. */}
              <button
                type="button"
                className="branch-row-more"
                aria-label={`Actions for ${branch.name}`}
                aria-expanded={menuFor === branch.name}
                disabled={busy}
                onClick={() => setMenuFor(menuFor === branch.name ? null : branch.name)}
              >
                {"⋯"}
              </button>
              {menuFor === branch.name && (
                <div className="branch-row-actions">
                  <MergeAction
                    reference={branch.name}
                    into={state.current}
                    isCurrent={false}
                    busy={busy}
                    blocked={mergeBlocked}
                    onMerge={() => {
                      setMenuFor(null);
                      onMerge(branch.name);
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="branch-menu-footer">
        <button type="button" className="branch-menu-new" disabled={busy} onClick={onNewBranch}>
          {"+ New branch…"}
        </button>
      </div>
    </div>
  );
}
