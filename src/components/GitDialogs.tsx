import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { baseOptions } from "../lib/branchView";
import { validateBranchName, type BranchState, type DirtyPolicy } from "../lib/gitBranch";
import type { OpError } from "../store/gitStore";

// The Part 5 dialogs. Each one is a controlled component: it collects an answer
// and hands it up, and never touches the git store itself, so the flow stays in
// BranchStatus where the state lives.

/**
 * A name checked by git (`check-ref-format`, plus a duplicate check), tagged
 * with the name it applies to.
 *
 * Keeping the name alongside the verdict is what lets the result be discarded
 * the instant the field changes, so a stale complaint is never shown about text
 * the user has already edited — and it means the effect never has to call
 * setState synchronously to clear one.
 */
interface NameCheck {
  name: string;
  reason: string | null;
}

const VALIDATE_DEBOUNCE_MS = 250;

/**
 * Debounced `git check-ref-format` for `name`. Returns the reason it is
 * unusable, or null when it is fine or has not been checked yet — a name still
 * being checked stays submittable, because the backend validates again and
 * reports properly.
 */
function useNameCheck(repoRoot: string, name: string, skip: boolean): string | null {
  const [checked, setChecked] = useState<NameCheck | null>(null);
  const trimmed = name.trim();

  useEffect(() => {
    if (skip || trimmed === "") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void validateBranchName(repoRoot, trimmed)
        .then((reason) => {
          if (!cancelled) setChecked({ name: trimmed, reason });
        })
        .catch(() => {
          // A validation failure must not block the attempt; the mutation
          // itself will report if the name really is unusable.
          if (!cancelled) setChecked({ name: trimmed, reason: null });
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repoRoot, trimmed, skip]);

  return checked !== null && checked.name === trimmed ? checked.reason : null;
}

// --- New branch -------------------------------------------------------------

interface NewBranchDialogProps {
  state: BranchState;
  repoRoot: string;
  /** `base` is undefined in a repo with no commits: there is nothing to start from. */
  onCreate: (name: string, base?: string) => void;
  onClose: () => void;
}

export function NewBranchDialog({ state, repoRoot, onCreate, onClose }: NewBranchDialogProps) {
  const bases = baseOptions(state);
  const [name, setName] = useState("");
  const [base, setBase] = useState(bases[0] ?? "");
  const nameId = useId();
  const baseId = useId();

  const trimmed = name.trim();
  const problem = useNameCheck(repoRoot, name, false);
  const canCreate = trimmed !== "" && problem === null;

  function submit() {
    // No options at all means an unborn HEAD; passing a base would make git fail.
    if (canCreate) onCreate(trimmed, bases.length > 0 ? base : undefined);
  }

  return (
    <Modal
      title="New branch"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-button modal-button--primary"
            disabled={!canCreate}
            onClick={submit}
          >
            Create branch
          </button>
        </>
      }
    >
      <label className="modal-label" htmlFor={nameId}>
        Name
      </label>
      <input
        id={nameId}
        className="modal-input"
        type="text"
        value={name}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      {problem !== null && (
        <p className="modal-problem" role="alert">
          {problem}
        </p>
      )}

      {bases.length > 0 ? (
        <>
          <label className="modal-label" htmlFor={baseId}>
            Based on
          </label>
          <select
            id={baseId}
            className="modal-input"
            value={base}
            onChange={(event) => setBase(event.target.value)}
          >
            {bases.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="modal-hint">
          This repository has no commits yet, so there is nothing to branch from — the new
          branch starts empty too.
        </p>
      )}
    </Modal>
  );
}

// --- Switching with uncommitted changes -------------------------------------

interface DirtySwitchDialogProps {
  from: string;
  to: string;
  changeCount: number;
  onChoose: (policy: DirtyPolicy) => void;
  onClose: () => void;
}

export function DirtySwitchDialog({
  from,
  to,
  changeCount,
  onChoose,
  onClose,
}: DirtySwitchDialogProps) {
  // Both halves of the sentence agree with the count. A single conflicted file is
  // now a common way to reach this dialog (Part 6 counts conflicts as changes),
  // which is what made "1 change that are not committed" worth fixing.
  const sentence =
    changeCount === 1
      ? `You have 1 change that is not committed to ${from}. What should happen to it?`
      : `You have ${changeCount} changes that are not committed to ${from}. What should happen to them?`;
  return (
    <Modal
      title="You have uncommitted changes"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="modal-button" onClick={() => onChoose("leave")}>
            {`Leave my changes on ${from}`}
          </button>
          <button
            type="button"
            className="modal-button modal-button--primary"
            onClick={() => onChoose("bring")}
          >
            {`Bring my changes to ${to}`}
          </button>
        </>
      }
    >
      <p className="modal-text">{sentence}</p>
      <p className="modal-hint">
        {`Leaving them stashes them for ${from}; they come back automatically the next time you switch to it.`}
      </p>
    </Modal>
  );
}

// --- Rename ----------------------------------------------------------------

interface RenameBranchDialogProps {
  from: string;
  repoRoot: string;
  onRename: (to: string) => void;
  onClose: () => void;
}

export function RenameBranchDialog({
  from,
  repoRoot,
  onRename,
  onClose,
}: RenameBranchDialogProps) {
  const [name, setName] = useState(from);
  const nameId = useId();

  const trimmed = name.trim();
  // The unchanged name would be reported as "already exists"; it is really just
  // a no-op, so it is not checked and Rename is simply disabled.
  const problem = useNameCheck(repoRoot, name, trimmed === from);
  const canRename = trimmed !== "" && trimmed !== from && problem === null;

  function submit() {
    if (canRename) onRename(trimmed);
  }

  return (
    <Modal
      title={`Rename ${from}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-button modal-button--primary"
            disabled={!canRename}
            onClick={submit}
          >
            Rename
          </button>
        </>
      }
    >
      <label className="modal-label" htmlFor={nameId}>
        New name
      </label>
      <input
        id={nameId}
        className="modal-input"
        type="text"
        value={name}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      {problem !== null && (
        <p className="modal-problem" role="alert">
          {problem}
        </p>
      )}
    </Modal>
  );
}

// --- Delete ----------------------------------------------------------------

interface DeleteBranchDialogProps {
  name: string;
  /**
   * Set once git has refused the plain delete, which is how we learn the branch
   * is unmerged. Escalating only after a real refusal means we never offer to
   * throw commits away speculatively.
   */
  refusal: string | null;
  onDelete: (force: boolean) => void;
  onClose: () => void;
}

export function DeleteBranchDialog({
  name,
  refusal,
  onDelete,
  onClose,
}: DeleteBranchDialogProps) {
  const forcing = refusal !== null;
  return (
    <Modal
      title={forcing ? `Delete ${name} anyway?` : `Delete ${name}?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-button modal-button--danger"
            onClick={() => onDelete(forcing)}
          >
            {forcing ? "Delete anyway" : "Delete"}
          </button>
        </>
      }
    >
      {forcing ? (
        <>
          <p className="modal-text">
            {`git refused to delete ${name} because it has commits that are not merged anywhere else. Deleting it now will discard them.`}
          </p>
          <pre className="modal-stderr">{refusal}</pre>
        </>
      ) : (
        <p className="modal-text">
          {`${name} will be deleted. Its commits stay reachable if they are merged somewhere else.`}
        </p>
      )}
    </Modal>
  );
}

// --- Merge ------------------------------------------------------------------

interface MergeBranchDialogProps {
  /** The ref being merged in. */
  from: string;
  /** The branch it lands on. */
  into: string;
  onMerge: () => void;
  onClose: () => void;
}

export function MergeBranchDialog({ from, into, onMerge, onClose }: MergeBranchDialogProps) {
  return (
    <Modal
      title={`Merge ${from} into ${into}?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="modal-button modal-button--primary" onClick={onMerge}>
            Merge
          </button>
        </>
      }
    >
      <p className="modal-text">
        {`Commits from ${from} will be merged into ${into}, which stays the branch you are on.`}
      </p>
      <p className="modal-hint">
        If the two have changed the same lines, the merge stops and the conflicts appear in the
        Status panel to resolve.
      </p>
    </Modal>
  );
}

interface AbortOpDialogProps {
  /** The git subcommand behind the operation: `merge`, `rebase`, … */
  family: string;
  /** What is being applied, for the sentence. */
  mergingRef: string | null;
  onAbort: () => void;
  onClose: () => void;
}

export function AbortOpDialog({ family, mergingRef, onAbort, onClose }: AbortOpDialogProps) {
  const subject = mergingRef === null ? `this ${family}` : `the ${family} of ${mergingRef}`;
  return (
    <Modal
      title={`Abort the ${family}?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Keep going
          </button>
          <button type="button" className="modal-button modal-button--danger" onClick={onAbort}>
            {`Abort ${family}`}
          </button>
        </>
      }
    >
      <p className="modal-text">
        {`Aborting throws ${subject} away and puts the working tree back as it was before it started.`}
      </p>
      {/* The one thing that is genuinely lost, said plainly: git restores the
          pre-operation tree, which includes undoing every resolution made so far. */}
      <p className="modal-hint">Any conflicts you have already resolved will be discarded.</p>
    </Modal>
  );
}

interface SkipCommitDialogProps {
  /** `rebase`, `cherry-pick` or `revert` — a merge has no commit to skip. */
  family: string;
  /** Subject of the commit being dropped, where it is known. */
  subject: string | null;
  onSkip: () => void;
  onClose: () => void;
}

/**
 * Confirm dropping the commit an operation is stuck on.
 *
 * Behind a confirm because `--skip` is destructive in a way that is easy to miss:
 * it does not skip the *conflict*, it drops that commit's changes entirely and
 * moves on. The wording says so rather than calling it "skip".
 */
export function SkipCommitDialog({ family, subject, onSkip, onClose }: SkipCommitDialogProps) {
  return (
    <Modal
      title="Drop this commit?"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className="modal-button modal-button--danger" onClick={onSkip}>
            Drop commit
          </button>
        </>
      }
    >
      <p className="modal-text">
        {subject === null
          ? `The ${family} will move on to the next commit without applying this one.`
          : `“${subject}” will not be applied. The ${family} moves on to the next commit.`}
      </p>
      <p className="modal-hint">
        {/* Said plainly, because "skip" sounds like it skips the conflict. */}
        That commit&apos;s changes are dropped, not merged. Use this when its changes are already
        present some other way.
      </p>
    </Modal>
  );
}

// --- Operation failure -----------------------------------------------------

interface OpErrorDialogProps {
  error: OpError;
  onClose: () => void;
  /** Queue the command in the bottom shell so credentials can be typed. */
  onRetryInTerminal: (command: string) => void;
}

export function OpErrorDialog({ error, onClose, onRetryInTerminal }: OpErrorDialogProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(error.detail);
      setCopied(true);
    } catch {
      // No clipboard permission (or no clipboard at all): the text is on screen
      // and selectable, so there is nothing worth interrupting the user for.
    }
  }

  return (
    <Modal
      title={error.title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="modal-button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
          {/* Only for ops that map to a command a user could actually run. */}
          {error.command !== "" && (
            <button
              type="button"
              className="modal-button"
              onClick={() => onRetryInTerminal(error.command)}
            >
              Retry in terminal
            </button>
          )}
          <button type="button" className="modal-button modal-button--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {/* git's own words, verbatim: it is localized text, so it is shown and
          never interpreted. */}
      <pre className="modal-stderr">{error.detail}</pre>
      {error.command !== "" && (
        <p className="modal-hint">
          {`Retrying in the terminal runs ${error.command} where you can enter a passphrase or token.`}
        </p>
      )}
    </Modal>
  );
}
