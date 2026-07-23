import { useEffect, useRef, useState } from "react";
import { attach, restart, type PtyExitInfo } from "../lib/ptySession";

interface TerminalViewProps {
  sessionId: string;
  /** Command run through the platform shell; omit for a plain shell. */
  cmd?: string;
}

type Overlay =
  | { kind: "exit"; exitCode: number }
  | { kind: "error"; message: string }
  | null;

const NOT_FOUND_EXIT_CODE = 127;

export function TerminalView({ sessionId, cmd }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const restartButtonRef = useRef<HTMLButtonElement>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);

  useEffect(() => {
    if (overlay) restartButtonRef.current?.focus();
  }, [overlay]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handle = attach(container, {
      id: sessionId,
      cmd,
      onExit: (info: PtyExitInfo) => setOverlay({ kind: "exit", exitCode: info.exitCode }),
      onError: (error: unknown) =>
        setOverlay({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
    });
    return () => handle.detach();
  }, [sessionId, cmd]);

  async function handleRestart() {
    setOverlay(null);
    try {
      await restart(sessionId, cmd);
    } catch (error) {
      setOverlay({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div className="terminal-view">
      <div ref={containerRef} className="terminal-container" />
      {overlay && (
        <div className="terminal-overlay" role="alertdialog" aria-labelledby="overlay-title">
          {overlay.kind === "exit" && overlay.exitCode === NOT_FOUND_EXIT_CODE ? (
            <>
              <h2 id="overlay-title">Claude Code was not found on your PATH</h2>
              <p>Install it, then restart the session:</p>
              <pre>npm install -g @anthropic-ai/claude-code</pre>
              <p>
                Setup guide:{" "}
                <a
                  href="https://docs.claude.com/en/docs/claude-code"
                  target="_blank"
                  rel="noreferrer"
                >
                  docs.claude.com/en/docs/claude-code
                </a>
              </p>
            </>
          ) : overlay.kind === "exit" ? (
            <h2 id="overlay-title">
              {overlay.exitCode === 0
                ? "Session ended"
                : `Claude Code exited (code ${overlay.exitCode})`}
            </h2>
          ) : (
            <>
              <h2 id="overlay-title">Failed to start session</h2>
              <p>{overlay.message}</p>
            </>
          )}
          <button ref={restartButtonRef} type="button" onClick={() => void handleRestart()}>
            Restart Claude Code
          </button>
        </div>
      )}
    </div>
  );
}
