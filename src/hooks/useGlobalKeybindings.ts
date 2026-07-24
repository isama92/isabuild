import { useEffect } from "react";
import { useLayoutStore } from "../store/layoutStore";

// Global keyboard shortcuts, registered once at the layout root.
//
// Numeric scheme: Ctrl+<n> toggles a workspace region. Part 2 wires only
// Ctrl+1 (the bottom terminal); later parts add Ctrl+2, Ctrl+3, ... by
// extending the `actions` map with more physical-key codes.
//
// The listener runs in the CAPTURE phase and stops propagation so the
// keystroke never reaches xterm's textarea handler. A bubble-phase listener
// would fire after xterm had already forwarded the key to the PTY, so Ctrl+1
// would both toggle the panel and write a stray control byte into the shell.
export function useGlobalKeybindings(): void {
  const toggleBottomTerminal = useLayoutStore((state) => state.toggleBottomTerminal);

  useEffect(() => {
    // Keyed by KeyboardEvent.code (physical key, layout-independent).
    const actions: Record<string, () => void> = {
      Digit1: toggleBottomTerminal,
    };

    function onKeyDown(event: KeyboardEvent) {
      // Exactly Ctrl (no Meta/Alt/Shift) so we don't shadow OS or app combos.
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
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
