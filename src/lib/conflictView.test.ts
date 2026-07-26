import { describe, expect, it } from "vitest";
import {
  binaryConflictActions,
  conflictActions,
  conflictLabel,
  conflictOurSide,
} from "./conflictView";
import type { ConflictKind } from "./gitStatus";

const ALL_KINDS: ConflictKind[] = [
  "bothModified",
  "bothAdded",
  "bothDeleted",
  "addedByUs",
  "addedByThem",
  "deletedByUs",
  "deletedByThem",
  "unknown",
];

describe("conflictLabel", () => {
  it("describes every kind without falling back to the raw code", () => {
    for (const kind of ALL_KINDS) {
      const label = conflictLabel(kind);
      expect(label).not.toBe("");
      expect(label).not.toBe(kind);
    }
  });
});

describe("conflictOurSide", () => {
  it("answers for every kind, with no silent default", () => {
    for (const kind of ALL_KINDS) {
      expect(["present", "absent", "unknown"]).toContain(conflictOurSide(kind));
    }
  });

  it("says our side is absent exactly where HEAD does not have the path", () => {
    // From the `u XY` table: X is our side, so D (we deleted it) and a two-sided
    // add mean HEAD has nothing to restore. Rolling such a path back therefore
    // deletes the file, which is what the confirmation has to say.
    expect(conflictOurSide("deletedByUs")).toBe("absent");
    expect(conflictOurSide("bothDeleted")).toBe("absent");
    expect(conflictOurSide("addedByThem")).toBe("absent");
    expect(conflictOurSide("bothAdded")).toBe("absent");

    expect(conflictOurSide("bothModified")).toBe("present");
    expect(conflictOurSide("addedByUs")).toBe("present");
    expect(conflictOurSide("deletedByThem")).toBe("present");

    // An XY git has never documented: say so rather than guess, since the answer
    // decides between restoring and deleting.
    expect(conflictOurSide("unknown")).toBe("unknown");
  });
});

describe("conflictActions", () => {
  it("offers nothing for the kinds resolved hunk by hunk", () => {
    // Marker conflicts go to the merge window. A whole-file button beside them
    // would be a one-click way to discard the other side by accident.
    expect(conflictActions("bothModified")).toEqual([]);
    expect(conflictActions("bothAdded")).toEqual([]);
  });

  it("only offers the side that exists on a delete/modify conflict", () => {
    // They deleted it, we changed it: there is no "theirs" content to keep.
    const theirs = conflictActions("deletedByThem").map((a) => a.resolution);
    expect(theirs).toEqual(["keepOurs", "acceptDeletion"]);

    // And the mirror image.
    const ours = conflictActions("deletedByUs").map((a) => a.resolution);
    expect(ours).toEqual(["keepTheirs", "acceptDeletion"]);
  });

  it("offers only the deletion when both sides deleted the file", () => {
    const actions = conflictActions("bothDeleted");
    expect(actions.map((a) => a.resolution)).toEqual(["acceptDeletion"]);
    expect(actions[0].destructive).toBe(true);
  });

  it("keeps the added side for a one-sided add", () => {
    expect(conflictActions("addedByUs").map((a) => a.resolution)).toEqual([
      "keepOurs",
      "acceptDeletion",
    ]);
    expect(conflictActions("addedByThem").map((a) => a.resolution)).toEqual([
      "keepTheirs",
      "acceptDeletion",
    ]);
  });

  it("offers every route for an XY git has not documented", () => {
    // Guessing wrong and offering nothing would strand the merge; git refuses
    // what does not apply and says why.
    expect(conflictActions("unknown").map((a) => a.resolution)).toEqual([
      "keepOurs",
      "keepTheirs",
      "acceptDeletion",
    ]);
  });

  it("marks only the file-removing action as destructive", () => {
    for (const kind of ALL_KINDS) {
      for (const action of conflictActions(kind)) {
        expect(action.destructive ?? false).toBe(action.resolution === "acceptDeletion");
      }
    }
  });

  it("labels and describes every action it offers", () => {
    for (const kind of ALL_KINDS) {
      for (const action of conflictActions(kind)) {
        expect(action.label).not.toBe("");
        expect(action.title).not.toBe("");
      }
    }
  });
});

describe("binaryConflictActions", () => {
  it("offers both whole sides and never a deletion", () => {
    // A binary conflict has content on both sides; neither can be shown as text.
    // Deleting is not a resolution anyone reached for here.
    expect(binaryConflictActions().map((a) => a.resolution)).toEqual(["keepOurs", "keepTheirs"]);
  });
});
