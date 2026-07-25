// Git state for the active repository: the working-tree status (Part 3) and the
// branch/remote state (Part 5). The store holds the data and the actions; the
// hooks/useRepoWatch layer drives when reads run (once on mount, then on every
// `repo://changed`). Mirrors layoutStore's initial-state-export pattern so tests
// reset via a merge setState.
//
// The one non-obvious rule is the operation guard. A mutating git operation
// writes inside `.git`, which the watcher is watching, so it re-fires
// `repo://changed` — a large fetch does so repeatedly for its whole duration.
// Reads are therefore skipped while an operation is in flight and run once when
// it finishes; without that, a fetch would trigger dozens of pointless
// `git_status` + `git_branch_state` round trips against a repo that is mid-write.
//
// Two rules from Part 9, both about reads that overlap each other:
//
//   * `phase` is the *settled* outcome of the last read and never regresses
//     while one is in flight. See GitStatusPhase for what gating on a transient
//     value cost us.
//   * `refreshAll` is coalesced: at most one cascade runs and at most one waits,
//     and unless the operation guard above skips the read entirely, it resolves
//     after a read that *began after the call* — so a mutation awaiting it is not
//     handed the picture from before its own write. See requestCascade.

import { create } from "zustand";
import { getStatus, type ConflictEntry, type FileEntry } from "../lib/gitStatus";
import {
  getMergeState,
  mergeRef,
  opCommand,
  opFailureTitle,
  opSuccessNotice,
  resolvePath as invokeResolvePath,
  runOp as invokeRunOp,
  type MergeState,
  type OpAction,
  type PathResolution,
} from "../lib/gitMerge";
import {
  createBranch as invokeCreateBranch,
  deleteBranch as invokeDeleteBranch,
  getBranchState,
  renameBranch as invokeRenameBranch,
  switchBranch,
  type BranchState,
  type DirtyPolicy,
  type SwitchTarget,
} from "../lib/gitBranch";
import {
  cancelRemoteOp,
  remoteOpCommand,
  runRemoteOp,
  type RemoteOpKind,
  type RemoteOpSpec,
} from "../lib/gitRemote";

/**
 * The *settled* outcome of the last status read: never read, last read
 * succeeded, last read failed.
 *
 * Deliberately has no in-flight member. A refresh leaves the previous phase
 * alone so the panel keeps rendering the last known result for the duration of
 * the read, which is what a dirty repo always did by accident — its stale rows
 * are not gated on the phase. A clean repo was not so lucky: a transient
 * `"loading"` failed the empty state's `phase === "ready"` gate, so "No changes"
 * vanished and came back on every watcher event, several times a second (Part 9).
 * Removing the member is what makes that unrepresentable rather than merely
 * fixed.
 */
export type GitStatusPhase = "idle" | "ready" | "error";

/** A network operation in flight. */
export interface RunningOp {
  id: string;
  kind: RemoteOpKind;
  /** Latest line of git's own progress output; empty until the first one. */
  progress: string;
}

/**
 * Something that needs the modal rather than the status bar: a failed operation,
 * or one that succeeded with a warning the user must actually read (a stash that
 * would not reapply leaves conflict markers in the tree — far too important for
 * an ellipsised one-liner in a 24px bar).
 */
export interface OpError {
  title: string;
  /** git's own text verbatim where there is any. Shown as-is, never parsed. */
  detail: string;
  /** The equivalent command line for "Retry in terminal"; empty when there is none. */
  command: string;
}

export interface GitState {
  /** Resolved repository root, or null before the first successful fetch. */
  repoRoot: string | null;
  staged: FileEntry[];
  unstaged: FileEntry[];
  /** Conflicted paths; their own group, not unstaged rows (Part 6). */
  conflicts: ConflictEntry[];
  phase: GitStatusPhase;
  error: string | null;
  /**
   * Bumped by projectStore when the open project changes, so anything that started
   * against the previous repo can tell that its result is no longer wanted.
   *
   * Deliberately outside `initialGitState`, which is the reset payload *and* what
   * every test's `beforeEach` merges in: a counter listed there would be reset to
   * zero between tests, and a comparison against a captured value is only
   * meaningful if the counter never goes backwards.
   */
  generation: number;
  /** Branch/upstream/ahead-behind, or null before the first successful read. */
  branch: BranchState | null;
  /** What the repo is in the middle of, or null before the first read. */
  mergeState: MergeState | null;
  op: RunningOp | null;
  opError: OpError | null;
  /** Transient one-liner, e.g. "3 changes stashed from main". */
  notice: string | null;

