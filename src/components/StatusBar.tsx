import { useLayoutStore } from "../store/layoutStore";

// Thin bar spanning the bottom of the workspace. Its bottom-left cluster hosts
// the region toggles (terminal + Status panel), each prefixed with its Alt+<n>
// shortcut number; the right side is left free for later branch/git info.
export function StatusBar() {
  const bottomTerminalVisible = useLayoutStore((state) => state.bottomTerminalVisible);
  const toggleBottomTerminal = useLayoutStore((state) => state.toggleBottomTerminal);
  const statusPanelVisible = useLayoutStore((state) => state.statusPanelVisible);
  const toggleStatusPanel = useLayoutStore((state) => state.toggleStatusPanel);
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <button
          type="button"
          className="status-bar-toggle"
          aria-label="Toggle terminal"
          aria-pressed={bottomTerminalVisible}
          title="Toggle terminal (Alt+1)"
          onClick={toggleBottomTerminal}
        >
          <span className="status-bar-keyhint" aria-hidden="true">
            1
          </span>
          <span aria-hidden="true">{">_"}</span>
          <span>Terminal</span>
        </button>
        <button
          type="button"
          className="status-bar-toggle"
          aria-label="Toggle status panel"
          aria-pressed={statusPanelVisible}
          title="Toggle Status (Alt+2)"
          onClick={toggleStatusPanel}
        >
          <span className="status-bar-keyhint" aria-hidden="true">
            2
          </span>
          <span>Status</span>
        </button>
      </div>
    </div>
  );
}
