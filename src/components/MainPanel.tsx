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
        {/*
          The one session whose program is known, which is what lets it opt out
          of standing the editing keys down on the alternate screen: Claude Code
          occupies that buffer from startup to exit, so respecting it here would
          disable word editing at the prompt this feature exists for. The shell
          terminal keeps the default, where the buffer really does mean vim.
        */}
        <TerminalView
          sessionId="claude-main"
          cmd="claude"
          label="Claude Code"
          installHintUrl={CLAUDE_INSTALL_URL}
          autoFocus
          respectAlternateScreen={false}
        />
      </div>
    </>
  );
}