  /**
   * Fetch status. The first call resolves the repo from the open project (the
   * backend holds it); later calls reuse the resolved root, which is why
   * switching projects resets this store. Never throws — a failure (no project
   * open, or not a git repository) lands in `phase: "error"` + `error`.
   *
   * Leaves `phase` and the file lists it found alone until the read lands, so
   * the panel has something to render throughout.
   */
  refresh: () => Promise<void>;
  /** Fetch branch state. Never throws; a failure leaves the last known state. */
  refreshBranch: () => Promise<void>;
  /** Fetch merge state. Never throws; a failure leaves the last known state. */
  refreshMerge: () => Promise<void>;
  /**
   * All three reads, skipped while an operation is running, and coalesced:
   * overlapping calls share one cascade plus at most one trailing run. When it
   * does read, it resolves after a status read that *began after the call*, so
   * awaiting it after a write never yields the write's own "before" picture.
   */
  refreshAll: () => Promise<void>;

  switchTo: (target: SwitchTarget, policy: DirtyPolicy) => Promise<boolean>;
  createBranch: (name: string, base?: string) => Promise<boolean>;
  deleteBranch: (name: string, force: boolean) => Promise<boolean>;
  renameBranch: (from: string, to: string) => Promise<boolean>;

  /**
   * Merge `reference` into the current branch. Resolves true when the merge
   * completed; a merge that stopped on conflicts resolves **false** with the
   * conflicts in `conflicts` and no `opError` — stopping on a conflict is an
   * outcome, not a failure.
   */
  mergeBranch: (reference: string) => Promise<boolean>;
  /**
   * Continue, skip or abort whatever is in progress — a merge, rebase,
   * cherry-pick or revert.
   *
   * Only the *action* is sent; which git command carries it out is decided in the
   * backend from a state it reads itself, so a stale `mergeState` here cannot
   * send `rebase --abort` at a merge.
   */
  concludeOp: (action: OpAction) => Promise<boolean>;
  /** Resolve a whole conflicted path (the kinds with no markers). */
  resolveConflictPath: (path: string, resolution: PathResolution) => Promise<boolean>;

  /** Start a network op. Resolves true when it exited zero. */
  runOp: (spec: RemoteOpSpec) => Promise<boolean>;
  cancelOp: () => Promise<void>;

  dismissOpError: () => void;
  dismissNotice: () => void;
}

