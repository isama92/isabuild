import { useEffect } from "react";
import { actionFor, resolveBindings, type Scope } from "../lib/keybindings";
import { useGitStore } from "../store/gitStore";
import { useLayoutStore } from "../store/layoutStore";
import { useSettingsStore } from "../store/settingsStore";

// Global keyboard shortcuts for the workspace, registered once at the layout
// root. Since Part 8 the accelerators come from the settings rather than being
// hardcoded; the action *ids* and what they do live here, the combinations in
// `lib/keybindings` and `config.json`.
//
// The listener runs in the CAPTURE phase and stops propagation so the keystroke
// never reaches xterm's textarea handler. A bubble-phase listener would fire
// after xterm had already forwarded the key to the PTY, so Alt+1 would both
// toggle the panel and write a stray escape sequence into the shell.
//
// Only a keystroke that actually resolves to an action is swallowed. Everything
// else falls through untouched, which is what keeps the terminal usable.
//
// Nothing fires while a modal is open. `Modal` claims only Escape and Tab, and
// this hook registers at Layout mount so it is earlier in the capture order
// than any dialog opened later — without the check, Alt+5 would start a push
// behind the "Close project?" confirmation.

const SCOPE: Scope = "workspace";

export function useGlobalKeybindings(): void {
  // The whole map, not individual accelerators: a rebind changes one entry and
  // the effect below has to re-register with the new one either way.
  const overrides = useSettingsStore((state) => state.settings?.keybindings);

  useEffect(() => {
    const bindings = resolveBindings(overrides ?? {});
    const layout = useLayoutStore.getState;

    // Read imperatively: these are stable store actions, and depending on them
    // would re-register the listener on every unrelated store change.
    const run: Record<string, () => void> = {
      "toggle-terminal": () => layout().toggleBottomTerminal(),
      "toggle-status-panel": () => layout().toggleStatusPanel(),
      "git-fetch": () => layout().requestGitAction("fetch"),
      "git-pull": () => layout().requestGitAction("pull"),
      "git-push": () => layout().requestGitAction("push"),
      // Guarded like the button it stands in for: the branch control is
      // disabled while a network operation runs, and a keystroke must not
      // reach past a control the UI has taken away.
      "branch-menu": () => {
        if (useGitStore.getState().op === null) layout().toggleBranchMenu();
      },
    };

    function onKeyDown(event: KeyboardEvent) {
      // Something else has already claimed it: a modal's Escape, a menu's
      // arrow keys. Acting anyway would fire two things at once.
      if (event.defaultPrevented) return;
      // A dialog is up and owns the keyboard. Queried rather than tracked in
      // the store: `Modal` is the only thing that renders one, and its ARIA
      // role is already the contract that says so.
      if (document.querySelector('[role="dialog"]') !== null) return;
      const action = actionFor(bindings, SCOPE, event);
      if (action === null) return;
      const handler = run[action];
      if (handler === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [overrides]);
}
