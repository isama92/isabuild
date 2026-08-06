import { describe, expect, it } from "vitest";
import {
  changedFiles,
  indexOfPath,
  isStagedAndModified,
  reanchor,
  type ChangeGroups,
} from "./changedFiles";
import type { ChangeStatus, FileEntry } from "./gitStatus";

function entry(path: string, status: ChangeStatus = "modified", origPath?: string): FileEntry {
  return origPath === undefined ? { path, status } : { path, status, origPath };
}

function groups(staged: FileEntry[] = [], unstaged: FileEntry[] = []): ChangeGroups {
  return { staged, unstaged };
}

describe("changedFiles", () => {
  it("lists staged files before unstaged ones, as the panel does", () => {
    const files = changedFiles(groups([entry("s.ts")], [entry("u.ts")]));
    expect(files.map((file) => file.path)).toEqual(["s.ts", "u.ts"]);
  });

  it("keeps git's own order within each group", () => {
    // Nothing sorts: `git status --porcelain=v2` emits index order, and re-sorting
    // would make the counter disagree with the panel it is meant to match.
    const files = changedFiles(groups([entry("z.ts"), entry("a.ts")], [entry("m.ts")]));
    expect(files.map((file) => file.path)).toEqual(["z.ts", "a.ts", "m.ts"]);
  });

  it("counts a file that is staged and then changed again once", () => {
    // Two rows in the panel, deliberately. One diff, because the window shows HEAD
    // against the working tree either way.
    const files = changedFiles(groups([entry("both.ts")], [entry("both.ts")]));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "both.ts", staged: true, modified: true });
  });

  it("keeps a shared path at its staged position", () => {
    const files = changedFiles(
      groups([entry("a.ts"), entry("both.ts")], [entry("z.ts"), entry("both.ts")]),
    );
    expect(files.map((file) => file.path)).toEqual(["a.ts", "both.ts", "z.ts"]);
  });

  it("says which groups each file is in", () => {
    const files = changedFiles(groups([entry("s.ts")], [entry("u.ts")]));
    expect(files).toEqual([
      { path: "s.ts", origPath: undefined, staged: true, modified: false },
      { path: "u.ts", origPath: undefined, staged: false, modified: true },
    ]);
  });

  it("includes untracked files, which are diffable against an empty HEAD", () => {
    const files = changedFiles(groups([], [entry("new.ts", "untracked")]));
    expect(files.map((file) => file.path)).toEqual(["new.ts"]);
  });

  it("keeps a rename's origin, because the HEAD side is read from there", () => {
    const files = changedFiles(groups([entry("new.ts", "renamed", "old.ts")]));
    expect(files[0].origPath).toBe("old.ts");
  });

  it("takes the origin from whichever group carried it", () => {
    const files = changedFiles(
      groups([entry("new.ts", "renamed", "old.ts")], [entry("new.ts", "modified")]),
    );
    expect(files[0].origPath).toBe("old.ts");
  });

  it("produces nothing from a clean repository", () => {
    expect(changedFiles(groups())).toEqual([]);
  });
});

describe("indexOfPath", () => {
  it("finds a file", () => {
    expect(indexOfPath(changedFiles(groups([entry("a.ts"), entry("b.ts")])), "b.ts")).toBe(1);
  });

  it("reports -1 for a path the list no longer has", () => {
    expect(indexOfPath(changedFiles(groups([entry("a.ts")])), "gone.ts")).toBe(-1);
  });
});

describe("reanchor", () => {
  const three = changedFiles(groups([entry("a.ts"), entry("b.ts"), entry("c.ts")]));

  it("follows a file that only moved position", () => {
    // Something earlier was committed away, so the shown file is now index 0.
    const after = changedFiles(groups([entry("b.ts"), entry("c.ts")]));
    expect(reanchor(after, "b.ts", 1)).toBe(0);
  });

  it("holds the old slot when the shown file leaves the list", () => {
    // It was committed or reverted while open. The window stays put — a diff of an
    // unchanged file is a legitimate thing to be looking at — and Next lands on
    // whatever now occupies where it was.
    expect(reanchor(three, "gone.ts", 1)).toBe(1);
  });

  it("clamps to the end when the list shrank past the old slot", () => {
    const shorter = changedFiles(groups([entry("a.ts")]));
    expect(reanchor(shorter, "gone.ts", 5)).toBe(0);
  });

  it("clamps a negative previous index, for a window that never found itself", () => {
    expect(reanchor(three, "gone.ts", -1)).toBe(0);
  });

  it("has no answer for an empty list", () => {
    expect(reanchor([], "a.ts", 0)).toBe(-1);
  });
});

describe("isStagedAndModified", () => {
  it("is true only when both groups hold the path", () => {
    expect(isStagedAndModified(groups([entry("a.ts")], [entry("a.ts")]), "a.ts")).toBe(true);
  });

  it("is false when only one does", () => {
    expect(isStagedAndModified(groups([entry("a.ts")], []), "a.ts")).toBe(false);
    expect(isStagedAndModified(groups([], [entry("a.ts")]), "a.ts")).toBe(false);
  });

  it("is false for a path neither holds", () => {
    expect(isStagedAndModified(groups([entry("a.ts")], [entry("a.ts")]), "b.ts")).toBe(false);
  });
});
