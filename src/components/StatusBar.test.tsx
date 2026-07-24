import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

beforeEach(() => {
  useLayoutStore.setState(initialLayoutState);
});

describe("StatusBar", () => {
  it("reflects terminal visibility via aria-pressed", () => {
    render(<StatusBar />);
    expect(screen.getByRole("button", { name: /toggle terminal/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() => useLayoutStore.getState().setBottomTerminalVisible(false));
    expect(screen.getByRole("button", { name: /toggle terminal/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("toggles the terminal when clicked", () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: /toggle terminal/i }));
    expect(useLayoutStore.getState().bottomTerminalVisible).toBe(false);
  });
});
