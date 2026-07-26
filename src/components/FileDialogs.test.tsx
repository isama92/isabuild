import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommitFileDialog, RollbackFileDialog } from "./FileDialogs";
import type { FileTarget } from "../lib/fileActions";

// The dialogs' own behaviour. What they *say* about a rollback comes from
// `lib/fileActions.rollbackDescription` and is tested there; how they are reached
// is tested through StatusPanel.

const TARGET: FileTarget = { path: "src/app.ts", group: "unstaged", status: "modified" };

const onCommit = vi.fn();
const onRollback = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  onCommit.mockReset();
  onRollback.mockReset();
  onClose.mockReset();
});

describe("CommitFileDialog", () => {
  function open(overrides: Partial<React.ComponentProps<typeof CommitFileDialog>> = {}) {
    return render(
      <CommitFileDialog
        target={TARGET}
        alsoModified={false}
        onCommit={onCommit}
        onClose={onClose}
        {...overrides}
      />,
    );
  }

  function message() {
    return screen.getByLabelText("Message");
  }

  it("names the file it is about to commit", () => {
    open();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Commit src/app.ts");
  });

  it("will not commit a blank or whitespace-only message", () => {
    open();
    const commit = screen.getByRole("button", { name: "Commit" });
    expect(commit).toBeDisabled();

    fireEvent.change(message(), { target: { value: "   \n  " } });
    expect(commit).toBeDisabled();

    fireEvent.change(message(), { target: { value: "real" } });
    expect(commit).toBeEnabled();
  });

  it("trims the message it hands over", () => {
    open();
    fireEvent.change(message(), { target: { value: "  fix the thing\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(onCommit).toHaveBeenCalledWith("fix the thing");
  });

  it("commits on Ctrl+Enter and on Cmd+Enter", () => {
    open();
    fireEvent.change(message(), { target: { value: "subject" } });

    fireEvent.keyDown(message(), { key: "Enter", ctrlKey: true });
    expect(onCommit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(message(), { key: "Enter", metaKey: true });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("leaves plain Enter alone, so a message can have a body", () => {
    // The field is a textarea for this reason: git messages are a subject and a
    // body, and submitting on Enter would make the body unreachable.
    open();
    fireEvent.change(message(), { target: { value: "subject" } });

    fireEvent.keyDown(message(), { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("says only this file is committed", () => {
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent(/anything else you have staged stays/i);
  });

  it("names both halves of a rename", () => {
    open({
      target: { path: "new.ts", origPath: "old.ts", group: "staged", status: "renamed" },
    });
    expect(screen.getByRole("dialog")).toHaveTextContent("old.ts → new.ts");
  });

  it("warns only when the file was changed again after being staged", () => {
    const { unmount } = open({ alsoModified: false });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();

    open({ alsoModified: true });
    // git commit -- <path> bypasses the index, so the staged version is not what
    // lands. Silence here would be a surprise found in the log afterwards.
    expect(screen.getByRole("status")).toHaveTextContent(/not the one you staged/i);
  });
});

describe("RollbackFileDialog", () => {
  function open(target: FileTarget) {
    return render(
      <RollbackFileDialog target={target} onRollback={onRollback} onClose={onClose} />,
    );
  }

  it("asks to roll back a tracked change", () => {
    open(TARGET);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Roll back src/app.ts?");
    expect(screen.getByRole("button", { name: "Roll back" })).toBeInTheDocument();
  });

  it("asks to delete when there is no committed version to restore", () => {
    // An untracked file and a never-committed staged one are both absent from
    // HEAD, so "roll back" would be a lie about what the button does.
    for (const status of ["untracked", "added"] as const) {
      const { unmount } = open({ path: "new.ts", group: "unstaged", status });
      expect(screen.getByRole("dialog")).toHaveAccessibleName("Delete new.ts?");
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
      unmount();
    }
  });

  it("runs only when confirmed", () => {
    open(TARGET);
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes without rolling back on Cancel", () => {
    open(TARGET);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRollback).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
