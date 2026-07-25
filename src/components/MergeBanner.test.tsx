import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MergeBanner } from "./MergeBanner";
import { initialGitState, useGitStore } from "../store/gitStore";
import type { ConflictEntry } from "../lib/gitStatus";
import type { MergeKind } from "../lib/gitMerge";
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
  mergingRef?: string | null;
  conflicts?: ConflictEntry[];
  current?: string | null;
}) {
  useGitStore.setState({
    mergeState: { kind: options.kind, mergingRef: options.mergingRef ?? null },
    conflicts: options.conflicts ?? [],
    // `?? "main"` would defeat the detached-HEAD case, whose whole point is null.
    branch: branchState("current" in options ? options.current : "main"),
  });
  render(<MergeBanner />);
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

    useGitStore.setState({ mergeState: { kind: "none", mergingRef: null } });
    const clean = render(<MergeBanner />);
    expect(clean.container).toBeEmptyDOMElement();
  });

  it("names both sides of the merge and counts the conflicts left", () => {
    setup({ kind: "merge", mergingRef: "feature", conflicts: conflicts("a.ts", "b.ts") });
    expect(screen.getByText("Merging feature into main")).toBeInTheDocument();
    expect(screen.getByText(/2 conflicts left/)).toBeInTheDocument();
  });

  it("says conflict in the singular", () => {
    setup({ kind: "merge", mergingRef: "feature", conflicts: conflicts("a.ts") });
    expect(screen.getByText(/1 conflict left/)).toBeInTheDocument();
  });

  it("disables Continue while any conflict is left, and says why", () => {
    setup({ kind: "merge", mergingRef: "feature", conflicts: conflicts("a.ts") });
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/resolve every conflict/i));
  });

  it("enables Continue once every conflict is resolved", () => {
    setup({ kind: "merge", mergingRef: "feature", conflicts: [] });
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByText(/all conflicts resolved/i)).toBeInTheDocument();
  });

  it("continues the merge through the store", () => {
    const continueMerge = vi.fn().mockResolvedValue(true);
    useGitStore.setState({ continueMerge });
    setup({ kind: "merge", mergingRef: "feature", conflicts: [] });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(continueMerge).toHaveBeenCalled();
  });

  it("disables both actions while another git operation is running", () => {
    useGitStore.setState({ op: { id: "op-1", kind: "fetch", progress: "" } });
    setup({ kind: "merge", mergingRef: "feature", conflicts: [] });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abort" })).toBeDisabled();
  });

  it("confirms before aborting, and does not abort when the confirm is dismissed", () => {
    const abortMerge = vi.fn().mockResolvedValue(true);
    useGitStore.setState({ abortMerge });
    setup({ kind: "merge", mergingRef: "feature", conflicts: conflicts("a.ts") });

    fireEvent.click(screen.getByRole("button", { name: "Abort" }));

    // The confirm has to say what is lost: git restores the pre-merge tree,
    // which undoes every resolution made so far.
    expect(screen.getByRole("dialog")).toHaveTextContent(/already resolved will be discarded/i);
    expect(abortMerge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /keep merging/i }));
    expect(abortMerge).not.toHaveBeenCalled();
  });

  it("aborts once the confirm is accepted", () => {
    const abortMerge = vi.fn().mockResolvedValue(true);
    useGitStore.setState({ abortMerge });
    setup({ kind: "merge", mergingRef: "feature", conflicts: conflicts("a.ts") });

    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    fireEvent.click(screen.getByRole("button", { name: /abort merge/i }));

    expect(abortMerge).toHaveBeenCalled();
  });

  it("offers no Continue for conflicts that came from a stash restore", () => {
    // There is no merge to commit in this state, so a Continue button would be a
    // guaranteed failure.
    setup({ kind: "conflictsOnly", conflicts: conflicts("a.ts") });
    expect(screen.getByText("Unresolved conflicts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
    expect(screen.getByText(/restoring stashed changes/i)).toBeInTheDocument();
  });

  it("names a rebase and refuses to drive it", () => {
    // Reachable today: Part 5's bare pull honours pull.rebase. Offering
    // `git merge --continue` here would run the wrong command family.
    setup({ kind: "rebase", conflicts: conflicts("a.ts") });
    expect(screen.getByText("A rebase is in progress")).toBeInTheDocument();
    expect(screen.getByText(/finish it in the terminal/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
  });

  it("names a cherry-pick", () => {
    setup({ kind: "cherryPick" });
    expect(screen.getByText("A cherry-pick is in progress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("names a revert", () => {
    setup({ kind: "revert" });
    expect(screen.getByText("A revert is in progress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("still reads sensibly on a detached HEAD", () => {
    // `current` is null there, so the sentence must not say "into null".
    setup({ kind: "merge", mergingRef: "feature", current: null });
    expect(screen.getByText("Merging feature into this branch")).toBeInTheDocument();
  });

  it("falls back to a phrase when there is no name for the merged ref", () => {
    setup({ kind: "merge", mergingRef: null });
    expect(screen.getByText("Merging another branch into main")).toBeInTheDocument();
  });
});
