import { useState } from "react";
import { AbortOpDialog, SkipCommitDialog } from "./GitDialogs";
import { useGitStore } from "../store/gitStore";
import { opFamily, type MergeKind, type MergeState } from "../lib/gitMerge";

// The strip above the Status panel's file groups while the repository is in the
// middle of something. It sits here rather than in the status bar because it has a
// sentence to say and lives directly above the rows it is talking about — a 24px
// bar has room for neither.
//
// Part 6 named a rebase, cherry-pick or revert and stopped there, because
// `git merge --continue` is the wrong command for all three. Part 7 drives them:
// the buttons send an *action*, and the backend picks the argv from a state it
// reads itself. So one shape covers four operations, and the only real variation
// left is what to call them and whether they have a commit to skip.
//
// Still two shapes, then:
//
// - an operation in progress: what is being applied, how far through, conflicts
//   left, and Continue / Skip / Abort;
// - conflicts with nothing in progress — a stash that would not reapply — where
//   there is no command to run and resolving is the whole job.

/** How each operation is described, in the user's terms rather than git's. */
const TITLES: Record<MergeKind, (state: MergeState, branch: string) => string> = {
  merge: (state, branch) => `Merging ${state.mergingRef ?? "another branch"} into ${branch}`,
  rebase: (state) =>
    `Rebasing ${state.mergingRef ?? "this branch"}${state.onto ? ` onto ${state.onto}` : ""}`,
  cherryPick: (state) => `Cherry-picking ${describeCommit(state)}`,
  revert: (state) => `Reverting ${describeCommit(state)}`,
  conflictsOnly: () => "Unresolved conflicts",
  none: () => "",
};

/**
 * Name the commit an operation is applying: its subject where git gave us one,
 * else its sha. A bare sha names nothing a person recognises, which is why the
 * backend looks the subject up.
 */
function describeCommit(state: MergeState): string {
  if (state.subject !== null) return `“${state.subject}”`;
  return state.mergingRef ?? "a commit";
}

export function MergeBanner() {
  const mergeState = useGitStore((state) => state.mergeState);
  const conflicts = useGitStore((state) => state.conflicts);
  const branch = useGitStore((state) => state.branch);
  const op = useGitStore((state) => state.op);
  const [confirm, setConfirm] = useState<"abort" | "skip" | null>(null);
  const store = useGitStore.getState;

  if (!mergeState || mergeState.kind === "none") return null;

  const remaining = conflicts.length;
  const family = opFamily(mergeState.kind);
  const title = TITLES[mergeState.kind](mergeState, branch?.current ?? "this branch");
  const progress = mergeState.progress;

  // Nothing in progress, just conflicted paths: a conflicted stash restore. There
  // is no operation to conclude, so no buttons — resolving is all there is.
  if (family === null) {
    return (
      <section className="merge-banner" aria-label="Unresolved conflicts">
        <p className="merge-banner-title">{title}</p>
        <p className="merge-banner-detail">
          {remaining > 0
            ? `${countLabel(remaining)} left. Click a file below to resolve it.`
            : "All conflicts resolved."}
        </p>
        <p className="merge-banner-detail">
          {/* Why there is no Continue: the conflicts came from applying stashed
              changes, not from an operation, so there is nothing to commit. */}
          These came from restoring stashed changes, so there is nothing to commit — resolving them
          is all that is left.
        </p>
      </section>
    );
  }

  return (
    <section
      className="merge-banner"
      // "Merge in progress", "Cherry-pick in progress": the family with its first
      // letter raised, so a screen reader gets a sentence rather than a subcommand.
      aria-label={`${family.charAt(0).toUpperCase()}${family.slice(1)} in progress`}
    >
      <p className="merge-banner-title">{title}</p>
      <p className="merge-banner-detail">
        {progress !== null && (
          <span className="merge-banner-progress">{`commit ${progress.current} of ${progress.total} · `}</span>
        )}
        {remaining > 0
          ? `${countLabel(remaining)} left. Click a file below to resolve it.`
          : `All conflicts resolved. Continue to finish the ${family}.`}
      </p>
      <div className="merge-banner-actions">
        <button
          type="button"
          className="merge-banner-button merge-banner-button--primary"
          disabled={remaining > 0 || op !== null}
          title={
            remaining > 0
              ? "Resolve every conflict first"
              : `Commit with git's own message and carry the ${family} on`
          }
          onClick={() => void store().concludeOp("continue")}
        >
          Continue
        </button>
        {/* Absent, not disabled, for a merge: `git merge --skip` does not exist,
            and a permanently greyed button invites the question of why. */}
        {mergeState.canSkip && (
          <button
            type="button"
            className="merge-banner-button"
            disabled={op !== null}
            title="Drop the commit this is stuck on and move to the next"
            onClick={() => setConfirm("skip")}
          >
            Skip…
          </button>
        )}
        <button
          type="button"
          className="merge-banner-button merge-banner-button--danger"
          disabled={op !== null}
          title={`Throw the ${family} away and restore the working tree`}
          onClick={() => setConfirm("abort")}
        >
          Abort…
        </button>
      </div>

      {confirm === "abort" && (
        <AbortOpDialog
          family={family}
          mergingRef={mergeState.mergingRef}
          onClose={() => setConfirm(null)}
          onAbort={() => {
            setConfirm(null);
            void store().concludeOp("abort");
          }}
        />
      )}
      {confirm === "skip" && (
        <SkipCommitDialog
          family={family}
          subject={mergeState.subject}
          onClose={() => setConfirm(null)}
          onSkip={() => {
            setConfirm(null);
            void store().concludeOp("skip");
          }}
        />
      )}
    </section>
  );
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "conflict" : "conflicts"}`;
}
