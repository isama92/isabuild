import { describe, expect, it } from "vitest";
import {
  changeLabel,
  conflictTooltip,
  copyValues,
  entryTooltip,
  fileMenuItems,
  rollbackDeletes,
  rollbackDescription,
  type FileAction,
  type FileMenuItem,
  type FileTarget,
} from "./fileActions";
import type { ChangeStatus, ConflictKind } from "./gitStatus";

const ALL_STATUSES: ChangeStatus[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typeChanged",
  "untracked",
];

/** The flat list of actions a menu offers, submenu leaves included. */
function actionsOf(items: FileMenuItem[]): FileAction[] {
  return items.flatMap((item) =>
    item.kind === "action" ? [item.action] : item.items.map((leaf) => leaf.action),
  );
}

function target(overrides: Partial<FileTarget> = {}): FileTarget {
  return { path: "src/app.ts", group: "unstaged", status: "modified", ...overrides };
}

describe("changeLabel", () => {
  it("describes every status in prose rather than the enum word", () => {
    for (const status of ALL_STATUSES) {
      expect(changeLabel(status)).not.toBe("");
    }
    // The one status whose enum name is not readable: it reaches the badge's
    // aria-label, so it cannot stay camelCase.
    expect(changeLabel("typeChanged")).toBe("type changed");
  });
});

describe("entryTooltip", () => {
  it("leads with the change and keeps the path", () => {
    expect(entryTooltip({ path: "app/Models/User.php", status: "deleted" }, false)).toBe(
      "deleted: app/Models/User.php",
    );
  });

  it("says staged for a row from the staged group", () => {
    expect(entryTooltip({ path: "app/Models/Flight.php", status: "modified" }, true)).toBe(
      "staged modified: app/Models/Flight.php",
    );
  });

  it("keeps both facts, so a file staged and modified again reads correctly", () => {
    // git reports such a file twice, once in each group; "staged" alone would
    // make the two rows indistinguishable.
    const entry = { path: "src/app.ts", status: "modified" as ChangeStatus };
    expect(entryTooltip(entry, true)).toBe("staged modified: src/app.ts");
    expect(entryTooltip(entry, false)).toBe("modified: src/app.ts");
  });

  it("keeps the rename origin", () => {
    expect(
      entryTooltip({ path: "new.ts", origPath: "old.ts", status: "renamed" }, true),
    ).toBe("staged renamed: old.ts → new.ts");
  });
});

describe("conflictTooltip", () => {
  it("leads with the state and names the kind in the same words as the row", () => {
    expect(conflictTooltip({ path: "app/Models/Order.php", kind: "bothModified" })).toBe(
      "conflict (both changed this): app/Models/Order.php",
    );
  });
});

describe("fileMenuItems", () => {
  it("offers Add on an unstaged row and Unstage on a staged one", () => {
    expect(actionsOf(fileMenuItems(target({ group: "unstaged" }), false))).toContain("stage");
    expect(actionsOf(fileMenuItems(target({ group: "unstaged" }), false))).not.toContain(
      "unstage",
    );
    expect(actionsOf(fileMenuItems(target({ group: "staged" }), false))).toContain("unstage");
    expect(actionsOf(fileMenuItems(target({ group: "staged" }), false))).not.toContain("stage");
  });

  it("always offers the three copy forms", () => {
    for (const group of ["staged", "unstaged", "conflicts"] as const) {
      const actions = actionsOf(fileMenuItems(target({ group }), false));
      expect(actions).toEqual(
        expect.arrayContaining(["copyRelative", "copyAbsolute", "copyName"]),
      );
    }
  });

  it("offers a conflicted row only rollback and the copy forms", () => {
    // Committing a pathspec mid-merge is refused by git, and staging a file with
    // markers still in it marks it resolved with the markers in the source.
    const items = fileMenuItems(target({ group: "conflicts", status: undefined }), true);
    expect(actionsOf(items)).toEqual([
      "rollback",
      "copyRelative",
      "copyAbsolute",
      "copyName",
    ]);
  });

  it("disables Commit while an operation is in progress, with a reason", () => {
    const commit = fileMenuItems(target(), true).find(
      (item) => item.kind === "action" && item.action === "commit",
    );
    expect(commit).toBeDefined();
    expect(commit?.kind === "action" && commit.disabledReason).toBeTruthy();
  });

  it("leaves Commit usable when nothing is in progress", () => {
    const commit = fileMenuItems(target(), false).find(
      (item) => item.kind === "action" && item.action === "commit",
    );
    expect(commit?.kind === "action" && commit.disabledReason).toBeUndefined();
  });

  it("marks rollback destructive and nothing else", () => {
    const destructive = fileMenuItems(target(), false).filter(
      (item) => item.kind === "action" && item.destructive,
    );
    expect(destructive).toHaveLength(1);
    expect(destructive[0].kind === "action" && destructive[0].action).toBe("rollback");
  });
});

