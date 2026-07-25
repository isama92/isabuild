import { useState } from "react";
import { AbortMergeDialog } from "./GitDialogs";
import { useGitStore } from "../store/gitStore";
import type { MergeKind } from "../lib/gitMerge";

// The strip above the Status panel's file groups while the repository is in the
// middle of something. It sits here rather than in the status bar because it has
// a sentence to say and lives directly above the rows it is talking about — a
// 24px bar has room for neither.
//
// Two shapes:
//
// - a merge (or a merge-style pull) in progress: what into what, conflicts left,
//   Continue and Abort;
// - conflicts with nothing in progress — a stash that would not reapply — where
//   there is nothing to continue and resolving is the whole job.
//
// A rebase, cherry-pick or revert is *named* and nothing more. `git merge
// --continue` is the wrong command for all three, and quietly offering it would
// be worse than saying we do not drive them yet.

/** The states this app can finish itself. */
const HANDLED: MergeKind[] = ["merge", "conflictsOnly"];

const OTHER_OPERATION: Partial<Record<MergeKind, string>> = {
  rebase: "A rebase is in progress",
  cherryPick: "A cherry-pick is in progress",
  revert: "A revert is in progress",
};

export function MergeBanner() {
  const mergeState = useGitStore((state) => state.mergeState);
  const conflicts = useGitStore((state) => state.conflicts);
  const branch = useGitStore((state) => state.branch);
  const op = useGitStore((state) => state.op);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const store = useGitStore.getState;

  if (!mergeState || mergeState.kind === "none") return null;

  const other = OTHER_OPERATION[mergeState.kind];
  if (other !== undefined) {
    return (
      <section className="merge-banner merge-banner--unsupported" aria-label="Operation in progress">
        <p className="merge-banner-title">{other}</p>
        <p className="merge-banner-detail">
          {conflicts.length > 0
            ? `${countLabel(conflicts.length)} to resolve. Finish it in the terminal — isabuild does not drive this one yet.`
            : "Finish it in the terminal — isabuild does not drive this one yet."}
        </p>
      </section>
    );
  }

  if (!HANDLED.includes(mergeState.kind)) return null;

  const remaining = conflicts.length;
  const isMerge = mergeState.kind === "merge";
  const into = branch?.current ?? "this branch";
  const title = isMerge
    ? `Merging ${mergeState.mergingRef ?? "another branch"} into ${into}`
    : "Unresolved conflicts";
  const detail =
    remaining > 0
      ? `${countLabel(remaining)} left. Click a file below to resolve it.`
      : isMerge
        ? "All conflicts resolved. Continue to commit the merge."
        : "All conflicts resolved.";

  return (
    <section className="merge-banner" aria-label="Merge in progress">
      <p className="merge-banner-title">{title}</p>
      <p className="merge-banner-detail">{detail}</p>
      {!isMerge && (
        <p className="merge-banner-detail">
          {/* Why there is no Continue: the conflicts came from applying stashed
              changes, not from a merge, so there is no merge to commit. */}
          These came from restoring stashed changes, so there is nothing to commit — resolving
          them is all that is left.
        </p>
      )}
      {isMerge && (
        <div className="merge-banner-actions">
          <button
            type="button"
            className="merge-banner-button merge-banner-button--primary"
            disabled={remaining > 0 || op !== null}
            title={
              remaining > 0
                ? "Resolve every conflict first"
                : "Commit the merge with git's own message"
            }
            onClick={() => void store().continueMerge()}
          >
            Continue
          </button>
          <button
            type="button"
            className="merge-banner-button merge-banner-button--danger"
            disabled={op !== null}
            title="Throw the merge away and restore the working tree"
            onClick={() => setConfirmAbort(true)}
          >
            Abort
          </button>
        </div>
      )}

      {confirmAbort && (
        <AbortMergeDialog
          mergingRef={mergeState.mergingRef}
          onClose={() => setConfirmAbort(false)}
          onAbort={() => {
            setConfirmAbort(false);
            void store().abortMerge();
          }}
        />
      )}
    </section>
  );
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "conflict" : "conflicts"}`;
}
