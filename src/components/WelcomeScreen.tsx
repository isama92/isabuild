import { useProjectStore } from "../store/projectStore";
import type { RecentProject } from "../lib/settings";

// What the main window shows when no project is open: on first launch, after
// Close Project, and whenever the remembered project could not be reopened.
//
// It is a *view*, not a window. The workspace Layout is simply not mounted while
// this is on screen, which is what keeps the two PTYs from being spawned into a
// directory nobody has chosen (`pty_spawn` refuses without an open project).
//
// A missing folder is shown dimmed and marked rather than dropped: a project on
// an unmounted drive or a renamed checkout is information, and silently
// shortening the list looks like the app forgot.

interface RecentRowProps {
  recent: RecentProject;
  disabled: boolean;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}

/**
 * Why a row cannot be opened, in the words the user needs, or null when it can.
 * The two failures are distinct because the fix is: one folder has gone, the
 * other is still there but is no longer part of a repository.
 */
function problemWith(recent: RecentProject): string | null {
  switch (recent.state) {
    case "ok":
      return null;
    case "missing":
      return "missing";
    case "notARepo":
      return "not a repository";
  }
}

function RecentRow({ recent, disabled, onOpen, onRemove }: RecentRowProps) {
  const problem = problemWith(recent);
  return (
    <li className={`welcome-recent${problem === null ? "" : " welcome-recent--broken"}`}>
      <button
        type="button"
        className="welcome-recent-open"
        disabled={disabled}
        onClick={() => onOpen(recent.path)}
      >
        <span className="welcome-recent-name">
          {recent.name}
          {problem !== null && <span className="welcome-recent-tag"> {problem}</span>}
        </span>
        <span className="welcome-recent-path">{recent.path}</span>
      </button>
      <button
        type="button"
        className="welcome-recent-remove"
        // The path, not the name: two projects can share a name, and the label
        // is what a screen reader reads out on its own.
        aria-label={`Remove ${recent.path} from recent projects`}
        title="Remove from recent projects"
        disabled={disabled}
        onClick={() => onRemove(recent.path)}
      >
        ×
      </button>
    </li>
  );
}

export function WelcomeScreen() {
  const recents = useProjectStore((state) => state.recents);
  const launchFolder = useProjectStore((state) => state.launchFolder);
  const error = useProjectStore((state) => state.error);
  const notice = useProjectStore((state) => state.notice);
  const busy = useProjectStore((state) => state.busy);
  const open = useProjectStore((state) => state.open);
  const openWithPicker = useProjectStore((state) => state.openWithPicker);
  const removeRecent = useProjectStore((state) => state.removeRecent);
  const dismissError = useProjectStore((state) => state.dismissError);
  const dismissNotice = useProjectStore((state) => state.dismissNotice);

  // Only worth offering when it is not already the top of the list.
  const showLaunchFolder =
    launchFolder !== null && !recents.some((recent) => recent.path === launchFolder.path);

  return (
    <div className="welcome">
      <div className="welcome-panel">
        <h1 className="welcome-title">isabuild</h1>
        <p className="welcome-subtitle">Open a git repository to start working in it.</p>

        {error !== null && (
          <div className="welcome-error" role="alert">
            <span>{error}</span>
            <button type="button" className="welcome-dismiss" onClick={dismissError}>
              Dismiss
            </button>
          </div>
        )}

        {notice !== null && (
          <div className="welcome-notice" role="status">
            <span>{notice}</span>
            <button type="button" className="welcome-dismiss" onClick={dismissNotice}>
              Dismiss
            </button>
          </div>
        )}

        <button
          type="button"
          className="welcome-open"
          disabled={busy}
          onClick={() => void openWithPicker()}
        >
          Open folder…
        </button>

        {showLaunchFolder && (
          <button
            type="button"
            className="welcome-launch-folder"
            disabled={busy}
            onClick={() => void open(launchFolder.path)}
          >
            Open the current folder: <span className="welcome-recent-path">{launchFolder.path}</span>
          </button>
        )}

        <h2 className="welcome-section">Recent projects</h2>
        {recents.length === 0 ? (
          <p className="welcome-empty">No recent projects yet.</p>
        ) : (
          <ul className="welcome-recents">
            {recents.map((recent) => (
              <RecentRow
                key={recent.path}
                recent={recent}
                disabled={busy}
                onOpen={(path) => void open(path)}
                onRemove={(path) => void removeRecent(path)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
