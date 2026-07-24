import { useEffect } from "react";
import { useLayoutStore } from "../store/layoutStore";

// Global keyboard shortcuts, registered once at the layout root.
//
// Numeric scheme: Alt+<n> toggles a workspace region. Part 2 wires only
// Alt+1 (the bottom terminal); later parts add Alt+2, Alt+3, ... by
// extending the `actions` map with more physical-key codes.
//
// The listener runs in the CAPTURE phase and stops propagation so the
// keystroke never reaches xterm's textarea handler. A bubble-phase listener
// would fire after xterm had already forwarded the key to the PTY, so Alt+1
// would both toggle the panel and write a stray escape sequence into the shell.
export function useGlobalKeybindings(): void {
  const toggleBottomTerminal = useLayoutStore((state) => state.toggleBottomTerminal);

  useEffect(() => {
    // Keyed by KeyboardEvent.code (physical key, layout-independent).
    const actions: Record<string, () => void> = {
      Digit1: toggleBottomTerminal,
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
  }, [toggleBottomTerminal]);
}
