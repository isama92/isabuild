import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { StatusBar } from "./StatusBar";
import { initialGitState, useGitStore } from "../store/gitStore";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

beforeEach(() => {
  useLayoutStore.setState(initialLayoutState);
  useGitStore.setState(initialGitState);
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

  it("reflects status-panel visibility via aria-pressed", () => {
    render(<StatusBar />);
    expect(screen.getByRole("button", { name: /toggle status panel/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() => useLayoutStore.getState().setStatusPanelVisible(false));
    expect(screen.getByRole("button", { name: /toggle status panel/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("toggles the status panel when clicked", () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: /toggle status panel/i }));
    expect(useLayoutStore.getState().statusPanelVisible).toBe(false);
  });

  it("prefixes each toggle with its Alt+<n> shortcut number", () => {
    render(<StatusBar />);
    expect(within(screen.getByRole("button", { name: /toggle terminal/i })).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /toggle status panel/i })).getByText("2")).toBeInTheDocument();
  });

  it("hosts the branch cluster on the right once branch state is known", () => {
    render(<StatusBar />);
    // Nothing there before the first branch read, so the bar is just the toggles.
    expect(screen.queryByRole("button", { name: "Current branch" })).not.toBeInTheDocument();

    act(() =>
      useGitStore.setState({
        repoRoot: "/repo",
        branch: {
          current: "main",
          detachedSha: null,
          unborn: false,
          upstream: "origin/main",
          remote: "origin",
          ahead: 0,
          behind: 0,
          lastFetch: null,
          locals: [{ name: "main", upstream: "origin/main", committerDate: 1, headShort: "aaa" }],
          remotes: [],
        },
      }),
    );

    expect(screen.getByRole("button", { name: "Current branch" })).toHaveTextContent("main");
    // The toggles are untouched by the addition.
    expect(screen.getByRole("button", { name: /toggle terminal/i })).toBeInTheDocument();
  });
});
