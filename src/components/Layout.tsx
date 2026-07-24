import { Group, Panel, Separator } from "react-resizable-panels";
import { MainPanel } from "./MainPanel";
import { TerminalPanel } from "./TerminalPanel";
import { StatusBar } from "./StatusBar";
import { useGlobalKeybindings } from "../hooks/useGlobalKeybindings";
import { useLayoutStore } from "../store/layoutStore";

// The workspace shell: a vertical resizable split (Claude Code on top, the
// shell terminal below) plus a status bar. The store is the single source of
// truth for terminal visibility — the close button, status-bar toggle and
// Ctrl+1 all flip the same flag, and the bottom Panel + Separator are simply
// not rendered while hidden. That keeps the terminal container off-DOM when
// collapsed (so FitAddon never measures a 0-height box), while the still-alive
// PTY re-attaches losslessly on reopen (see lib/ptySession).
export function Layout() {
  useGlobalKeybindings();
  const bottomTerminalVisible = useLayoutStore((state) => state.bottomTerminalVisible);
  const setBottomTerminalSize = useLayoutStore((state) => state.setBottomTerminalSize);

  // Non-reactive read: the stored size seeds `defaultSize` only when the
  // terminal Panel (re)mounts on show, so Layout must NOT re-render as the
  // size changes — a live-changing `defaultSize` would re-register the Panel
  // inside react-resizable-panels on every drag tick. We subscribe to
  // visibility (which drives the remount) and read the size imperatively; the
  // fresh render triggered by reopening picks up the latest stored value.
  const bottomTerminalSize = useLayoutStore.getState().bottomTerminalSize;

  return (
    <div className="workspace">
      <Group orientation="vertical" className="panel-group">
        {/* No defaultSize: the main region absorbs whatever the terminal leaves,
            so it stays the larger pane. */}
        <Panel id="main" className="panel" minSize="20%">
          <MainPanel />
        </Panel>
        {bottomTerminalVisible && <Separator className="separator" />}
        {bottomTerminalVisible && (
          <Panel
            id="terminal"
            className="panel"
            defaultSize={`${bottomTerminalSize}%`}
            minSize="10%"
            onResize={(size) => setBottomTerminalSize(Math.round(size.asPercentage))}
          >
            <TerminalPanel />
          </Panel>
        )}
      </Group>
      <StatusBar />
    </div>
  );
}
