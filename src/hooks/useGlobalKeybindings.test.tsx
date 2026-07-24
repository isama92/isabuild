import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useGlobalKeybindings } from "./useGlobalKeybindings";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

function Harness() {
  useGlobalKeybindings();
  return null;
}

beforeEach(() => {
  useLayoutStore.setState(initialLayoutState);
});

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const preventDefault = vi.spyOn(event, "preventDefault");
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  window.dispatchEvent(event);
  return { preventDefault, stopPropagation };
}

describe("useGlobalKeybindings", () => {
  it("toggles the bottom terminal on Ctrl+1 and swallows the event", () => {
    render(<Harness />);
    const { preventDefault, stopPropagation } = press({ ctrlKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("ignores 1 without Ctrl, Ctrl+2, Cmd+1 and Ctrl+Shift+1", () => {
    render(<Harness />);
    press({ code: "Digit1" }); // no modifier
    press({ ctrlKey: true, code: "Digit2" }); // unmapped key
    press({ ctrlKey: true, metaKey: true, code: "Digit1" }); // extra modifier
    press({ ctrlKey: true, shiftKey: true, code: "Digit1" }); // extra modifier
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    press({ ctrlKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });
});
