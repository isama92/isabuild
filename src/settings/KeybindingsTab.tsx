import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceleratorFromEvent,
  ACTIONS,
  conflictsWith,
  formatAccelerator,
  isBindable,
  labelFor,
  reservedBy,
  resolveBindings,
} from "../lib/keybindings";
import type { Settings } from "../lib/settings";

// The Keybindings tab: one row per action, click to record.
//
// Only *overrides* are stored, so an action left alone follows its default for
// ever, including if the default changes in a later release. Resetting a row
// deletes its entry rather than writing the current default in as a literal.

interface KeybindingsTabProps {
  settings: Settings;
  save: (patch: { keybindings: Record<string, string> }) => void;
}

/** What a row shows while it is being recorded. */
const RECORDING_HINT = "Press a combination, or Escape to cancel";

export function KeybindingsTab({ settings, save }: KeybindingsTabProps) {
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const bindings = resolveBindings(settings.keybindings);

  // Read by the key listener, which is registered once per recording session
  // and must not be re-registered as state around it changes.
  const latest = useRef({ bindings, settings, save });
  useEffect(() => {
    latest.current = { bindings, settings, save };
  });

  const stop = useCallback(() => {
    setRecording(null);
    setConflict(null);
  }, []);

  useEffect(() => {
    if (recording === null) return;

    function onKeyDown(event: KeyboardEvent) {
      // Capture phase and always swallowed: while recording, a keystroke is
      // input to this control and nothing else. Otherwise recording Escape
      // would close the window it is being recorded in.
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        stop();
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      // A modifier on its own: the user is still reaching for the key.
      if (accelerator === null) return;

      const { bindings: current, settings: now, save: persist } = latest.current;
      const text = formatAccelerator(accelerator);

      // A bare key would be swallowed before the terminal or the editor could
      // type it. Rejected here rather than in `resolveBindings`, so a hand-
      // edited config stays as trusted as it is everywhere else.
      if (!isBindable(accelerator)) {
        setConflict(`${text} needs Ctrl, Alt or Cmd, or the terminal could not type it.`);
        return;
      }

      const reserved = reservedBy(recording!, accelerator);
      if (reserved !== null) {
        setConflict(`${text} is already taken by ${reserved}. Pick another.`);
        return;
      }

      const clashes = conflictsWith(current, recording!, accelerator);
      if (clashes.length > 0) {
        setConflict(`${text} is already ${labelFor(clashes[0])}. Pick another.`);
        return;
      }

      persist({
        keybindings: { ...now.keybindings, [recording!]: text },
      });
      stop();
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, stop]);

  function reset(actionId: string) {
    // Delete the entry rather than writing the default in: an action with no
    // override keeps following the default even if a later release changes it.
    const next = { ...settings.keybindings };
    delete next[actionId];
    save({ keybindings: next });
  }

  function unbind(actionId: string) {
    save({ keybindings: { ...settings.keybindings, [actionId]: "" } });
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Keybindings</h2>
      <p className="settings-hint">
        Menu shortcuts and Ctrl/Cmd+W are fixed: they are conventions rather than preferences.
      </p>

      {conflict !== null && (
        <p className="settings-error" role="alert">
          {conflict}
        </p>
      )}

      <table className="keybindings">
        <tbody>
          {ACTIONS.map((action) => {
            const bound = bindings[action.id];
            const overridden = settings.keybindings[action.id] !== undefined;
            const isRecording = recording === action.id;
            return (
              <tr key={action.id}>
                <th scope="row" className="keybindings-label">
                  {action.label}
                  <span className="keybindings-scope">{action.scopes.join(", ")}</span>
                </th>
                <td className="keybindings-key">
                  <button
                    type="button"
                    className={`keybindings-record${isRecording ? " keybindings-record--live" : ""}`}
                    aria-label={`Change the shortcut for ${action.label}`}
                    onClick={() => {
                      setConflict(null);
                      setRecording(isRecording ? null : action.id);
                    }}
                  >
                    {isRecording
                      ? RECORDING_HINT
                      : bound === null
                        ? "Not bound"
                        : formatAccelerator(bound)}
                  </button>
                </td>
                <td className="keybindings-actions">
                  <button
                    type="button"
                    className="keybindings-link"
                    disabled={bound === null}
                    onClick={() => unbind(action.id)}
                  >
                    Unbind
                  </button>
                  <button
                    type="button"
                    className="keybindings-link"
                    disabled={!overridden}
                    onClick={() => reset(action.id)}
                  >
                    Reset
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
