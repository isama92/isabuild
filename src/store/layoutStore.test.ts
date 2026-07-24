import { beforeEach, describe, expect, it } from "vitest";
import { initialLayoutState, useLayoutStore } from "./layoutStore";

beforeEach(() => {
  // Merge reset: restores data fields while keeping the action closures. A
  // replace reset (setState(x, true)) would wipe the actions.
  useLayoutStore.setState(initialLayoutState);
});

describe("layoutStore", () => {
  it("starts with the bottom terminal visible at the default size, unfocused", () => {
    const state = useLayoutStore.getState();
    expect(state.bottomTerminalVisible).toBe(true);
    expect(state.bottomTerminalSize).toBe(30);
    // Claude Code keeps focus on the startup mount.
    expect(state.bottomTerminalAutoFocus).toBe(false);
  });

  it("toggleBottomTerminal flips visibility both ways", () => {
    const { toggleBottomTerminal } = useLayoutStore.getState();
    toggleBottomTerminal();
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
    toggleBottomTerminal();
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });

  it("setBottomTerminalVisible is idempotent", () => {
    const { setBottomTerminalVisible } = useLayoutStore.getState();
    setBottomTerminalVisible(false);
    setBottomTerminalVisible(false);
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });

  it("setBottomTerminalSize stores the value", () => {
    useLayoutStore.getState().setBottomTerminalSize(42);
    expect(useLayoutStore.getState().bottomTerminalSize).toBe(42);
  });

  it("marks the terminal for autofocus once the user opens it, but not on startup", () => {
    const { toggleBottomTerminal } = useLayoutStore.getState();
    // Startup open (never toggled) does not earn focus.
    expect(useLayoutStore.getState().bottomTerminalAutoFocus).toBe(false);
    toggleBottomTerminal(); // close
    expect(useLayoutStore.getState().bottomTerminalAutoFocus).toBe(false);
    toggleBottomTerminal(); // user reopens -> focus
    expect(useLayoutStore.getState().bottomTerminalAutoFocus).toBe(true);
  });

  it("setBottomTerminalVisible(true) also earns autofocus", () => {
    useLayoutStore.getState().setBottomTerminalVisible(false);
    expect(useLayoutStore.getState().bottomTerminalAutoFocus).toBe(false);
    useLayoutStore.getState().setBottomTerminalVisible(true);
    expect(useLayoutStore.getState().bottomTerminalAutoFocus).toBe(true);
  });
});
