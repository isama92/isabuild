import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DeleteBranchDialog,
  DirtySwitchDialog,
  NewBranchDialog,
  OpErrorDialog,
  RenameBranchDialog,
} from "./GitDialogs";
import { validateBranchName } from "../lib/gitBranch";
import type { BranchState } from "../lib/gitBranch";

// Component tests mock the project's own lib module, not the Tauri API.
vi.mock("../lib/gitBranch", () => ({ validateBranchName: vi.fn() }));
const validateMock = vi.mocked(validateBranchName);

function state(overrides: Partial<BranchState> = {}): BranchState {
  return {
    current: "main",
    detachedSha: null,
    unborn: false,
    upstream: "origin/main",
    remote: "origin",
    ahead: 0,
    behind: 0,
    lastFetch: null,
    locals: [
      { name: "main", upstream: "origin/main", committerDate: 2, headShort: "aaa" },
      { name: "dev", committerDate: 1, headShort: "bbb" },
    ],
    remotes: [
      {
        name: "origin/main",
        remote: "origin",
        branch: "main",
        hasLocal: true,
        committerDate: 2,
        headShort: "aaa",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  validateMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("NewBranchDialog", () => {
  it("offers the current branch first as the base, then the rest", () => {
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={vi.fn()} onClose={vi.fn()} />,
    );
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["main", "dev", "origin/main"]);
  });

  it("cannot create until a name is typed", () => {
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Create branch" })).toBeDisabled();
  });

  it("reports the name and the chosen base", () => {
    const onCreate = vi.fn();
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={onCreate} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "feature/x" } });
    fireEvent.change(screen.getByLabelText("Based on"), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    expect(onCreate).toHaveBeenCalledWith("feature/x", "dev");
  });

  it("trims the name before reporting it", () => {
    const onCreate = vi.fn();
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={onCreate} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  spaced  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    expect(onCreate).toHaveBeenCalledWith("spaced", "main");
  });

  it("offers no base in a repo with no commits, and creates without one", () => {
    const onCreate = vi.fn();
    render(
      <NewBranchDialog
        state={state({ unborn: true, locals: [], remotes: [] })}
        repoRoot="/r"
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Based on")).not.toBeInTheDocument();
    expect(screen.getByText(/no commits yet/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    // Passing a base here would make git fail.
    expect(onCreate).toHaveBeenCalledWith("first", undefined);
  });

  it("offers the sha as the base on a detached HEAD", () => {
    render(
      <NewBranchDialog
        state={state({ current: null, detachedSha: "abc1234" })}
        repoRoot="/r"
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "abc1234",
      "main",
      "dev",
      "origin/main",
    ]);
  });

  it("submits on Enter in the name field", () => {
    const onCreate = vi.fn();
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={onCreate} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "quick" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith("quick", "main");
  });

  it("shows git's verdict on an unusable name and blocks creating it", async () => {
    validateMock.mockResolvedValue("a branch named 'main' already exists");
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "main" } });

    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/already exists/),
    );
    expect(screen.getByRole("button", { name: "Create branch" })).toBeDisabled();
  });

  it("debounces validation instead of shelling out on every keystroke", async () => {
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={vi.fn()} onClose={vi.fn()} />,
    );
    const field = screen.getByLabelText("Name");
    fireEvent.change(field, { target: { value: "f" } });
    fireEvent.change(field, { target: { value: "fe" } });
    fireEvent.change(field, { target: { value: "fea" } });
    expect(validateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock).toHaveBeenCalledWith("/r", "fea");
  });

  it("discards a verdict the moment the name changes again", async () => {
    validateMock.mockResolvedValue("'bad name' is not a valid branch name");
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={vi.fn()} onClose={vi.fn()} />,
    );
    const field = screen.getByLabelText("Name");
    fireEvent.change(field, { target: { value: "bad name" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // A stale complaint about text the user has already edited would be worse
    // than showing nothing.
    validateMock.mockResolvedValue(null);
    fireEvent.change(field, { target: { value: "good" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays submittable when validation itself fails", async () => {
    // The create call validates again and reports properly, so a validation
    // outage must not block the user.
    validateMock.mockRejectedValue(new Error("ipc died"));
    render(
      <NewBranchDialog state={state()} repoRoot="/r" onCreate={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "feature" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByRole("button", { name: "Create branch" })).toBeEnabled();
  });
});

describe("DirtySwitchDialog", () => {
  it("offers the GitHub Desktop choice, naming both branches", () => {
    render(
      <DirtySwitchDialog
        from="main"
        to="dev"
        changeCount={3}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 changes that are not committed to main/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bring my changes to dev" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave my changes on main" })).toBeInTheDocument();
  });

  it("says one change in the singular", () => {
    render(
      <DirtySwitchDialog
        from="main"
        to="dev"
        changeCount={1}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 change that is not|1 change /)).toBeInTheDocument();
  });

  it("reports bring and leave as the matching policy", () => {
    const onChoose = vi.fn();
    render(
      <DirtySwitchDialog
        from="main"
        to="dev"
        changeCount={2}
        onChoose={onChoose}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bring my changes to dev" }));
    expect(onChoose).toHaveBeenLastCalledWith("bring");
    fireEvent.click(screen.getByRole("button", { name: "Leave my changes on main" }));
    expect(onChoose).toHaveBeenLastCalledWith("leave");
  });

  it("explains that leaving them brings them back later", () => {
    render(
      <DirtySwitchDialog
        from="main"
        to="dev"
        changeCount={2}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/come back automatically/)).toBeInTheDocument();
  });

  it("cancels without choosing", () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(
      <DirtySwitchDialog
        from="main"
        to="dev"
        changeCount={2}
        onChoose={onChoose}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe("RenameBranchDialog", () => {
  it("starts from the current name with Rename disabled", () => {
    render(<RenameBranchDialog from="main" repoRoot="/r" onRename={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("New name")).toHaveValue("main");
    // The unchanged name is a no-op, not an error.
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
  });

  it("does not validate the unchanged name", async () => {
    render(<RenameBranchDialog from="main" repoRoot="/r" onRename={vi.fn()} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(300);
    // It would come back as "already exists", which is nonsense here.
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("reports the new name", () => {
    const onRename = vi.fn();
    render(<RenameBranchDialog from="main" repoRoot="/r" onRename={onRename} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "trunk" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledWith("trunk");
  });

  it("blocks a name git rejects", async () => {
    validateMock.mockResolvedValue("'bad name' is not a valid branch name");
    render(<RenameBranchDialog from="main" repoRoot="/r" onRename={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "bad name" } });
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
  });
});

describe("DeleteBranchDialog", () => {
  it("asks plainly on the first attempt and deletes without force", () => {
    const onDelete = vi.fn();
    render(
      <DeleteBranchDialog name="doomed" refusal={null} onDelete={onDelete} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: "Delete doomed?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(false);
  });

  it("escalates with git's reason once git has refused", () => {
    const onDelete = vi.fn();
    render(
      <DeleteBranchDialog
        name="doomed"
        refusal="error: the branch 'doomed' is not fully merged"
        onDelete={onDelete}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Delete doomed anyway?" })).toBeInTheDocument();
    expect(screen.getByText(/not fully merged/)).toBeInTheDocument();
    expect(screen.getByText(/will discard them/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(onDelete).toHaveBeenCalledWith(true);
  });
});

describe("OpErrorDialog", () => {
  const error = {
    title: "push failed",
    detail: "! [rejected] main -> main (fetch first)",
    command: "git push origin main",
  };

  it("shows git's stderr verbatim", () => {
    render(<OpErrorDialog error={error} onClose={vi.fn()} onRetryInTerminal={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "push failed" })).toBeInTheDocument();
    expect(screen.getByText("! [rejected] main -> main (fetch first)")).toBeInTheDocument();
  });

  it("copies the stderr to the clipboard and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<OpErrorDialog error={error} onClose={vi.fn()} onRetryInTerminal={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(error.detail);
  });

  it("stays usable when the clipboard is unavailable", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<OpErrorDialog error={error} onClose={vi.fn()} onRetryInTerminal={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await vi.advanceTimersByTimeAsync(0);
    // The text is on screen and selectable; nothing worth interrupting for.
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("offers to retry the command in the terminal", () => {
    const onRetryInTerminal = vi.fn();
    render(
      <OpErrorDialog error={error} onClose={vi.fn()} onRetryInTerminal={onRetryInTerminal} />,
    );
    expect(screen.getByText(/enter a passphrase or token/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry in terminal" }));
    expect(onRetryInTerminal).toHaveBeenCalledWith("git push origin main");
  });

  it("hides the retry option for failures that map to no command", () => {
    // A failed branch switch, for instance: there is nothing useful to re-run.
    render(
      <OpErrorDialog
        error={{ title: "Could not switch to dev", detail: "would be overwritten", command: "" }}
        onClose={vi.fn()}
        onRetryInTerminal={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Retry in terminal" })).not.toBeInTheDocument();
  });
});
