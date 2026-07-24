import { useCallback, useEffect, useRef } from "react";
import { TerminalView } from "./TerminalView";
import { writeText } from "../lib/ptySession";
import { useLayoutStore } from "../store/layoutStore";

// The collapsible bottom region: the user's plain login shell (no `cmd`), so
// they can work in a terminal alongside Claude Code. The header's close button
// hides the region; the status-bar toggle and Ctrl+1 bring it back.
//
// It is also where "Retry in terminal" (Part 5) lands. The command is queued in
// the layout store rather than written directly, because the region may be
// closed — and therefore this component unmounted, with no PTY attached — at the
// moment the user asks.
//
// Two triggers are needed, and only having the first was a bug: `onReady` covers
// "the command was queued while the region was shut", and the effect on
// `pendingShellCommand` covers "the region was already open and attached", where
// nothing re-attaches and so `onReady` never fires again.
const SESSION_ID = "shell-main";

export function TerminalPanel() {
  const setBottomTerminalVisible = useLayoutStore((state) => state.setBottomTerminalVisible);
  // False on the startup mount (Claude Code keeps focus); true once the user
  // has opened the terminal, so a reopen focuses it. See layoutStore.
  const autoFocus = useLayoutStore((state) => state.bottomTerminalAutoFocus);
  const pendingShellCommand = useLayoutStore((state) => state.pendingShellCommand);
  // Writing before the PTY exists would just fail, so the effect waits for this.
  const ready = useRef(false);

  const consumePending = useCallback(() => {
    // Read imperatively so the value is never stale relative to the store.
    const { pendingShellCommand: command, clearPendingShellCommand } = useLayoutStore.getState();
    if (!command) return;
    // Cleared first, so a write failure still consumes the request and a stale
    // command cannot surprise the user on some later reopen.
    clearPendingShellCommand();
    // No trailing newline: the user reviews the command and presses Enter
    // themselves. An escape hatch should not execute by surprise.
    void writeText(SESSION_ID, command).catch(() => {
      /* nothing to report beyond the text not arriving */
    });
  }, []);

  const handleReady = useCallback(() => {
    ready.current = true;
    consumePending();
  }, [consumePending]);

  useEffect(() => {
    // Queued while this session was already live: nothing will re-attach, so
    // this is the only thing that will deliver it.
    if (ready.current && pendingShellCommand) consumePending();
  }, [pendingShellCommand, consumePending]);

  return (
    <>
      <div className="panel-header">
        <span className="panel-header-title">Terminal</span>
        <button
          type="button"
          className="panel-close"
          aria-label="Close terminal"
          title="Close terminal (Alt+1)"
          onClick={() => setBottomTerminalVisible(false)}
        >
          {"×"}
        </button>
      </div>
      <div className="panel-body">
        {/* When the shell exits, close the region rather than showing a
            restart overlay — same outcome as the close button. */}
        <TerminalView
          sessionId={SESSION_ID}
          label="Terminal"
          autoFocus={autoFocus}
          onExit={() => setBottomTerminalVisible(false)}
          onReady={handleReady}
        />
      </div>
    </>
  );
}
