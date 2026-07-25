import { useEffect } from "react";
import { Layout } from "./components/Layout";
import { Modal } from "./components/Modal";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { useAppearance } from "./hooks/useAppearance";
import { useMenuEvents, type PendingMenuAction } from "./hooks/useMenuEvents";
import { useProjectStore } from "./store/projectStore";
import "./App.css";

// The main window's root. Since Part 8 it chooses between two whole screens:
// the welcome screen when no project is open, and the workspace when one is.
//
// Layout is keyed on the repo root so switching projects tears the workspace
// down and rebuilds it, rather than reusing panels still pointing at the old
// repo. The PTYs themselves are killed backend-side by `project_open` /
// `project_close` *before* either resolves, so the fresh Layout attaches to
// terminals that no longer exist and spawns new ones in the new directory. That
// ordering is what keeps CLAUDE.md's "unmount never kills a PTY" rule intact:
// the kill is an explicit command, not a React cleanup.

/** What the confirmation says, per action. */
function confirmCopy(action: PendingMenuAction): { title: string; body: string; action: string } {
  const consequence =
    "Claude Code and the terminal will stop, and any conversation in progress ends.";
  switch (action.kind) {
    case "close-project":
      return {
        title: "Close project?",
        body: `Closing returns you to the start screen. ${consequence}`,
        action: "Close project",
      };
    case "open-folder":
      return {
        title: "Open another project?",
        body: `Opening another project closes this one. ${consequence}`,
        action: "Choose a folder…",
      };
    case "open-recent":
      return {
        title: "Open another project?",
        body: `Opening ${action.path} closes the current project. ${consequence}`,
        action: "Open project",
      };
  }
}

function App() {
  const phase = useProjectStore((state) => state.phase);
  const project = useProjectStore((state) => state.project);
  const error = useProjectStore((state) => state.error);
  const dismissError = useProjectStore((state) => state.dismissError);
  const { pending, confirm, cancel } = useMenuEvents();
  // No initial read here: `start()` below adopts the settings that arrive with
  // the bootstrap payload, so the appearance is right on the first paint.
  useAppearance();

  useEffect(() => {
    void useProjectStore.getState().start();
  }, []);

  // Neither screen until we know which is right: rendering the welcome screen
  // for one frame and then replacing it would flash on every launch.
  if (phase === "loading") {
    return <div className="app-loading" role="status" aria-label="Starting isabuild" />;
  }

  const copy = pending === null ? null : confirmCopy(pending);

  return (
    <>
      {project === null ? <WelcomeScreen /> : <Layout key={project.repoRoot} />}
      {/* The welcome screen renders `error` itself, in place. With a project
          open there is no welcome screen, and every failure a menu action can
          produce (a picker that would not open, a recent project since
          deleted, a close the backend refused) would otherwise be a click that
          silently did nothing. */}
      {project !== null && error !== null && (
        <div className="app-error" role="alert">
          <span>{error}</span>
          <button type="button" className="app-error-dismiss" onClick={dismissError}>
            Dismiss
          </button>
        </div>
      )}
      {copy !== null && (
        <Modal
          title={copy.title}
          onClose={cancel}
          actions={
            <>
              <button type="button" className="modal-button" onClick={cancel}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-button modal-button--primary"
                onClick={confirm}
              >
                {copy.action}
              </button>
            </>
          }
        >
          <p>{copy.body}</p>
        </Modal>
      )}
    </>
  );
}

export default App;
