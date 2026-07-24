import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusPanel } from "./StatusPanel";
import { initialGitState, useGitStore } from "../store/gitStore";
import { initialLayoutState, useLayoutStore } from "../store/layoutStore";

beforeEach(() => {
  useGitStore.setState(initialGitState);
  useLayoutStore.setState(initialLayoutState);
});

describe("StatusPanel", () => {
  it("renders staged and unstaged groups with their files", () => {
    useGitStore.setState({
      phase: "ready",
      staged: [{ path: "src/a.ts", status: "added" }],
      unstaged: [
        { path: "src/b.ts", status: "modified" },
        { path: "note.txt", status: "untracked" },
      ],
    });
    render(<StatusPanel />);

    expect(screen.getByText("Staged Changes")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("note.txt")).toBeInTheDocument();
  });

  it("shows 'No changes' when the repo is clean", () => {
    useGitStore.setState({ phase: "ready", staged: [], unstaged: [] });
    render(<StatusPanel />);
    expect(screen.getByText(/no changes/i)).toBeInTheDocument();
  });

  it("shows the error message when status could not be read", () => {
    useGitStore.setState({
      phase: "error",
      error: "'/x' is not inside a git repository",
    });
    render(<StatusPanel />);
    expect(screen.getByText(/not inside a git repository/i)).toBeInTheDocument();
  });

  it("does not render the Staged group when nothing is staged", () => {
    useGitStore.setState({
      phase: "ready",
      staged: [],
      unstaged: [{ path: "b.ts", status: "modified" }],
    });
    render(<StatusPanel />);
    expect(screen.queryByText("Staged Changes")).not.toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
  });

  it("shows the rename origin in the row tooltip", () => {
    useGitStore.setState({
      phase: "ready",
      staged: [{ path: "new.ts", origPath: "old.ts", status: "renamed" }],
      unstaged: [],
    });
    render(<StatusPanel />);
    expect(screen.getByText("new.ts").closest("li")).toHaveAttribute("title", "old.ts → new.ts");
  });

  it("hides the panel when the close button is clicked", () => {
    render(<StatusPanel />);
    fireEvent.click(screen.getByRole("button", { name: /close status panel/i }));
    expect(useLayoutStore.getState().statusPanelVisible).toBe(false);
  });
});
