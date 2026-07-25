import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BranchMenu } from "./BranchMenu";
import type { BranchState } from "../lib/gitBranch";

function state(overrides: Partial<BranchState> = {}): BranchState {
  return {
    current: "main",
    detachedSha: null,
    unborn: false,
    upstream: "origin/main",
    upstreamGone: false,
    upstreamOnRemote: true,
    remote: "origin",
    ahead: 0,
    behind: 0,
    lastFetch: null,
    locals: [
      { name: "main", upstream: "origin/main", committerDate: 3, headShort: "aaa" },
      { name: "feature/login", committerDate: 2, headShort: "bbb" },
    ],
    remotes: [
      {
        name: "origin/main",
        remote: "origin",
        branch: "main",
        hasLocal: true,
        committerDate: 3,
        headShort: "aaa",
      },
      {
        name: "origin/colleague",
        remote: "origin",
        branch: "colleague",
        hasLocal: false,
        committerDate: 1,
        headShort: "ccc",
      },
    ],
    ...overrides,
  };
}

function setup(
  overrides: Partial<BranchState> = {},
  props: Partial<{ busy: boolean; mergeBlocked: string | null }> = {},
) {
  const handlers = {
    onPick: vi.fn(),
    onNewBranch: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onMerge: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <BranchMenu
      state={state(overrides)}
      {...handlers}
      busy={props.busy ?? false}
      mergeBlocked={props.mergeBlocked ?? null}
    />,
  );
  return handlers;
}

