import { useEffect, useRef, useState } from "react";
import { attach, restart, type PtyExitInfo } from "../lib/ptySession";

interface TerminalViewProps {
  sessionId: string;
  /** Command run through the platform shell; omit for a plain shell. */
  cmd?: string;
  /** Human label used in the exit/error overlay; defaults to "Claude Code". */
  label?: string;
  /**
   * When set, an exit code of 127 renders install guidance linking here
   * (the command was not on PATH). Omit for a plain shell, which has nothing
   * to install.
   */
  installHintUrl?: string;
  /** Focus the terminal once it is attached. */
  autoFocus?: boolean;
}

type Overlay =
  | { kind: "exit"; exitCode: number }
  | { kind: "error"; message: string }
  | null;

const NOT_FOUND_EXIT_CODE = 127;

export function TerminalView({
  sessionId,
  cmd,
  label = "Claude Code",
  installHintUrl,
  autoFocus,
}: TerminalViewProps) {
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
      autoFocus,
      onExit: (info: PtyExitInfo) => setOverlay({ kind: "exit", exitCode: info.exitCode }),
      onError: (error: unknown) =>
        setOverlay({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
    });
    return () => handle.detach();
  }, [sessionId, cmd, autoFocus]);

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

  // Unique per session so two terminals' overlays never share an id.
  const titleId = `overlay-title-${sessionId}`;
  const showInstallHint =
    overlay?.kind === "exit" &&
    overlay.exitCode === NOT_FOUND_EXIT_CODE &&
    installHintUrl !== undefined;

  return (
    <div className="terminal-view">
      <div ref={containerRef} className="terminal-container" />
      {overlay && (
        <div className="terminal-overlay" role="alertdialog" aria-labelledby={titleId}>
          {showInstallHint ? (
            <>
              <h2 id={titleId}>{label} was not found on your PATH</h2>
              <p>
                Install it following the{" "}
                <a href={installHintUrl} target="_blank" rel="noreferrer">
                  installation guide
                </a>
                , then restart the session.
              </p>
            </>
          ) : overlay.kind === "exit" ? (
            <h2 id={titleId}>
              {overlay.exitCode === 0
                ? "Session ended"
                : `${label} exited (code ${overlay.exitCode})`}
            </h2>
          ) : (
            <>
              <h2 id={titleId}>Failed to start session</h2>
              <p>{overlay.message}</p>
            </>
          )}
          <button ref={restartButtonRef} type="button" onClick={() => void handleRestart()}>
            Restart {label}
          </button>
        </div>
      )}
    </div>
  );
}
