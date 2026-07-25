import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MergeBanner } from "./MergeBanner";
import { initialGitState, useGitStore } from "../store/gitStore";
import { mergeState } from "../test/factories";
import type { ConflictEntry } from "../lib/gitStatus";
import type { MergeKind, MergeState } from "../lib/gitMerge";
import type { BranchState } from "../lib/gitBranch";

function branchState(current: string | null = "main"): BranchState {
  return {
    current,
    detachedSha: null,
    unborn: false,
    upstream: null,
    upstreamGone: false,
    upstreamOnRemote: false,
    remote: null,
    ahead: 0,
    behind: 0,
    lastFetch: null,
    locals: [],
    remotes: [],
  };
}

function conflicts(...paths: string[]): ConflictEntry[] {
  return paths.map((path) => ({ path, kind: "bothModified" }));
}

function setup(options: {
  kind: MergeKind;
  state?: Partial<MergeState>;
  conflicts?: ConflictEntry[];
  current?: string | null;
}) {
  useGitStore.setState({
    mergeState: mergeState(options.kind, options.state),
    conflicts: options.conflicts ?? [],
    // `?? "main"` would defeat the detached-HEAD case, whose whole point is null.
    branch: branchState("current" in options ? options.current : "main"),
  });
  render(<MergeBanner />);
}

/** Claim the store's action, so a click can be asserted without touching IPC. */
function stubConcludeOp() {
  const concludeOp = vi.fn().mockResolvedValue(true);
  useGitStore.setState({ concludeOp });
  return concludeOp;
}

