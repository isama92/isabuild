import { useEffect, useState } from "react";
import { BranchMenu, type BranchPick } from "./BranchMenu";
import {
  DeleteBranchDialog,
  DirtySwitchDialog,
  MergeBranchDialog,
  NewBranchDialog,
  OpErrorDialog,
  RenameBranchDialog,
} from "./GitDialogs";
import { branchLabel, fetchAgeLabel, syncAvailability } from "../lib/branchView";
import { useGitStore } from "../store/gitStore";
import { useLayoutStore } from "../store/layoutStore";
import type { DirtyPolicy, SwitchTarget } from "../lib/gitBranch";

// The status bar's right-hand cluster: which branch, how far it has drifted from
// its upstream, and the three sync actions. Everything the branch UI can do is
// reachable from here.
//
// Sync controls are always visible and disabled when they do not apply, rather
// than appearing and disappearing — a 24px bar whose buttons move around as the
// repo state changes is unusable. Fetch is the exception: it is always available,
// since a stale ahead/behind is exactly when you need it most.

type Dialog =
  | { kind: "new" }
  | { kind: "rename"; from: string }
  | { kind: "delete"; name: string; refusal: string | null }
  | { kind: "dirty"; target: SwitchTarget }
  | { kind: "merge"; reference: string };

export function BranchStatus() {
  const repoRoot = useGitStore((state) => state.repoRoot);
  const branch = useGitStore((state) => state.branch);
  const staged = useGitStore((state) => state.staged);
  const unstaged = useGitStore((state) => state.unstaged);
  const conflicts = useGitStore((state) => state.conflicts);
  const op = useGitStore((state) => state.op);
  const opError = useGitStore((state) => state.opError);
  const notice = useGitStore((state) => state.notice);
  const mergeState = useGitStore((state) => state.mergeState);
  const requestShellCommand = useLayoutStore((state) => state.requestShellCommand);
  // Lifted into the store in Part 8 so a keybinding can open it. Everything
  // else about the menu still belongs to this component.
  const menuOpen = useLayoutStore((state) => state.branchMenuOpen);
  const setMenuOpen = useLayoutStore((state) => state.setBranchMenuOpen);
  const toggleMenu = useLayoutStore((state) => state.toggleBranchMenu);
  const pendingGitAction = useLayoutStore((state) => state.pendingGitAction);
  const clearPendingGitAction = useLayoutStore((state) => state.clearPendingGitAction);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  // `Date.now()` may not be called during render (impure, and the value would go
  // stale the moment it was rendered). Sampled when the pointer or keyboard focus
  // reaches the Fetch button — exactly when its tooltip is about to be read — so
  // the age is fresh without any polling timer.
  const [fetchNow, setFetchNow] = useState<number | null>(null);

  // A keystroke asked for a sync operation. Consumed here rather than run from
  // the keybinding hook because only this component knows whether it is
  // currently possible, and a keybinding must never do what the disabled button
  // would refuse to.
  //
  // Declared above the early return below, as the rules of hooks require, so it
  // reads the branch state from the store rather than from the narrowed local.
  useEffect(() => {
    if (pendingGitAction === null) return;
    clearPendingGitAction();
    const git = useGitStore.getState();
    const state = git.branch;
    // No branch read yet, or an operation already running: git would refuse a
    // second one anyway, and the button is hidden while one runs.
    if (state === null || git.op !== null) return;

    const sync = syncAvailability(state);
    const remote = sync.remote ?? "";
    if (pendingGitAction === "fetch" && sync.canFetch) {
      void git.runOp({ kind: "fetch", remote });
    } else if (pendingGitAction === "pull" && sync.canPull) {
      void git.runOp({ kind: "pull", remote });
    } else if (pendingGitAction === "push" && sync.canPush) {
      void git.runOp({
        kind: "push",
        remote,
        branch: state.current ?? undefined,
        setUpstream: sync.setUpstream,
      });
    }
  }, [pendingGitAction, clearPendingGitAction]);

  // Nothing to show until the first branch read lands (or outside a repo).
  if (!branch || !repoRoot) return null;
  // Re-bound so the narrowing survives into the callbacks below, which TypeScript
  // otherwise widens back to `BranchState | null`.
  const state = branch;

  const busy = op !== null;
  // The count the dirty-switch dialog reports. A file staged *and* modified
  // appears in both groups, which is the honest count of pending changes.
  //
  // Conflicts count too. They are their own group since Part 6, and leaving them
  // out made a repo whose only pending change is a conflict look clean — so a
  // switch went straight to git with no prompt, and git refused it.
  const changeCount = staged.length + unstaged.length + conflicts.length;
  const isDirty = changeCount > 0;

  const store = useGitStore.getState;

  function startSwitch(target: SwitchTarget) {
    setMenuOpen(false);
    if (isDirty) {
      setDialog({ kind: "dirty", target });
      return;
    }
    // A clean tree makes the policy irrelevant; "bring" is the no-op path.
    void store().switchTo(target, "bring");
  }

  function pick(choice: BranchPick) {
    if (choice.kind === "local") {
      if (choice.branch.name === state.current) {
        setMenuOpen(false);
        return; // already here
      }
      startSwitch({ branch: choice.branch.name });
      return;
    }
    // A remote-only branch: create a local one tracking it. `hasLocal` rows are
    // filtered out of the remote section, so this always needs the track arg.
    startSwitch({ branch: choice.branch.branch, track: choice.branch.name });
  }

  function chooseDirtyPolicy(policy: DirtyPolicy) {
    if (dialog?.kind !== "dirty") return;
    const { target } = dialog;
    setDialog(null);
    void store().switchTo(target, policy);
  }

  async function confirmDelete(force: boolean) {
    if (dialog?.kind !== "delete") return;
    const { name } = dialog;
    const ok = await store().deleteBranch(name, force);
    if (ok) {
      setDialog(null);
      return;
    }
    // git refused. Without force that means unmerged commits, so escalate to the
    // confirm-anyway variant showing git's own reason; with force it is a real
    // failure and the error dialog already has it.
    const refusal = store().opError?.detail ?? null;
    if (!force && refusal !== null) {
      store().dismissOpError();
      setDialog({ kind: "delete", name, refusal });
    } else {
      setDialog(null);
    }
  }

  const label = branchLabel(branch);
  // The same source the keybinding effect above uses, so a keystroke and a
  // click can never disagree about whether an operation is possible.
  const sync = syncAvailability(branch);
  const canSync = branch.current !== null && !branch.unborn;
  // Configured, still present, and actually on a remote. A pruned upstream is
  // configured but dead, so its counts are meaningless and pulling cannot work;
  // an upstream that is a local branch is not a remote relationship at all, so
  // these controls should treat it as unpublished rather than describe it as
  // living on a remote.
  const hasUpstream =
    branch.upstream !== null && !branch.upstreamGone && branch.upstreamOnRemote;
  const remote = branch.remote;
  // What the "gone" chip and the Pull tooltip say depends on what was lost.
  const goneDetail = branch.upstreamOnRemote
    ? `${branch.upstream ?? "The upstream"} no longer exists on the remote. Push to recreate it.`
    : `${branch.upstream ?? "The upstream"}, the local branch this tracked, no longer exists.`;
  // Why the branch menu's Merge entries are unavailable, if they are. An unborn
  // HEAD has nothing to merge into; anything already in progress has to be
  // finished or aborted first (git would refuse anyway, but a disabled entry
  // with a reason beats a modal full of git's refusal).
  const mergeBlocked =
    branch.unborn
      ? "This branch has no commits yet"
      : mergeState !== null && mergeState.kind !== "none"
        ? "Finish or abort the operation in progress first"
        : null;

  const fetchAge = fetchAgeLabel(branch.lastFetch, fetchNow);
  const fetchTitle = remote
    ? [`Fetch ${remote}`, fetchAge].filter((part) => part !== null).join(" — ")
    : "No remote to fetch from";

  return (
    <div className="branch-status">
      {notice !== null && (
        <button
          type="button"
          className="branch-notice"
          title={`${notice} (click to dismiss)`}
          onClick={() => store().dismissNotice()}
        >
          {notice}
        </button>
      )}

      {busy ? (
        <span className="branch-op">
          <span className="branch-op-label">{`${op.kind}…`}</span>
          {op.progress !== "" && <span className="branch-op-progress">{op.progress}</span>}
          <button
            type="button"
            className="branch-op-cancel"
            aria-label={`Cancel ${op.kind}`}
            title={`Cancel ${op.kind}`}
            onClick={() => void store().cancelOp()}
          >
            {"×"}
          </button>
        </span>
      ) : (
        <>
          {/* An upstream that was pruned away gets said out loud rather than
              rendered as a pair of reassuring zeroes. */}
          {canSync && branch.upstreamGone && (
            <span className="branch-gone" title={goneDetail}>
              upstream gone
            </span>
          )}

          {canSync && hasUpstream && (
            <span
              className="branch-counts"
              title={`${branch.ahead} ahead, ${branch.behind} behind ${branch.upstream ?? ""}`}
            >
              <span className="branch-count">{`↑${branch.ahead}`}</span>
              <span className="branch-count">{`↓${branch.behind}`}</span>
            </span>
          )}

          <button
            type="button"
            className="branch-action"
            aria-label="Fetch"
            title={fetchTitle}
            disabled={!sync.canFetch}
            onMouseEnter={() => setFetchNow(Date.now())}
            onFocus={() => setFetchNow(Date.now())}
            onClick={() => void store().runOp({ kind: "fetch", remote: remote ?? "" })}
          >
            <span aria-hidden="true">{"⟳"}</span>
          </button>

          <button
            type="button"
            className="branch-action"
            aria-label="Pull"
            title={
              branch.upstreamGone
                ? `${goneDetail} There is nothing to pull.`
                : !hasUpstream
                  ? "This branch has no upstream on a remote to pull from"
                  : branch.behind === 0
                    ? "Nothing to pull"
                    : `Pull ${branch.behind} from ${branch.upstream ?? ""}`
            }
            disabled={!sync.canPull}
            onClick={() => void store().runOp({ kind: "pull", remote: remote ?? "" })}
          >
            <span aria-hidden="true">{"↓"}</span>
            {branch.behind > 0 && <span className="branch-action-count">{branch.behind}</span>}
          </button>

          {/* Publish and push are one control: which one it is depends entirely
              on whether an upstream exists, so two buttons would always have
              one disabled. */}
          <button
            type="button"
            className="branch-action"
            aria-label={hasUpstream ? "Push" : "Publish branch"}
            title={
              !canSync
                ? "Commit something first"
                : !remote
                  ? "No remote to push to"
                  : !hasUpstream
                    ? `Publish ${label} to ${remote}`
                    : branch.ahead === 0
                      ? "Nothing to push"
                      : `Push ${branch.ahead} to ${branch.upstream ?? ""}`
            }
            disabled={!sync.canPush}
            onClick={() =>
              void store().runOp({
                kind: "push",
                remote: remote ?? "",
                branch: branch.current ?? undefined,
                setUpstream: sync.setUpstream,
              })
            }
          >
            {hasUpstream ? (
              <>
                <span aria-hidden="true">{"↑"}</span>
                {branch.ahead > 0 && <span className="branch-action-count">{branch.ahead}</span>}
              </>
            ) : (
              <span>Publish</span>
            )}
          </button>
        </>
      )}

      <div className="branch-picker">
        <button
          type="button"
          className="branch-current"
          aria-label="Current branch"
          aria-expanded={menuOpen}
          title={branch.upstream ? `${label} → ${branch.upstream}` : label}
          disabled={busy}
          onClick={toggleMenu}
        >
          <span aria-hidden="true">{"⑂"}</span>
          <span className="branch-current-name">{label}</span>
          {branch.unborn && <span className="branch-row-tag">no commits</span>}
        </button>
        {menuOpen && (
          <BranchMenu
            state={branch}
            busy={busy}
            onPick={pick}
            onClose={() => setMenuOpen(false)}
            onNewBranch={() => {
              setMenuOpen(false);
              setDialog({ kind: "new" });
            }}
            onRename={(from) => {
              setMenuOpen(false);
              setDialog({ kind: "rename", from });
            }}
            onDelete={(name) => {
              setMenuOpen(false);
              setDialog({ kind: "delete", name, refusal: null });
            }}
            onMerge={(reference) => {
              setMenuOpen(false);
              setDialog({ kind: "merge", reference });
            }}
            mergeBlocked={mergeBlocked}
          />
        )}
      </div>

      {dialog?.kind === "new" && (
        <NewBranchDialog
          state={branch}
          repoRoot={repoRoot}
          onClose={() => setDialog(null)}
          onCreate={(name, base) => {
            setDialog(null);
            void store().createBranch(name, base);
          }}
        />
      )}

      {dialog?.kind === "rename" && (
        <RenameBranchDialog
          from={dialog.from}
          repoRoot={repoRoot}
          onClose={() => setDialog(null)}
          onRename={(to) => {
            setDialog(null);
            void store().renameBranch(dialog.from, to);
          }}
        />
      )}

      {dialog?.kind === "delete" && (
        <DeleteBranchDialog
          name={dialog.name}
          refusal={dialog.refusal}
          onClose={() => setDialog(null)}
          onDelete={(force) => void confirmDelete(force)}
        />
      )}

      {dialog?.kind === "merge" && (
        <MergeBranchDialog
          from={dialog.reference}
          into={branch.current ?? "this branch"}
          onClose={() => setDialog(null)}
          onMerge={() => {
            const { reference } = dialog;
            setDialog(null);
            void store().mergeBranch(reference);
          }}
        />
      )}

      {dialog?.kind === "dirty" && (
        <DirtySwitchDialog
          from={branch.current ?? "this branch"}
          to={dialog.target.branch}
          changeCount={changeCount}
          onClose={() => setDialog(null)}
          onChoose={chooseDirtyPolicy}
        />
      )}

      {opError !== null && (
        <OpErrorDialog
          error={opError}
          onClose={() => store().dismissOpError()}
          onRetryInTerminal={(command) => {
            store().dismissOpError();
            requestShellCommand(command);
          }}
        />
      )}
    </div>
  );
}
