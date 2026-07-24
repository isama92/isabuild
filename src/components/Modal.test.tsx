import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("exposes itself as a modal dialog with its title as the accessible name", () => {
    render(
      <Modal title="New branch" onClose={vi.fn()}>
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "New branch" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("focuses the first focusable element so typing works immediately", () => {
    render(
      <Modal title="New branch" onClose={vi.fn()}>
        <input aria-label="Name" />
      </Modal>,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal title="New branch" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("swallows Escape in the capture phase so xterm never sees it", () => {
    // A bubble-phase listener would fire after xterm had already forwarded the
    // key to the PTY — the same reasoning as useGlobalKeybindings.
    render(
      <Modal title="New branch" onClose={vi.fn()}>
        <p>body</p>
      </Modal>,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const prevented = vi.spyOn(event, "preventDefault");
    const stopped = vi.spyOn(event, "stopPropagation");
    window.dispatchEvent(event);
    expect(prevented).toHaveBeenCalled();
    expect(stopped).toHaveBeenCalled();
  });

  it("closes when the backdrop is clicked but not the box itself", () => {
    const onClose = vi.fn();
    render(
      <Modal title="New branch" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    // The backdrop is the dialog's parent.
    const backdrop = screen.getByRole("dialog").parentElement;
    if (!backdrop) throw new Error("no backdrop");
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab at both ends so focus cannot reach the workspace behind it", () => {
    render(
      <Modal
        title="Confirm"
        onClose={vi.fn()}
        actions={
          <>
            <button type="button">Cancel</button>
            <button type="button">Confirm</button>
          </>
        }
      >
        <input aria-label="Name" />
      </Modal>,
    );
    const name = screen.getByLabelText("Name");
    const confirm = screen.getByRole("button", { name: "Confirm" });

    // Forward from the last element lands on the first.
    confirm.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(name).toHaveFocus();

    // And backward from the first lands on the last.
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("restores focus to where it was when it unmounts", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const view = render(
      <Modal title="New branch" onClose={vi.fn()}>
        <input aria-label="Name" />
      </Modal>,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();

    view.unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("omits the actions row when there are no actions", () => {
    render(
      <Modal title="Info" onClose={vi.fn()}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