beforeEach(() => {
  useGitStore.setState(initialGitState);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MergeBanner", () => {
  it("renders nothing before the first read or with nothing in progress", () => {
    const { container } = render(<MergeBanner />);
    expect(container).toBeEmptyDOMElement();

    useGitStore.setState({ mergeState: mergeState("none") });
    const clean = render(<MergeBanner />);
    expect(clean.container).toBeEmptyDOMElement();
  });

  describe("a merge", () => {
    it("names both sides and counts the conflicts left", () => {
      setup({
        kind: "merge",
        state: { mergingRef: "feature" },
        conflicts: conflicts("a.ts", "b.ts"),
      });
      expect(screen.getByText("Merging feature into main")).toBeInTheDocument();
      expect(screen.getByText(/2 conflicts left/)).toBeInTheDocument();
    });

    it("says conflict in the singular", () => {
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: conflicts("a.ts") });
      expect(screen.getByText(/1 conflict left/)).toBeInTheDocument();
    });

    it("disables Continue while any conflict is left, and says why", () => {
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: conflicts("a.ts") });
      const button = screen.getByRole("button", { name: "Continue" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringMatching(/resolve every conflict/i));
    });

    it("enables Continue once every conflict is resolved", () => {
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: [] });
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      expect(screen.getByText(/all conflicts resolved/i)).toBeInTheDocument();
    });

    it("continues through the store", () => {
      const concludeOp = stubConcludeOp();
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: [] });

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      expect(concludeOp).toHaveBeenCalledWith("continue");
    });

    it("offers no Skip at all, rather than a permanently disabled one", () => {
      // `git merge --skip` does not exist. A greyed button invites the question of
      // why it is there.
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: [] });
      expect(screen.queryByRole("button", { name: /skip/i })).not.toBeInTheDocument();
    });

    it("disables the actions while another git operation is running", () => {
      useGitStore.setState({ op: { id: "op-1", kind: "fetch", progress: "" } });
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: [] });
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Abort…" })).toBeDisabled();
    });

    it("confirms before aborting, and does not abort when the confirm is dismissed", () => {
      const concludeOp = stubConcludeOp();
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: conflicts("a.ts") });

      fireEvent.click(screen.getByRole("button", { name: "Abort…" }));

      // The confirm has to say what is lost: git restores the pre-merge tree,
      // which undoes every resolution made so far.
      expect(screen.getByRole("dialog")).toHaveTextContent(/already resolved will be discarded/i);
      expect(concludeOp).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /keep going/i }));
      expect(concludeOp).not.toHaveBeenCalled();
    });

    it("aborts once the confirm is accepted", () => {
      const concludeOp = stubConcludeOp();
      setup({ kind: "merge", state: { mergingRef: "feature" }, conflicts: conflicts("a.ts") });

      fireEvent.click(screen.getByRole("button", { name: "Abort…" }));
      fireEvent.click(screen.getByRole("button", { name: /abort merge/i }));

      expect(concludeOp).toHaveBeenCalledWith("abort");
    });

    it("still reads sensibly on a detached HEAD", () => {
      // `current` is null there, so the sentence must not say "into null".
      setup({ kind: "merge", state: { mergingRef: "feature" }, current: null });
      expect(screen.getByText("Merging feature into this branch")).toBeInTheDocument();
    });

    it("falls back to a phrase when there is no name for the merged ref", () => {
      setup({ kind: "merge" });
      expect(screen.getByText("Merging another branch into main")).toBeInTheDocument();
    });
  });

  describe("a rebase", () => {
    it("names the branch, where it is going, and how far through it is", () => {
      setup({
        kind: "rebase",
        state: { mergingRef: "feature", onto: "main", progress: { current: 3, total: 7 } },
        conflicts: conflicts("a.ts"),
      });
      expect(screen.getByText("Rebasing feature onto main")).toBeInTheDocument();
      expect(screen.getByText(/commit 3 of 7/)).toBeInTheDocument();
    });

    it("drives it rather than pointing at the terminal", () => {
      // Part 6 named a rebase and stopped, because `merge --continue` is the wrong
      // command. Part 7 sends an action and lets the backend pick the argv.
      const concludeOp = stubConcludeOp();
      setup({ kind: "rebase", state: { mergingRef: "feature", onto: "main" }, conflicts: [] });

      expect(screen.queryByText(/finish it in the terminal/i)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(concludeOp).toHaveBeenCalledWith("continue");
    });

    it("offers Skip, behind a confirm that says the commit is dropped", () => {
      const concludeOp = stubConcludeOp();
      setup({
        kind: "rebase",
        state: { mergingRef: "feature", onto: "main", subject: "Tidy the imports" },
        conflicts: conflicts("a.ts"),
      });

      fireEvent.click(screen.getByRole("button", { name: "Skip…" }));
      // "Skip" sounds like skipping the conflict; the dialog has to correct that.
      expect(screen.getByRole("dialog")).toHaveTextContent(/dropped, not merged/i);
      expect(concludeOp).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /drop commit/i }));
      expect(concludeOp).toHaveBeenCalledWith("skip");
    });

    it("says the rebase, not the merge, is what Abort throws away", () => {
      setup({ kind: "rebase", state: { mergingRef: "feature" }, conflicts: [] });
      fireEvent.click(screen.getByRole("button", { name: "Abort…" }));
      expect(screen.getByRole("dialog")).toHaveTextContent(/abort the rebase\?/i);
    });

    it("reads sensibly with no progress counter available", () => {
      // Every one of those state files is read best-effort: a banner without its
      // counter beats a banner that fails to render mid-rebase.
      setup({ kind: "rebase", state: { mergingRef: "feature", onto: "main" } });
      expect(screen.getByText("Rebasing feature onto main")).toBeInTheDocument();
      expect(screen.queryByText(/commit \d+ of/)).not.toBeInTheDocument();
    });

    it("reads sensibly with no branch name, as on a detached rebase", () => {
      setup({ kind: "rebase" });
      expect(screen.getByText("Rebasing this branch")).toBeInTheDocument();
    });
  });

  describe("a cherry-pick and a revert", () => {
    it("names the commit by its subject", () => {
      setup({ kind: "cherryPick", state: { subject: "Fix the parser", mergingRef: "abc12345" } });
      expect(screen.getByText("Cherry-picking “Fix the parser”")).toBeInTheDocument();
    });

    it("falls back to the sha when there is no subject", () => {
      setup({ kind: "cherryPick", state: { mergingRef: "abc12345" } });
      expect(screen.getByText("Cherry-picking abc12345")).toBeInTheDocument();
    });

    it("names a revert and drives it", () => {
      const concludeOp = stubConcludeOp();
      setup({ kind: "revert", state: { subject: "Add the flag" }, conflicts: [] });
      expect(screen.getByText("Reverting “Add the flag”")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(concludeOp).toHaveBeenCalledWith("continue");
    });
  });

  it("offers no buttons for conflicts that came from a stash restore", () => {
    // There is no operation to conclude in this state, so any button would be a
    // guaranteed failure.
    setup({ kind: "conflictsOnly", conflicts: conflicts("a.ts") });
    expect(screen.getByText("Unresolved conflicts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip…" })).not.toBeInTheDocument();
    expect(screen.getByText(/restoring stashed changes/i)).toBeInTheDocument();
  });
});
