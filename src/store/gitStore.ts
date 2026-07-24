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

import { create } from "zustand";
import { getStatus, type FileEntry } from "../lib/gitStatus";
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

export type GitStatusPhase = "idle" | "loading" | "ready" | "error";

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
  phase: GitStatusPhase;
  error: string | null;
  /** Branch/upstream/ahead-behind, or null before the first successful read. */
  branch: BranchState | null;
  op: RunningOp | null;
  opError: OpError | null;
  /** Transient one-liner, e.g. "3 changes stashed from main". */
  notice: string | null;

  /**
   * Fetch status. The first call resolves the repo from the app's launch
   * directory; later calls reuse the resolved root. Never throws — a failure
   * (e.g. not a git repository) lands in `phase: "error"` + `error`.
   */
  refresh: () => Promise<void>;
  /** Fetch branch state. Never throws; a failure leaves the last known state. */
  refreshBranch: () => Promise<void>;
  /** Both reads, skipped while an operation is running. */
  refreshAll: () => Promise<void>;

  switchTo: (target: SwitchTarget, policy: DirtyPolicy) => Promise<boolean>;
  createBranch: (name: string, base?: string) => Promise<boolean>;
  deleteBranch: (name: string, force: boolean) => Promise<boolean>;
  renameBranch: (from: string, to: string) => Promise<boolean>;

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
  phase: "idle" as GitStatusPhase,
  error: null as string | null,
  branch: null as BranchState | null,
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
   */
  async function mutate(
    title: string,
    action: () => Promise<void>,
  ): Promise<boolean> {
    set({ opError: null });
    try {
      await action();
    } catch (error) {
      set({ opError: { title, detail: messageOf(error), command: "" } });
      return false;
    }
    await get().refreshAll();
    return true;
  }

  return {
    ...initialGitState,

    refresh: async () => {
      set({ phase: "loading" });
      try {
        const status = await getStatus(get().repoRoot ?? undefined);
        set({
          repoRoot: status.repoRoot,
          staged: status.staged,
          unstaged: status.unstaged,
          phase: "ready",
          error: null,
        });
      } catch (error) {
        set({ phase: "error", error: messageOf(error) });
      }
    },

    refreshBranch: async () => {
      const root = get().repoRoot;
      if (!root) return; // status resolves the root first
      try {
        set({ branch: await getBranchState(root) });
      } catch {
        // Keep the last known branch state: the status panel's own error
        // reporting already covers "this is not a repository", and blanking the
        // status bar on a transient read failure only loses information.
      }
    },

    refreshAll: async () => {
      // See the module note: an op is writing inside .git and re-firing the
      // watcher; reading mid-flight is wasted work. runOp refreshes at the end.
      if (get().op) return;
      await get().refresh();
      await get().refreshBranch();
    },

    switchTo: async (target, policy) => {
      set({ opError: null, notice: null });
      try {
        const outcome = await switchBranch(get().repoRoot ?? "", target, policy);
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

    runOp: async (spec) => {
      if (get().op) return false; // the backend refuses this too; don't even ask
      const root = get().repoRoot;
      if (!root) return false;

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
