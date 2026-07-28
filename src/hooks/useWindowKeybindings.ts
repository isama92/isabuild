import { useEffect, useRef } from "react";
import { actionFor, resolveBindings, type Scope } from "../lib/keybindings";
import { useSettingsStore } from "../store/settingsStore";

// Keyboard shortcuts for a secondary window (diff or merge).
//
// The counterpart of `useGlobalKeybindings`, split from it for two reasons: the
// scope differs, and so does the phase. The workspace listens in the capture
// phase because xterm would otherwise forward the key to a PTY before we saw
// it. A diff or merge window has CodeMirror panes instead, which consume the keys
// they have a use for and mark them handled — Escape closes the find panel, most
// visibly. Listening in the bubble phase, and skipping anything already handled,
// is what lets Escape mean "dismiss the widget" first and "close the window" only
// when there was no widget.
//
// Ctrl/Cmd+W is not routed through here: see the note in `lib/keybindings`.

export type WindowAction =
  | "close-window"
  | "next-change"
  | "previous-change"
  | "next-conflict"
  | "previous-conflict";

export function useWindowKeybindings(
  scope: Scope,
  handlers: Partial<Record<WindowAction, () => void>>,
): void {
  const overrides = useSettingsStore((state) => state.settings?.keybindings);

  // Held in a ref so a caller passing a fresh object literal each render (the
  // normal way to call this) does not re-register the listener every time.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const bindings = resolveBindings(overrides ?? {});

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const action = actionFor(bindings, scope, event);
      if (action === null) return;
      const handler = handlersRef.current[action as WindowAction];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overrides, scope]);
}