describe("rollbackDescription", () => {
  it("says a tracked change is restored from the current commit", () => {
    const text = rollbackDescription(target({ status: "modified" }));
    expect(text).toContain("src/app.ts");
    expect(text).toMatch(/restore/i);
    expect(text).toMatch(/cannot be undone/i);
    // "Current", not "last": mid-rebase, mid-cherry-pick and mid-revert, HEAD is
    // the commit being replayed onto, not the newest thing the user wrote.
    expect(text).not.toMatch(/last commit/i);
  });

  it("says an untracked file is deleted, because there is nothing to restore", () => {
    const text = rollbackDescription(target({ path: "notes.md", status: "untracked" }));
    expect(text).toMatch(/^Delete notes\.md\?/);
    expect(text).toMatch(/not in git/i);
  });

  it("warns that an untracked directory takes its contents with it", () => {
    // One collapsed row, a whole subtree removed.
    const text = rollbackDescription(target({ path: "generated/", status: "untracked" }));
    expect(text).toMatch(/everything in it/i);
  });

  it("says a never-committed staged file is deleted rather than reverted", () => {
    const text = rollbackDescription(target({ path: "new.ts", group: "staged", status: "added" }));
    expect(text).toMatch(/never been committed/i);
    expect(text).toMatch(/deleted/i);
  });

  it("names both halves of a rename", () => {
    const text = rollbackDescription(
      target({ path: "new.ts", origPath: "old.ts", group: "staged", status: "renamed" }),
    );
    expect(text).toContain("old.ts is restored");
    expect(text).toContain("new.ts is deleted");
  });

  it("says a copy's origin is left alone", () => {
    const text = rollbackDescription(
      target({ path: "copy.ts", origPath: "src.ts", group: "staged", status: "copied" }),
    );
    expect(text).toContain("src.ts is left alone");
  });

  it("says a conflicted file abandons its merge and takes our side", () => {
    const text = rollbackDescription(
      target({ path: "file.txt", group: "conflicts", status: undefined, kind: "bothModified" }),
    );
    expect(text).toMatch(/abandon the merge for file\.txt/i);
    expect(text).toMatch(/your committed version of file\.txt is restored/i);
  });

  it("says a conflicted file is deleted when our own side does not have it", () => {
    // `deletedByUs` (git DU): we deleted it, they changed it. Taking our side
    // means removing the file, so promising a restore would be a lie about an
    // irreversible action.
    for (const kind of ["deletedByUs", "bothDeleted", "addedByThem"] as const) {
      const text = rollbackDescription(
        target({ path: "file.txt", group: "conflicts", status: undefined, kind }),
      );
      expect(text).toMatch(/file\.txt is deleted/i);
      expect(text).not.toMatch(/is restored/i);
    }
  });

  it("hedges for an XY git has never documented", () => {
    const text = rollbackDescription(
      target({ path: "file.txt", group: "conflicts", status: undefined, kind: "unknown" }),
    );
    expect(text).toMatch(/which deletes it if that commit does not have it/i);
  });
});

