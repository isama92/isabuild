import { Group, Panel, Separator } from "react-resizable-panels";
import { MainPanel } from "./MainPanel";
import { TerminalPanel } from "./TerminalPanel";
import { StatusPanel } from "./StatusPanel";
import { StatusBar } from "./StatusBar";
import { useGlobalKeybindings } from "../hooks/useGlobalKeybindings";
import { useRepoWatch } from "../hooks/useRepoWatch";
import { useLayoutStore } from "../store/layoutStore";

// The workspace shell: a horizontal split with the working area on the left
// (Claude Code above the shell terminal, a nested vertical split) and the git
// Status panel on the right, over a status bar. The store is the single source
// of truth for region visibility — each close button, status-bar toggle and
// Alt+<n> flips the same flag, and a hidden region's Panel + Separator are
// simply not rendered. That keeps a collapsed terminal container off-DOM (so
// FitAddon never measures a 0-height box) while its still-alive PTY re-attaches
// losslessly on reopen (see lib/ptySession).
export function Layout() {
  useGlobalKeybindings();
  useRepoWatch();
  const bottomTerminalVisible = useLayoutStore((state) => state.bottomTerminalVisible);
  const setBottomTerminalSize = useLayoutStore((state) => state.setBottomTerminalSize);
  const statusPanelVisible = useLayoutStore((state) => state.statusPanelVisible);
  const setStatusPanelSize = useLayoutStore((state) => state.setStatusPanelSize);

  // Non-reactive reads: the stored sizes seed `defaultSize` only when a Panel
  // (re)mounts on show, so Layout must NOT re-render as a size changes — a
  // live-changing `defaultSize` would re-register the Panel inside
  // react-resizable-panels on every drag tick. We subscribe to visibility
  // (which drives the remount) and read the sizes imperatively; the fresh
  // render triggered by reopening picks up the latest stored value.
  const { bottomTerminalSize, statusPanelSize } = useLayoutStore.getState();

  return (
    <div className="workspace">
      <Group orientation="horizontal" className="panel-group">
        {/* No defaultSize: the working area absorbs whatever the Status panel
            leaves, so it stays the larger pane. */}
        <Panel id="workspace-left" className="panel" minSize="30%">
          <Group orientation="vertical" className="panel-group">
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
        </Panel>
        {statusPanelVisible && <Separator className="separator separator--col" />}
        {statusPanelVisible && (
          <Panel
            id="status"
            className="panel"
            defaultSize={`${statusPanelSize}%`}
            minSize="15%"
            onResize={(size) => setStatusPanelSize(Math.round(size.asPercentage))}
          >
            <StatusPanel />
          </Panel>
        )}
      </Group>
      <StatusBar />
    </div>
  );
}
