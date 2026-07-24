import { TerminalView } from "./TerminalView";

/** Where Claude Code's install guide lives, shown if the binary isn't on PATH. */
export const CLAUDE_INSTALL_URL =
  "https://code.claude.com/docs/en/quickstart#step-1-install-claude-code";

// The dominant workspace region: Claude Code, run through the login shell.
// Header + body are direct flex children of the parent Panel's `.panel` box.
export function MainPanel() {
  return (
    <>
      <div className="panel-header">
        <span className="panel-header-title">Claude Code</span>
      </div>
      <div className="panel-body">
        <TerminalView
          sessionId="claude-main"
          cmd="claude"
          label="Claude Code"
          installHintUrl={CLAUDE_INSTALL_URL}
          autoFocus
        />
      </div>
    </>
  );
}