describe("rollbackDeletes", () => {
  it("is true only for the rows the current commit does not have", () => {
    expect(rollbackDeletes(target({ status: "untracked" }))).toBe(true);
    expect(rollbackDeletes(target({ status: "added" }))).toBe(true);
    // HEAD has the origin, not the copy.
    expect(rollbackDeletes(target({ status: "copied", origPath: "src.ts" }))).toBe(true);

    expect(rollbackDeletes(target({ status: "modified" }))).toBe(false);
    expect(rollbackDeletes(target({ status: "deleted" }))).toBe(false);
    expect(rollbackDeletes(target({ status: "typeChanged" }))).toBe(false);
    // A rename restores the origin, so it is not a pure delete.
    expect(rollbackDeletes(target({ status: "renamed", origPath: "old.ts" }))).toBe(false);
  });

  it("follows the conflict kind, which is the only thing that says", () => {
    const conflict = (kind: ConflictKind) =>
      rollbackDeletes(target({ group: "conflicts", status: undefined, kind }));

    expect(conflict("deletedByUs")).toBe(true);
    expect(conflict("bothDeleted")).toBe(true);
    expect(conflict("addedByThem")).toBe(true);

    expect(conflict("bothModified")).toBe(false);
    expect(conflict("addedByUs")).toBe(false);
    expect(conflict("deletedByThem")).toBe(false);
    // Unknown reads as a restore, and the wording says it could go either way.
    expect(conflict("unknown")).toBe(false);
  });

  it("describes every status without falling through to a bare path", () => {
    for (const status of ALL_STATUSES) {
      const text = rollbackDescription(target({ status }));
      expect(text.length).toBeGreaterThan("src/app.ts".length);
      expect(text.endsWith("?") || text.includes("? ")).toBe(true);
    }
  });
});

describe("copyValues", () => {
  it("keeps the relative path exactly as git reports it", () => {
    const values = copyValues("/home/me/repo", "app/Models/Order.php");
    expect(values.relative).toBe("app/Models/Order.php");
    expect(values.absolute).toBe("/home/me/repo/app/Models/Order.php");
    expect(values.name).toBe("Order.php");
  });

  it("uses backslashes for the absolute path on Windows, and slashes for the relative one", () => {
    // git rev-parse --show-toplevel reports forward slashes on Windows too, so
    // the drive prefix is the only signal — and an absolute path is for Explorer.
    const values = copyValues("C:/Users/me/repo", "app/Models/Order.php");
    expect(values.absolute).toBe("C:\\Users\\me\\repo\\app\\Models\\Order.php");
    expect(values.relative).toBe("app/Models/Order.php");
    expect(values.name).toBe("Order.php");
  });

  it("handles a UNC repo root", () => {
    const values = copyValues("\\\\server\\share\\repo", "src/app.ts");
    expect(values.absolute).toBe("\\\\server\\share\\repo\\src\\app.ts");
  });

  it("trims the trailing slash git puts on a collapsed untracked directory", () => {
    // Without this the name would come back empty.
    const values = copyValues("/home/me/repo", "src/generated/");
    expect(values.relative).toBe("src/generated");
    expect(values.absolute).toBe("/home/me/repo/src/generated");
    expect(values.name).toBe("generated");
  });

  it("does not double the separator when the repo root has a trailing one", () => {
    expect(copyValues("/home/me/repo/", "src/app.ts").absolute).toBe(
      "/home/me/repo/src/app.ts",
    );
    expect(copyValues("C:/", "app.ts").absolute).toBe("C:\\app.ts");
  });

  it("returns the whole path as the name for a file at the repo root", () => {
    const values = copyValues("/home/me/repo", "README.md");
    expect(values.name).toBe("README.md");
    expect(values.relative).toBe("README.md");
  });
});