describe("BranchMenu", () => {
  it("lists locals under Branches and remote-only ones under Remote branches", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Branches" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remote branches" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "main, current branch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check out origin/colleague" })).toBeInTheDocument();
    // origin/main mirrors local main, so it is not offered a second time.
    expect(screen.queryByRole("button", { name: "Check out origin/main" })).not.toBeInTheDocument();
  });

  it("marks the current branch with aria-current", () => {
    setup();
    expect(screen.getByRole("button", { name: "main, current branch" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Switch to feature/login" })).toHaveAttribute(
      "aria-current",
      "false",
    );
  });

  it("tags a local branch with no upstream", () => {
    setup();
    expect(screen.getByRole("button", { name: "Switch to feature/login" })).toHaveTextContent("local only");
  });

  it("filters as you type, across both sections", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Filter branches"), { target: { value: "coll" } });
    expect(screen.queryByRole("button", { name: "main, current branch" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check out origin/colleague" })).toBeInTheDocument();
  });

  it("says so when nothing matches", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Filter branches"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching branches")).toBeInTheDocument();
  });

  it("reports a local pick with no track ref", () => {
    const { onPick } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Switch to feature/login" }));
    expect(onPick).toHaveBeenCalledWith({
      kind: "local",
      branch: expect.objectContaining({ name: "feature/login" }),
    });
  });

  it("reports a remote pick so the caller can create a tracking branch", () => {
    const { onPick } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Check out origin/colleague" }));
    expect(onPick).toHaveBeenCalledWith({
      kind: "remote",
      branch: expect.objectContaining({ name: "origin/colleague", branch: "colleague" }),
    });
  });

  it("moves the highlight with the arrow keys and picks with Enter", () => {
    const { onPick } = setup();
    const filter = screen.getByLabelText("Filter branches");
    // The first Down enters the list at the top row, rather than skipping it.
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "main, current branch" })).toHaveFocus();
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Switch to feature/login" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Switch to feature/login" }), {
      key: "Enter",
    });
    expect(onPick).toHaveBeenCalledWith({
      kind: "local",
      branch: expect.objectContaining({ name: "feature/login" }),
    });
  });

  it("picks the top match on Enter straight from the filter field", () => {
    const { onPick } = setup();
    const filter = screen.getByLabelText("Filter branches");
    fireEvent.change(filter, { target: { value: "coll" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({
      kind: "remote",
      branch: expect.objectContaining({ name: "origin/colleague" }),
    });
  });

  it("wraps the highlight around the ends of the list", () => {
    setup();
    const filter = screen.getByLabelText("Filter branches");
    // Up from the top wraps to the last row, which is the remote-only branch.
    fireEvent.keyDown(filter, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Check out origin/colleague" })).toHaveFocus();
  });

  it("does not move the highlight when the list is empty", () => {
    setup();
    const filter = screen.getByLabelText("Filter branches");
    fireEvent.change(filter, { target: { value: "zzz" } });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    // Nothing to focus, and nothing throws.
    expect(screen.getByText("No matching branches")).toBeInTheDocument();
  });

  it("closes on Escape and on a click outside", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByLabelText("Filter branches"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close on a click inside itself", () => {
    const { onClose } = setup();
    fireEvent.mouseDown(screen.getByLabelText("Filter branches"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers rename only for the current branch and delete only for the others", () => {
    const { onRename, onDelete } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Actions for main" }));
    expect(screen.getByRole("button", { name: "Rename…" })).toBeEnabled();
    // You cannot delete the branch you are on.
    expect(screen.getByRole("button", { name: "Delete…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
    expect(onRename).toHaveBeenCalledWith("main");

    fireEvent.click(screen.getByRole("button", { name: "Actions for feature/login" }));
    // Renaming is scoped to the current branch, so this is the mirror image.
    expect(screen.getByRole("button", { name: "Rename…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(onDelete).toHaveBeenCalledWith("feature/login");
  });

  it("closes the row menu when its trigger is clicked again", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Actions for main" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Rename…" })).not.toBeInTheDocument();
  });

  it("reports the New branch request", () => {
    const { onNewBranch } = setup();
    fireEvent.click(screen.getByRole("button", { name: /New branch/ }));
    expect(onNewBranch).toHaveBeenCalledTimes(1);
  });

  it("disables every action while an operation is running", () => {
    const { onPick } = setup({}, { busy: true });
    const row = screen.getByRole("button", { name: "Switch to feature/login" });
    expect(row).toBeDisabled();
    expect(screen.getByRole("button", { name: /New branch/ })).toBeDisabled();

    // And Enter must not slip a pick through either.
    fireEvent.keyDown(screen.getByLabelText("Filter branches"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("Filter branches"), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("renders an unborn repo with no branches at all", () => {
    setup({ locals: [], remotes: [] });
    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Branches" })).not.toBeInTheDocument();
  });
});

describe("BranchMenu merge action (Part 6)", () => {
  it("offers a merge into the current branch on another local branch", () => {
    const { onMerge } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for feature/login" }));

    const merge = screen.getByRole("button", { name: "Merge into main…" });
    expect(merge).toBeEnabled();
    fireEvent.click(merge);

    expect(onMerge).toHaveBeenCalledWith("feature/login");
  });

  it("refuses to merge the branch you are already on, and says why", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for main" }));

    const merge = screen.getByRole("button", { name: "Merge into main…" });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("title", "This is the branch you are on");
  });

  it("merges a remote-tracking ref directly, with no local branch needed", () => {
    const { onMerge } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Actions for origin/colleague" }));

    fireEvent.click(screen.getByRole("button", { name: "Merge into main…" }));

    expect(onMerge).toHaveBeenCalledWith("origin/colleague");
  });

  it("passes the blocked reason through as the disabled tooltip", () => {
    // A greyed-out Merge that does not say why is worse than no Merge at all.
    setup({}, { mergeBlocked: "Finish or abort the operation in progress first" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for feature/login" }));

    const merge = screen.getByRole("button", { name: "Merge into main…" });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("title", "Finish or abort the operation in progress first");
  });

  it("says merging needs a branch when HEAD is detached", () => {
    setup({ current: null });
    fireEvent.click(screen.getByRole("button", { name: "Actions for feature/login" }));

    const merge = screen.getByRole("button", { name: "Merge…" });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute("title", "Merging needs a branch checked out");
  });

  it("is disabled while an operation is running", () => {
    setup({}, { busy: true });
    // The row's actions trigger is itself disabled, which is what keeps the menu
    // (and its merge entry) out of reach mid-operation.
    expect(screen.getByRole("button", { name: "Actions for feature/login" })).toBeDisabled();
  });
});
