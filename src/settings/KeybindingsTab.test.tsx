import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { KeybindingsTab } from "./KeybindingsTab";
import type { Settings } from "../lib/settings";

const save = vi.fn();

function settings(keybindings: Record<string, string> = {}): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings,
    lastProject: null,
    recentProjects: [],
  };
}

function mount(keybindings: Record<string, string> = {}) {
  return render(<KeybindingsTab settings={settings(keybindings)} save={save} />);
}

/** The row's record button, by the action's label. */
function row(label: string) {
  return screen.getByRole("button", { name: `Change the shortcut for ${label}` });
}

const TERMINAL = "Toggle the bottom terminal";
const FETCH = "Fetch";

beforeEach(() => vi.clearAllMocks());

describe("KeybindingsTab", () => {
  it("lists every action with its current accelerator", () => {
    mount();
    expect(row(TERMINAL)).toHaveTextContent("Alt+1");
    expect(row(FETCH)).toHaveTextContent("Alt+3");
  });

  it("shows an override in place of the default", () => {
    mount({ "toggle-terminal": "Ctrl+Shift+T" });
    expect(row(TERMINAL)).toHaveTextContent("Ctrl+Shift+T");
  });

  it("says so when an action is unbound", () => {
    mount({ "toggle-terminal": "" });
    expect(row(TERMINAL)).toHaveTextContent("Not bound");
  });

  it("records a combination and saves it", () => {
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "KeyT", ctrlKey: true, shiftKey: true });

    expect(save).toHaveBeenCalledWith({ keybindings: { "toggle-terminal": "Ctrl+Shift+T" } });
    // Recording stops on its own; the row shows a value again.
    expect(row(TERMINAL)).not.toHaveTextContent("Press a combination");
  });

  it("keeps waiting while only a modifier is held", () => {
    // The recorder sees this continuously while the user reaches for the key.
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "AltLeft", altKey: true });

    expect(save).not.toHaveBeenCalled();
    expect(row(TERMINAL)).toHaveTextContent("Press a combination");
  });

  it("cancels on Escape rather than binding it", () => {
    // Escape has to stay usable as a cancel here even though it is itself a
    // bindable accelerator elsewhere.
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "Escape", key: "Escape" });

    expect(save).not.toHaveBeenCalled();
    expect(row(TERMINAL)).toHaveTextContent("Alt+1");
  });

  it("refuses a combination another action in the same window already has", () => {
    mount();
    fireEvent.click(row(FETCH));
    fireEvent.keyDown(window, { code: "Digit1", altKey: true });

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(TERMINAL);
    // Still recording, so the next attempt does not need another click.
    expect(row(FETCH)).toHaveTextContent("Press a combination");
  });

  it("allows a combination only used in a different window", () => {
    // `next-conflict` is Alt+ArrowDown in the merge window; the workspace never
    // sees it, so a workspace action may take it too.
    mount();
    fireEvent.click(row(FETCH));
    fireEvent.keyDown(window, { code: "ArrowDown", altKey: true });

    expect(save).toHaveBeenCalledWith({ keybindings: { "git-fetch": "Alt+ArrowDown" } });
  });

  it("refuses a bare key that the terminal needs to type", () => {
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "KeyA" });

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("needs Ctrl, Alt or Cmd");
  });

  it("does not count Shift as enough of a modifier", () => {
    // Shift+A is still a letter someone wants to type.
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "KeyA", shiftKey: true });

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("needs Ctrl, Alt or Cmd");
  });

  it("refuses a combination the native menu already owns", () => {
    // The OS handles it before the webview sees a keystroke, so the row would
    // look bound and do nothing.
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "KeyO", ctrlKey: true });

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Open Folder");
  });

  it("allows a menu combination for an action the menu does not reach", () => {
    // The File menu belongs to the workspace; a merge window never sees Ctrl+O.
    mount();
    fireEvent.click(row("Next conflict"));
    fireEvent.keyDown(window, { code: "KeyO", ctrlKey: true });

    expect(save).toHaveBeenCalledWith({ keybindings: { "next-conflict": "Ctrl+O" } });
  });

  it("cannot record a bare Escape onto anything, because Escape cancels", () => {
    // Documented rather than worked around: `close-window` already has it by
    // default, and Reset is how it comes back.
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "Escape", key: "Escape" });

    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the other overrides when it saves one", () => {
    mount({ "git-pull": "Alt+9" });
    fireEvent.click(row(TERMINAL));
    fireEvent.keyDown(window, { code: "KeyT", ctrlKey: true, shiftKey: true });

    expect(save).toHaveBeenCalledWith({
      keybindings: { "git-pull": "Alt+9", "toggle-terminal": "Ctrl+Shift+T" },
    });
  });

  it("unbinds an action by storing an empty accelerator", () => {
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Unbind" })[0]);
    expect(save).toHaveBeenCalledWith({ keybindings: { "toggle-terminal": "" } });
  });

  it("resets by deleting the override, not by writing the default in", () => {
    // So the action keeps following the default even if a later release
    // changes it.
    mount({ "toggle-terminal": "Ctrl+Shift+T" });
    const reset = screen.getAllByRole("button", { name: "Reset" })[0];
    fireEvent.click(reset);

    expect(save).toHaveBeenCalledWith({ keybindings: {} });
  });

  it("offers Reset only where there is something to reset", () => {
    mount({ "toggle-terminal": "Ctrl+Shift+T" });
    const resets = screen.getAllByRole("button", { name: "Reset" });
    expect(resets[0]).toBeEnabled();
    expect(resets[1]).toBeDisabled();
  });

  it("offers Unbind only where something is bound", () => {
    mount({ "toggle-terminal": "" });
    expect(screen.getAllByRole("button", { name: "Unbind" })[0]).toBeDisabled();
  });

  it("stops recording when the row is clicked again", () => {
    mount();
    fireEvent.click(row(TERMINAL));
    fireEvent.click(row(TERMINAL));
    expect(row(TERMINAL)).toHaveTextContent("Alt+1");
  });

  it("does not record while no row is recording", () => {
    mount();
    fireEvent.keyDown(window, { code: "KeyT", ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
  });
});
