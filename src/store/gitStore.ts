// Git working-tree status for the active repository. The store holds the data
// and a single `refresh` action; hooks/useRepoWatch drives when it runs (once
// on mount, then on every `repo://changed`). Mirrors layoutStore's
// initial-state-export pattern so tests reset via a merge setState.

import { create } from "zustand";
import { getStatus, type FileEntry } from "../lib/gitStatus";

export type GitStatusPhase = "idle" | "loading" | "ready" | "error";

export interface GitState {
  /** Resolved repository root, or null before the first successful fetch. */
  repoRoot: string | null;
  staged: FileEntry[];
  unstaged: FileEntry[];
  phase: GitStatusPhase;
  error: string | null;
  /**
   * Fetch status. The first call resolves the repo from the app's launch
   * directory; later calls reuse the resolved root. Never throws — a failure
   * (e.g. not a git repository) lands in `phase: "error"` + `error`.
   */
  refresh: () => Promise<void>;
}

/** Data fields only (no actions), so tests can reset via a merge setState. */
export const initialGitState = {
  repoRoot: null as string | null,
  staged: [] as FileEntry[],
  unstaged: [] as FileEntry[],
  phase: "idle" as GitStatusPhase,
  error: null as string | null,
};

export const useGitStore = create<GitState>((set, get) => ({
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
      set({
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));
