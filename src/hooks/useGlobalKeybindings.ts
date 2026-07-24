import { useEffect } from "react";
import { useLayoutStore } from "../store/layoutStore";

// Global keyboard shortcuts, registered once at the layout root.
//
// Numeric scheme: Alt+<n> toggles a workspace region. Alt+1 toggles the bottom
// terminal, Alt+2 the right-side Status panel; later parts add Alt+3, ... by
// extending the `actions` map with more physical-key codes.
//
// The listener runs in the CAPTURE phase and stops propagation so the
// keystroke never reaches xterm's textarea handler. A bubble-phase listener
// would fire after xterm had already forwarded the key to the PTY, so Alt+1
// would both toggle the panel and write a stray escape sequence into the shell.
export function useGlobalKeybindings(): void {
  const toggleBottomTerminal = useLayoutStore((state) => state.toggleBottomTerminal);
  const toggleStatusPanel = useLayoutStore((state) => state.toggleStatusPanel);

  useEffect(() => {
    // Keyed by KeyboardEvent.code (physical key, layout-independent).
    const actions: Record<string, () => void> = {
      Digit1: toggleBottomTerminal,
      Digit2: toggleStatusPanel,
    };

    function onKeyDown(event: KeyboardEvent) {
      // Exactly Alt (no Ctrl/Meta/Shift) so we don't shadow OS or app combos.
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const action = actions[event.code];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [toggleBottomTerminal, toggleStatusPanel]);
}
