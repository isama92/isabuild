import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useGlobalKeybindings } from "./useGlobalKeybindings";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";
import { initialSettingsState, useSettingsStore } from "../store/settingsStore";
import type { Settings } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function Harness() {
  useGlobalKeybindings();
  return null;
}

function settings(keybindings: Record<string, string> = {}): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings,
    viewOptions: {},
    lastProject: null,
    recentProjects: [],
  };
}

beforeEach(() => {
  useLayoutStore.setState(initialLayoutState);
  useSettingsStore.setState({ ...initialSettingsState, settings: settings() });
});

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const preventDefault = vi.spyOn(event, "preventDefault");
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  window.dispatchEvent(event);
  return { preventDefault, stopPropagation };
}

describe("the default bindings", () => {
  it("toggles the bottom terminal on Alt+1 and swallows the event", () => {
    render(<Harness />);
    const { preventDefault, stopPropagation } = press({ altKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("toggles the status panel on Alt+2 and swallows the event", () => {
    render(<Harness />);
    const { preventDefault, stopPropagation } = press({ altKey: true, code: "Digit2" });
    expect(useLayoutStore.getState().statusPanelVisible).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("requests a sync operation rather than running it", () => {
    // Only BranchStatus knows whether the operation is currently possible.
    render(<Harness />);
    press({ altKey: true, code: "Digit3" });
    expect(useLayoutStore.getState().pendingGitAction).toBe("fetch");
  });

  it("has a separate digit for pull and for push", () => {
    render(<Harness />);
    press({ altKey: true, code: "Digit4" });
    expect(useLayoutStore.getState().pendingGitAction).toBe("pull");

    press({ altKey: true, code: "Digit5" });
    expect(useLayoutStore.getState().pendingGitAction).toBe("push");
  });

  it("opens the branch menu", () => {
    render(<Harness />);
    press({ altKey: true, code: "Digit6" });
    expect(useLayoutStore.getState().branchMenuOpen).toBe(true);
  });

  it("binds no bare Alt+letter, which readline needs for word motion", () => {
    // Alt+F and Alt+B are forward-word and backward-word in every shell; the
    // capture-phase listener would swallow them before xterm saw them.
    render(<Harness />);
    const { preventDefault } = press({ altKey: true, code: "KeyF" });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().pendingGitAction).toBeNull();
  });

  it("binds none of the keys the terminals translate for word editing", () => {
    // Same hazard one layer along: these reach xterm only because nothing here
    // resolves them, and `lib/terminalKeys` turns them into word motion and word
    // deletion at both prompts.
    render(<Harness />);
    for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      for (const code of ["ArrowLeft", "ArrowRight", "Backspace", "Delete"]) {
        const { preventDefault, stopPropagation } = press({ ...modifiers, code });
        expect(preventDefault, code).not.toHaveBeenCalled();
        expect(stopPropagation, code).not.toHaveBeenCalled();
      }
    }
    expect(useLayoutStore.getState().pendingGitAction).toBeNull();
  });
});

describe("while a dialog is open", () => {
  /** A modal, as `Modal` renders one. */
  function openDialog() {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    return () => dialog.remove();
  }

  it("fires nothing", () => {
    // This hook registers at Layout mount, so it is earlier in the capture
    // order than any dialog opened later and would otherwise run first.
    render(<Harness />);
    const close = openDialog();
    press({ altKey: true, code: "Digit5" });
    close();

    expect(useLayoutStore.getState().pendingGitAction).toBeNull();
  });

  it("does not swallow the keystroke either", () => {
    render(<Harness />);
    const close = openDialog();
    const { preventDefault } = press({ altKey: true, code: "Digit1" });
    close();

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("resumes once the dialog goes", () => {
    render(<Harness />);
    openDialog()();
    press({ altKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });
});

describe("keystrokes it must not touch", () => {
  it("ignores 1 without Alt, an unmapped Alt+3, Ctrl+1 and Alt+Shift+1", () => {
    render(<Harness />);
    press({ code: "Digit1" }); // no modifier
    press({ altKey: true, code: "Digit3" }); // unmapped key
    press({ ctrlKey: true, code: "Digit1" }); // wrong modifier
    press({ altKey: true, shiftKey: true, code: "Digit1" }); // extra modifier
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
    expect(useLayoutStore.getState().statusPanelVisible).toBe(true);
  });

  it("lets an unbound keystroke through untouched", () => {
    // Everything the terminal needs falls in here; swallowing a key we have no
    // action for would break typing.
    render(<Harness />);
    const { preventDefault, stopPropagation } = press({ code: "KeyA" });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("leaves a key something else has already handled alone", () => {
    // Registered before the hook, so it is earlier in the capture order: this
    // hook deliberately runs ahead of everything in the document (xterm must
    // not see the key first), so only a listener installed before it can
    // claim a keystroke out from under it.
    const claim = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", claim, { capture: true });
    render(<Harness />);
    press({ altKey: true, code: "Digit1" });
    window.removeEventListener("keydown", claim, { capture: true });

    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    press({ altKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });
});

describe("custom bindings", () => {
  it("fires on the user's combination instead of the default", () => {
    useSettingsStore.setState({ settings: settings({ "toggle-terminal": "Ctrl+Shift+T" }) });
    render(<Harness />);

    press({ ctrlKey: true, shiftKey: true, code: "KeyT" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });

  it("stops firing on the default once it has been rebound", () => {
    useSettingsStore.setState({ settings: settings({ "toggle-terminal": "Ctrl+Shift+T" }) });
    render(<Harness />);

    press({ altKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });

  it("fires nothing for an action the user unbound", () => {
    useSettingsStore.setState({ settings: settings({ "toggle-terminal": "" }) });
    render(<Harness />);

    press({ altKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });

  it("picks up a rebind made while the workspace is open", () => {
    // The settings window is a different window; its change arrives as an event
    // and must take effect without a restart.
    const { rerender } = render(<Harness />);
    useSettingsStore.setState({ settings: settings({ "toggle-terminal": "Ctrl+Shift+T" }) });
    rerender(<Harness />);

    press({ ctrlKey: true, shiftKey: true, code: "KeyT" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });

  it("uses the defaults before the settings have been read", () => {
    useSettingsStore.setState({ settings: null });
    render(<Harness />);

    press({ altKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });
});
