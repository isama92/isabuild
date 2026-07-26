import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileContextMenu } from "./FileContextMenu";
import type { FileTarget } from "../lib/fileActions";

// The menu's own behaviour: keyboard navigation, the submenu, and focus. What it
// *offers* is decided by `lib/fileActions.fileMenuItems` and tested there; what
// it does to the repository is tested through StatusPanel.

const TARGET: FileTarget = { path: "src/app.ts", group: "unstaged", status: "modified" };

const onAction = vi.fn();
const onClose = vi.fn();

function open(overrides: Partial<React.ComponentProps<typeof FileContextMenu>> = {}) {
  return render(
    <FileContextMenu
      target={TARGET}
      x={40}
      y={60}
      operationInProgress={false}
      onAction={onAction}
      onClose={onClose}
      {...overrides}
    />,
  );
}

function items() {
  return screen.getAllByRole("menuitem");
}

beforeEach(() => {
  onAction.mockReset();
  onClose.mockReset();
});

describe("FileContextMenu", () => {
  it("focuses its first item, so the keyboard can drive it immediately", () => {
    open();
    expect(items()[0]).toHaveFocus();
  });

  it("moves focus with the arrow keys and wraps at both ends", () => {
    open();
    const menu = screen.getByRole("menu");
    const all = items();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(all[1]).toHaveFocus();

    // Up from the top wraps to the bottom, as BranchMenu does.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(all[all.length - 1]).toHaveFocus();
  });

  it("skips a disabled item rather than parking focus on it", () => {
    open({ operationInProgress: true });
    const menu = screen.getByRole("menu");
    // Commit is disabled mid-operation, so Rollback is the first item.
    expect(screen.getByRole("menuitem", { name: "Rollback…" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Commit…" })).not.toHaveFocus();
  });

  /** Walk focus down to the Copy path item, from wherever it starts. */
  function focusCopyPath(menu: HTMLElement) {
    const parent = screen.getByRole("menuitem", { name: /Copy path/ });
    // Bounded, so a navigation bug fails the test instead of hanging the suite.
    for (let step = 0; step < 10 && document.activeElement !== parent; step += 1) {
      fireEvent.keyDown(menu, { key: "ArrowDown" });
    }
    expect(parent).toHaveFocus();
    return parent;
  }

  it("opens the submenu with ArrowRight, and moves focus into it", () => {
    open();
    const menu = screen.getByRole("menu");
    focusCopyPath(menu);

    expect(screen.queryByRole("menuitem", { name: "Relative path" })).not.toBeInTheDocument();
    fireEvent.keyDown(menu, { key: "ArrowRight" });

    const first = screen.getByRole("menuitem", { name: "Relative path" });
    expect(first).toBeInTheDocument();
    expect(first).toHaveFocus();
  });

  it("ignores ArrowRight on an item with no submenu", () => {
    open();
    // Focus starts on Commit, which has nothing to open.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowRight" });
    expect(screen.queryByRole("menuitem", { name: "Relative path" })).not.toBeInTheDocument();
  });

  it("closes the submenu with ArrowLeft and gives focus back to its item", () => {
    open();
    const menu = screen.getByRole("menu");
    const parent = focusCopyPath(menu);
    fireEvent.keyDown(menu, { key: "ArrowRight" });

    fireEvent.keyDown(menu, { key: "ArrowLeft" });

    expect(screen.queryByRole("menuitem", { name: "Relative path" })).not.toBeInTheDocument();
    expect(parent).toHaveFocus();
  });

  it("closes only the submenu on the first Escape", () => {
    open();
    const menu = screen.getByRole("menu");
    focusCopyPath(menu);
    fireEvent.keyDown(menu, { key: "ArrowRight" });

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "Relative path" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("walks on through the submenu with the arrow keys", () => {
    open();
    const menu = screen.getByRole("menu");
    focusCopyPath(menu);
    fireEvent.keyDown(menu, { key: "ArrowRight" });

    // The submenu renders inside its parent item, so DOM order is visual order
    // and the arrows need no separate index to follow it.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Absolute path" })).toHaveFocus();
  });

  it("reports the chosen action with its target, and closes first", () => {
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add (stage)" }));

    expect(onAction).toHaveBeenCalledWith("stage", TARGET);
    // Closed before the action, so a dialog opening over it does not have to
    // fight the menu for focus.
    expect(onClose).toHaveBeenCalled();
  });

  it("returns focus where it was when it closes", () => {
    // A keyboard user who opened this with Shift+F10 must land back on the row,
    // not on document.body.
    const row = document.createElement("button");
    document.body.appendChild(row);
    row.focus();

    const { unmount } = open();
    expect(row).not.toHaveFocus();

    unmount();
    expect(row).toHaveFocus();
    row.remove();
  });

  it("places itself at the requested corner when it fits", () => {
    // jsdom measures every box as zero, so this pins the wiring rather than the
    // flipping; `clampMenuPosition` is unit-tested for the overflow cases.
    open({ x: 40, y: 60 });
    expect(screen.getByRole("menu")).toHaveStyle({ left: "40px", top: "60px" });
  });

  it("stops Escape reaching the terminal behind it", () => {
    // xterm forwards an Escape it sees straight to the PTY, which is why Modal
    // captures the key too.
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    open();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(seen).not.toHaveBeenCalled();
    document.removeEventListener("keydown", seen);
  });
});