/** Data fields only (no actions), so tests can reset via a merge setState. */
export const initialGitState = {
  repoRoot: null as string | null,
  staged: [] as FileEntry[],
  unstaged: [] as FileEntry[],
  conflicts: [] as ConflictEntry[],
  phase: "idle" as GitStatusPhase,
  error: null as string | null,
  branch: null as BranchState | null,
  mergeState: null as MergeState | null,
  op: null as RunningOp | null,
  opError: null as OpError | null,
  notice: null as string | null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useGitStore = create<GitState>((set, get) => {
  /**
   * Run a mutating branch action: clear the last error, run it, refresh, and
   * turn a failure into `opError` rather than a rejection. Returns whether it
   * worked, so callers (dialogs) know whether to close.
   *
   * `command` is the equivalent command line for "Retry in terminal", where
   * there is one worth offering. Empty means the modal shows no retry.
   */
  async function mutate(
    title: string,
    action: () => Promise<void>,
    command = "",
  ): Promise<boolean> {
    const started = get().generation;
    set({ opError: null });
    try {
      await action();
    } catch (error) {
      // Not reported if the user has since opened another project: the message and
      // its "Retry in terminal" belong to a repo that is no longer open. See
      // `superseded`.
      if (superseded(started)) return false;
      set({ opError: { title, detail: messageOf(error), command } });
      return false;
    }
    if (superseded(started)) return false;
    await get().refreshAll();
    return true;
  }

  /**
   * The cascade currently running, and the promise for the one call queued
   * behind it.
   *
   * The watcher can fire `repo://changed` several times a second, and each
   * cascade is three reads, around thirteen git subprocesses. Overlapping runs
   * are pure waste, so at most one runs and at most one waits: the waiting one
   * starts after the running one finishes, which keeps the final state fresh
   * however many events arrived while we were reading.
   *
   * Closure state rather than store fields, like runOp's `opId`. Nothing renders
   * it, and a promise slot in the store would be blanked by projectStore's
   * project-switch reset while a cascade was still running, which would let an
   * overlapping one start: the opposite of the point.
   */
  let cascade: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  /**
   * The three reads, coalesced with whatever is already in flight.
   *
   * Resolves *after* a status read that began after this call, which is why a
   * late caller joins the queued run rather than the one already in flight: a
   * mutation awaiting this must not be handed a read that started before its own
   * write.
   *
   * The exception is deliberate: the queued run re-enters through the action, so
   * an operation that has started by then skips the read altogether and every
   * joined caller resolves without one. `runOp` refreshes when it finishes.
   */
  function requestCascade(): Promise<void> {
    if (cascade === null) {
      cascade = (async () => {
        try {
          await get().refresh();
          await get().refreshBranch();
          await get().refreshMerge();
        } catch {
          // All three record their own failures and never throw. Swallowing a
          // hypothetical one anyway is what stops a rejected cascade sitting in
          // `queued` and killing every later refresh for the rest of the session.
        } finally {
          cascade = null;
        }
      })();
      return cascade;
    }
    if (queued === null) {
      // Back through the action, so the operation guard covers the queued run
      // too: an operation that started mid-cascade must still suppress the read.
      queued = cascade.then(() => {
        queued = null;
        return get().refreshAll();
      });
    }
    return queued;
  }

  /**
   * Whether the project changed under something that was already in flight, in
   * which case its result belongs to a repo the user has left.
   *
   * Two distinct harms, hence the checks on the operations as well as the reads. A
   * read that writes back pins `repoRoot` to the old repo, and every later refresh
   * then follows it, so the panel shows the wrong repository for the rest of the
   * session. An *operation* reporting late is worse than merely wrong: an `opError`
   * offers "Retry in terminal", and the terminal is now rooted in the new project.
   */
  function superseded(started: number): boolean {
    return get().generation !== started;
  }

  return {
    ...initialGitState,
    generation: 0,

    refresh: async () => {
      // No phase change on the way in — see GitStatusPhase. There is nothing to
      // clear either: on success every list is replaced wholesale below.
      const started = get().generation;
      try {
        const status = await getStatus(get().repoRoot ?? undefined);
        if (superseded(started)) return;
        set({
          repoRoot: status.repoRoot,
          staged: status.staged,
          unstaged: status.unstaged,
          conflicts: status.conflicts,
          phase: "ready",
          error: null,
        });
      } catch (error) {
        if (superseded(started)) return;
        set({ phase: "error", error: messageOf(error) });
      }
    },

    refreshBranch: async () => {
      const root = get().repoRoot;
      if (!root) return; // status resolves the root first
      const started = get().generation;
      try {
        const branch = await getBranchState(root);
        if (superseded(started)) return;
        set({ branch });
      } catch {
        // Keep the last known branch state: the status panel's own error
        // reporting already covers "this is not a repository", and blanking the
        // status bar on a transient read failure only loses information.
      }
    },

    refreshMerge: async () => {
      const root = get().repoRoot;
      if (!root) return; // status resolves the root first
      const started = get().generation;
      try {
        const merge = await getMergeState(root);
        if (superseded(started)) return;
        set({ mergeState: merge });
      } catch {
        // Same reasoning as refreshBranch: keep the last known state rather than
        // blanking the banner — and a banner that vanishes mid-merge is worse
        // than a stale one, because it is the only route to Continue and Abort.
      }
    },

    refreshAll: async () => {
      // See the module note: an op is writing inside .git and re-firing the
      // watcher; reading mid-flight is wasted work. runOp refreshes at the end.
      if (get().op) return;
      await requestCascade();
    },

    switchTo: async (target, policy) => {
      const started = get().generation;
      set({ opError: null, notice: null });
      try {
        const outcome = await switchBranch(get().repoRoot ?? "", target, policy);
        // Nothing about a branch in the previous project belongs on the new one's
        // status bar. See `superseded`.
        if (superseded(started)) return false;
        // Routine facts go to the status bar; warnings go to the modal, because
        // the switch succeeded but something about the user's work did not.
        const notices: string[] = [];
        if (outcome.stashedFrom) {
          notices.push(`Changes stashed from ${outcome.stashedFrom}`);
        }
        if (outcome.restored) {
          notices.push(`Restored changes stashed on ${outcome.branch}`);
        }
        set({
          notice: notices.length > 0 ? notices.join(". ") : null,
          opError:
            outcome.warnings.length > 0
              ? {
                  title: `Switched to ${outcome.branch}, but not everything worked`,
                  detail: outcome.warnings.join("\n\n"),
                  command: "",
                }
              : null,
        });
      } catch (error) {
        if (superseded(started)) return false;
        set({
          opError: {
            title: `Could not switch to ${target.branch}`,
            detail: messageOf(error),
            command: "",
          },
        });
        return false;
      }
      await get().refreshAll();
      return true;
    },

    createBranch: (name, base) =>
      mutate(`Could not create ${name}`, () =>
        invokeCreateBranch(get().repoRoot ?? "", name, base),
      ),

    deleteBranch: (name, force) =>
      mutate(`Could not delete ${name}`, () =>
        invokeDeleteBranch(get().repoRoot ?? "", name, force),
      ),

    renameBranch: (from, to) =>
      mutate(`Could not rename ${from}`, () =>
        invokeRenameBranch(get().repoRoot ?? "", from, to),
      ),

    mergeBranch: async (reference) => {
      const started = get().generation;
      set({ opError: null, notice: null });
      let outcome;
      try {
        outcome = await mergeRef(get().repoRoot ?? "", reference);
      } catch (error) {
        if (superseded(started)) return false;
        set({
          opError: {
            title: `Could not merge ${reference}`,
            detail: messageOf(error),
            command: `git merge ${reference}`,
          },
        });
        return false;
      }
      if (superseded(started)) return false;
      // A conflict is not an error and gets no modal: the banner and the
      // Conflicts group are the whole point of this part, and a dialog on top of
      // them would only be in the way.
      set({
        notice: outcome.conflicted
          ? `Merge of ${reference} stopped on conflicts`
          : `Merged ${reference}`,
      });
      await get().refreshAll();
      return !outcome.conflicted;
    },

    concludeOp: (action) => {
      // The kind is only used to *describe* what happened, never to choose the
      // command — see the action's doc comment.
      const kind = get().mergeState?.kind ?? "none";
      return mutate(
        opFailureTitle(kind, action),
        () => invokeRunOp(get().repoRoot ?? "", action),
        opCommand(kind, action) ?? undefined,
      ).then((ok) => {
        if (ok) set({ notice: opSuccessNotice(kind, action) });
        return ok;
      });
    },

    resolveConflictPath: (path, resolution) =>
      mutate(`Could not resolve ${path}`, () =>
        invokeResolvePath(get().repoRoot ?? "", path, resolution),
      ),

    runOp: async (spec) => {
      if (get().op) return false; // the backend refuses this too; don't even ask
      const root = get().repoRoot;
      if (!root) return false;

      const started = get().generation;
      set({ opError: null, notice: null });
      // Captured from onStart so the progress handler can check the line belongs
      // to *this* op: after a cancel, the reader thread may still be draining a
      // pipe, and a late line must not be written into a newer op's progress.
      let opId: string | null = null;
      let running;
      try {
        running = await runRemoteOp({
          repoRoot: root,
          spec,
          // Recorded before the first listener exists, so an op that narrates
          // itself immediately has somewhere to put that first line.
          onStart: (id) => {
            opId = id;
            set({ op: { id, kind: spec.kind, progress: "" } });
          },
          onProgress: (line) => {
            const current = get().op;
            if (current && current.id === opId) {
              set({ op: { ...current, progress: line } });
            }
          },
        });
      } catch (error) {
        if (superseded(started)) return false;
        set({
          op: null,
          opError: {
            title: `Could not start ${spec.kind}`,
            detail: messageOf(error),
            command: remoteOpCommand(spec),
          },
        });
        return false;
      }

      const result = await running.result;
      // A network op outlives a project switch — nothing cancels it, and the user
      // is free to open another project while a pull runs. Its outcome must not be
      // reported against the repo they moved to: an `opError` there would offer
      // "Retry in terminal", and that terminal is now rooted in the *new* project,
      // so one click would run the old repo's command against it.
      if (superseded(started)) return false;
      set({ op: null });

      if (result.cancelled) {
        set({ notice: `${spec.kind} cancelled` });
      } else if (result.exitCode !== 0) {
        set({
          opError: {
            title: `${spec.kind} failed`,
            detail: result.output || `git ${spec.kind} exited with ${result.exitCode}`,
            command: remoteOpCommand(spec),
          },
        });
      }

      // Always refresh: a failed push may still have fetched refs, and a
      // cancelled fetch may have written some.
      await get().refreshAll();
      return !result.cancelled && result.exitCode === 0;
    },

    cancelOp: async () => {
      const op = get().op;
      if (!op) return;
      try {
        await cancelRemoteOp(op.id);
      } catch {
        // Nothing actionable: the op either already finished or the backend has
        // no record of it, and either way the terminal event settles `op`.
      }
    },

    dismissOpError: () => set({ opError: null }),
    dismissNotice: () => set({ notice: null }),
  };
});
