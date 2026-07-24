import { useLayoutStore } from "../store/layoutStore";

// Thin bar spanning the bottom of the workspace. For now it hosts only the
// terminal toggle (bottom-right, like an IDE status bar); later parts add
// branch and git status here.
export function StatusBar() {
  const bottomTerminalVisible = useLayoutStore((state) => state.bottomTerminalVisible);
  const toggleBottomTerminal = useLayoutStore((state) => state.toggleBottomTerminal);
  return (
    <div className="status-bar">
      <button
        type="button"
        className="status-bar-toggle"
        aria-label="Toggle terminal"
        aria-pressed={bottomTerminalVisible}
        title="Toggle terminal (Alt+1)"
        onClick={toggleBottomTerminal}
      >
        <span aria-hidden="true">{">_"}</span>
        <span>Terminal</span>
      </button>
    </div>
  );
}
