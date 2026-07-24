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

  it("ignores 1 without Alt, an unmapped Alt+3, Ctrl+1 and Alt+Shift+1", () => {
    render(<Harness />);
    press({ code: "Digit1" }); // no modifier
    press({ altKey: true, code: "Digit3" }); // unmapped key
    press({ ctrlKey: true, code: "Digit1" }); // wrong modifier
    press({ altKey: true, shiftKey: true, code: "Digit1" }); // extra modifier
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
    expect(useLayoutStore.getState().statusPanelVisible).toBe(true);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    press({ altKey: true, code: "Digit1" });
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(true);
  });
});
