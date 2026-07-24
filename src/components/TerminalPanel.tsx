import { TerminalView } from "./TerminalView";
import { useLayoutStore } from "../store/layoutStore";

// The collapsible bottom region: the user's plain login shell (no `cmd`), so
// they can work in a terminal alongside Claude Code. The header's close button
// hides the region; the status-bar toggle and Ctrl+1 bring it back.
export function TerminalPanel() {
  const setBottomTerminalVisible = useLayoutStore((state) => state.setBottomTerminalVisible);
  // False on the startup mount (Claude Code keeps focus); true once the user
  // has opened the terminal, so a reopen focuses it. See layoutStore.
  const autoFocus = useLayoutStore((state) => state.bottomTerminalAutoFocus);
  return (
    <>
      <div className="panel-header">
        <span className="panel-header-title">Terminal</span>
        <button
          type="button"
          className="panel-close"
          aria-label="Close terminal"
          title="Close terminal (Ctrl+1)"
          onClick={() => setBottomTerminalVisible(false)}
        >
          {"×"}
        </button>
      </div>
      <div className="panel-body">
        <TerminalView sessionId="shell-main" label="Terminal" autoFocus={autoFocus} />
      </div>
    </>
  );
}
