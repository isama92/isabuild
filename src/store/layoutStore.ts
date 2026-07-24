// Workspace layout state. Zustand is the single source of truth for which
// regions are visible; the close buttons, status-bar toggles and Alt+<n> all
// funnel through the same actions here. PTY state lives in the backend and in
// `lib/ptySession`, git state in `store/gitStore`, never here — this store only
// decides what is rendered.

import { create } from "zustand";

export interface LayoutState {
  /** Whether the bottom shell-terminal region is shown. Starts open. */
  bottomTerminalVisible: boolean;
  /**
   * Last bottom-terminal height as a percentage (0..100) of the workspace,
   * remembered so reopening restores the size the user dragged to. In-memory
   * only; cross-restart persistence is a later part.
   */
  bottomTerminalSize: number;
  /**
   * Whether the terminal should grab focus the next time it mounts. False at
   * startup so Claude Code (the dominant region) keeps focus even though the
   * terminal is also visible; flipped true once the user opens the terminal,
   * so a user-driven reopen focuses it.
   */
  bottomTerminalAutoFocus: boolean;
  /** Whether the right-side Status (git) panel is shown. Starts open. */
  statusPanelVisible: boolean;
  /**
   * Last Status-panel width as a percentage (0..100) of the workspace,
   * remembered across reopens. In-memory only, like `bottomTerminalSize`.
   */
  statusPanelSize: number;
  /**
   * A command queued for the bottom shell ("Retry in terminal", Part 5). The
   * terminal region may not even be mounted when it is queued, so TerminalPanel
   * consumes it once its PTY is attached rather than the caller writing
   * directly. Only what is *rendered* lives here; the write itself is
   * `lib/ptySession`'s job.
   */
  pendingShellCommand: string | null;
  toggleBottomTerminal: () => void;
  setBottomTerminalVisible: (visible: boolean) => void;
  setBottomTerminalSize: (size: number) => void;
  toggleStatusPanel: () => void;
  setStatusPanelVisible: (visible: boolean) => void;
  setStatusPanelSize: (size: number) => void;
  /** Reveal and focus the bottom terminal, and queue `command` for it. */
  requestShellCommand: (command: string) => void;
  clearPendingShellCommand: () => void;
}

/** Data fields only (no actions), so tests can reset via a merge setState. */
export const initialLayoutState = {
  bottomTerminalVisible: true,
  bottomTerminalSize: 30,
  bottomTerminalAutoFocus: false,
  statusPanelVisible: true,
  statusPanelSize: 22,
  pendingShellCommand: null as string | null,
};

export const useLayoutStore = create<LayoutState>((set) => ({
  ...initialLayoutState,
  toggleBottomTerminal: () =>
    set((state) => {
      const bottomTerminalVisible = !state.bottomTerminalVisible;
      return {
        bottomTerminalVisible,
        // Focus on user-driven opens only; never reset once earned.
        bottomTerminalAutoFocus: state.bottomTerminalAutoFocus || bottomTerminalVisible,
      };
    }),
  setBottomTerminalVisible: (visible) =>
    set((state) => ({
      bottomTerminalVisible: visible,
      bottomTerminalAutoFocus: state.bottomTerminalAutoFocus || visible,
    })),
  setBottomTerminalSize: (size) => set({ bottomTerminalSize: size }),
  toggleStatusPanel: () => set((state) => ({ statusPanelVisible: !state.statusPanelVisible })),
  setStatusPanelVisible: (visible) => set({ statusPanelVisible: visible }),
  setStatusPanelSize: (size) => set({ statusPanelSize: size }),
  requestShellCommand: (command) =>
    set({
      pendingShellCommand: command,
      bottomTerminalVisible: true,
      // An explicit request to run something there: focus is the point.
      bottomTerminalAutoFocus: true,
    }),
  clearPendingShellCommand: () => set({ pendingShellCommand: null }),
}));
