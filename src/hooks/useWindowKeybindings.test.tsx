import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useWindowKeybindings, type WindowAction } from "./useWindowKeybindings";
import { initialSettingsState, useSettingsStore } from "../store/settingsStore";
import type { Scope } from "../lib/keybindings";
import type { Settings } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const close = vi.fn();
const next = vi.fn();
const previous = vi.fn();

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

function Harness({
  scope,
  handlers,
}: {
  scope: Scope;
  handlers: Partial<Record<WindowAction, () => void>>;
}) {
  useWindowKeybindings(scope, handlers);
  return null;
}

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const preventDefault = vi.spyOn(event, "preventDefault");
  window.dispatchEvent(event);
  return { preventDefault };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ ...initialSettingsState, settings: settings() });
});

describe("useWindowKeybindings", () => {
  it("runs the handler for a bound action in its scope", () => {
    render(<Harness scope="diff" handlers={{ "close-window": close }} />);
    press({ code: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("runs a merge-only action in the merge window", () => {
    render(
      <Harness scope="merge" handlers={{ "next-conflict": next, "previous-conflict": previous }} />,
    );
    press({ code: "ArrowDown", altKey: true });
    expect(next).toHaveBeenCalledTimes(1);

    press({ code: "ArrowUp", altKey: true });
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it("ignores a merge-only action in the diff window", () => {
    render(<Harness scope="diff" handlers={{ "next-conflict": next }} />);
    press({ code: "ArrowDown", altKey: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves a key the editor has already handled alone", () => {
    // CodeMirror consumes Escape to close the find panel and to dismiss
    // autocomplete. Closing the window as well would be two things at once.
    render(<Harness scope="diff" handlers={{ "close-window": close }} />);
    // Capture phase, so it runs before the hook's bubble-phase listener the
    // way a real editor's handler would.
    const claim = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", claim, { capture: true });
    press({ code: "Escape" });
    window.removeEventListener("keydown", claim, { capture: true });

    expect(close).not.toHaveBeenCalled();
  });

  it("does not swallow a keystroke it has no handler for", () => {
    // The editor owns everything else in these windows.
    render(<Harness scope="merge" handlers={{ "close-window": close }} />);
    const { preventDefault } = press({ code: "ArrowDown", altKey: true });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("follows a rebind", () => {
    useSettingsStore.setState({ settings: settings({ "close-window": "Ctrl+Q" }) });
    render(<Harness scope="diff" handlers={{ "close-window": close }} />);

    press({ code: "Escape" });
    expect(close).not.toHaveBeenCalled();

    press({ code: "KeyQ", ctrlKey: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fires nothing for an action the user unbound", () => {
    useSettingsStore.setState({ settings: settings({ "close-window": "" }) });
    render(<Harness scope="diff" handlers={{ "close-window": close }} />);
    press({ code: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });

  it("does not re-register when the caller passes a fresh handlers object", () => {
    // The normal call site is an inline literal, so a new object every render.
    const { rerender } = render(<Harness scope="diff" handlers={{ "close-window": close }} />);
    rerender(<Harness scope="diff" handlers={{ "close-window": close }} />);

    press({ code: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = render(<Harness scope="diff" handlers={{ "close-window": close }} />);
    unmount();
    press({ code: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
});
