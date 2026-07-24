import { describe, expect, it } from "vitest";
import { baseOptions, branchLabel, fetchAgeLabel, filterBranches } from "./branchView";
import type { BranchState, LocalBranch, RemoteBranch } from "./gitBranch";

function local(name: string, upstream?: string): LocalBranch {
  return { name, upstream, committerDate: 1, headShort: "aaa" };
}

function remote(name: string, hasLocal = false): RemoteBranch {
  const [remoteName, ...rest] = name.split("/");
  return {
    name,
    remote: remoteName,
    branch: rest.join("/"),
    hasLocal,
    committerDate: 1,
    headShort: "aaa",
  };
}

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
    locals: [],
    remotes: [],
    ...overrides,
  };
}

describe("filterBranches", () => {
  it("returns every local and remote-only branch when the query is empty", () => {
    const result = filterBranches(
      state({ locals: [local("main"), local("dev")], remotes: [remote("origin/other")] }),
      "",
    );
    expect(result.locals.map((b) => b.name)).toEqual(["main", "dev"]);
    expect(result.remotes.map((b) => b.name)).toEqual(["origin/other"]);
  });

  it("hides a remote branch that already has a local counterpart", () => {
    // origin/main and main are the same branch; only the local row can be
    // switched to directly, so the remote one would be a confusing duplicate.
    const result = filterBranches(
      state({
        locals: [local("main", "origin/main")],
        remotes: [remote("origin/main", true), remote("origin/solo")],
      }),
      "",
    );
    expect(result.remotes.map((b) => b.name)).toEqual(["origin/solo"]);
  });

  it("matches case-insensitively on any part of the name", () => {
    const input = state({
      locals: [local("feature/Login"), local("main")],
      remotes: [remote("origin/feature/logout")],
    });
    const result = filterBranches(input, "LOGIN");
    expect(result.locals.map((b) => b.name)).toEqual(["feature/Login"]);
    expect(result.remotes).toEqual([]);

    const partial = filterBranches(input, "log");
    expect(partial.locals.map((b) => b.name)).toEqual(["feature/Login"]);
    expect(partial.remotes.map((b) => b.name)).toEqual(["origin/feature/logout"]);
  });

  it("treats a whitespace-only query as empty rather than matching nothing", () => {
    const result = filterBranches(state({ locals: [local("main")] }), "   ");
    expect(result.locals).toHaveLength(1);
  });

  it("returns nothing when no branch matches", () => {
    const result = filterBranches(state({ locals: [local("main")] }), "nope");
    expect(result.locals).toEqual([]);
    expect(result.remotes).toEqual([]);
  });
});

describe("baseOptions", () => {
  it("puts the current branch first, then the other locals, then remotes", () => {
    const options = baseOptions(
      state({
        current: "dev",
        locals: [local("main"), local("dev"), local("spike")],
        remotes: [remote("origin/main")],
      }),
    );
    expect(options).toEqual(["dev", "main", "spike", "origin/main"]);
  });

  it("does not list the current branch twice", () => {
    const options = baseOptions(state({ current: "main", locals: [local("main")] }));
    expect(options).toEqual(["main"]);
  });

  it("offers the sha first on a detached HEAD", () => {
    // Without it the dialog would silently base the new branch off some
    // unrelated local branch instead of where the user actually is.
    const options = baseOptions(
      state({ current: null, detachedSha: "abc1234", locals: [local("main")] }),
    );
    expect(options).toEqual(["abc1234", "main"]);
  });

  it("offers nothing in a repo with no commits", () => {
    // `git switch -c x main` fails when main has no commit, while a bare
    // `git switch -c x` works — so the caller must pass no base at all.
    const options = baseOptions(state({ unborn: true, current: "main", locals: [] }));
    expect(options).toEqual([]);
  });
});

describe("fetchAgeLabel", () => {
  const now = 1_700_000_000_000; // ms

  it("reports never when nothing has been fetched", () => {
    expect(fetchAgeLabel(null, now)).toBe("never fetched");
    // Even before `now` has been sampled: the answer does not depend on it.
    expect(fetchAgeLabel(null, null)).toBe("never fetched");
  });

  it("returns null until now has been sampled", () => {
    // The caller samples Date.now() on hover, so before that there is no age to
    // report and the tooltip omits it.
    expect(fetchAgeLabel(1_700_000_000, null)).toBeNull();
  });

  it("scales from seconds to days", () => {
    const seconds = now / 1000;
    expect(fetchAgeLabel(seconds - 5, now)).toBe("fetched just now");
    expect(fetchAgeLabel(seconds - 59, now)).toBe("fetched just now");
    expect(fetchAgeLabel(seconds - 60, now)).toBe("fetched 1m ago");
    expect(fetchAgeLabel(seconds - 12 * 60, now)).toBe("fetched 12m ago");
    expect(fetchAgeLabel(seconds - 3600, now)).toBe("fetched 1h ago");
    expect(fetchAgeLabel(seconds - 5 * 3600, now)).toBe("fetched 5h ago");
    expect(fetchAgeLabel(seconds - 24 * 3600, now)).toBe("fetched 1d ago");
    expect(fetchAgeLabel(seconds - 9 * 24 * 3600, now)).toBe("fetched 9d ago");
  });

  it("clamps a future timestamp instead of reporting a negative age", () => {
    // Clock skew, or a repo copied from a machine that is ahead.
    expect(fetchAgeLabel(now / 1000 + 500, now)).toBe("fetched just now");
  });
});

describe("branchLabel", () => {
  it("uses the branch name when there is one", () => {
    expect(branchLabel(state({ current: "main" }))).toBe("main");
  });

  it("shows the sha for a detached HEAD", () => {
    expect(branchLabel(state({ current: null, detachedSha: "abc1234" }))).toBe("HEAD @ abc1234");
  });

  it("falls back to a plain label when there is neither", () => {
    expect(branchLabel(state({ current: null, detachedSha: null }))).toBe("no branch");
  });
});
