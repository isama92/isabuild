import { describe, expect, it, vi } from "vitest";
import {
  optionsForScope,
  resolveViewOptions,
  viewOptionItems,
  VIEW_OPTIONS,
} from "./viewOptions";

describe("VIEW_OPTIONS", () => {
  it("has no duplicate ids", () => {
    // An id is the key in config.json; two entries sharing one would make a
    // toggle move a button nobody clicked.
    const ids = VIEW_OPTIONS.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every option at least one scope", () => {
    // An option no window offers is a setting with no way to reach it.
    for (const option of VIEW_OPTIONS) {
      expect(option.scopes.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveViewOptions", () => {
  it("falls back to the default when the settings say nothing", () => {
    const state = resolveViewOptions({});
    expect(state["collapse-unchanged"]).toBe(false);
  });

  it("takes an override over the default", () => {
    expect(resolveViewOptions({ "collapse-unchanged": true })["collapse-unchanged"]).toBe(true);
  });

  it("ignores a value a hand-edited file got wrong", () => {
    // Same rule as resolveBindings: a bad entry falls back rather than leaving a
    // toggle that reads as on and behaves as off.
    const overrides = { "collapse-unchanged": "yes" } as unknown as Record<string, boolean>;
    expect(resolveViewOptions(overrides)["collapse-unchanged"]).toBe(false);
  });

  it("does not pass through an id the registry does not know", () => {
    // The stored map keeps it, so a newer build's option survives a downgrade;
    // what must not happen is a pane being handed an option it cannot honour.
    const state = resolveViewOptions({ "something-later": true });
    expect(state["something-later"]).toBeUndefined();
  });

  it("answers for every option in the registry", () => {
    const state = resolveViewOptions({});
    expect(Object.keys(state).sort()).toEqual(VIEW_OPTIONS.map((o) => o.id).sort());
  });
});

describe("optionsForScope", () => {
  it("offers the compact toggle in the diff window", () => {
    expect(optionsForScope("diff").map((option) => option.id)).toContain("collapse-unchanged");
  });

  it("offers nothing in the merge window yet", () => {
    // Collapsing there would be a different implementation wearing the same name:
    // three independent editors, not a MergeView.
    expect(optionsForScope("merge")).toEqual([]);
  });
});

describe("viewOptionItems", () => {
  it("turns the registry into one group of toggles", () => {
    const items = viewOptionItems("diff", { "collapse-unchanged": true }, vi.fn());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "group", id: "view-options" });
  });

  it("reflects the resolved state onto the toggle", () => {
    const [group] = viewOptionItems("diff", { "collapse-unchanged": true }, vi.fn());
    expect(group).toMatchObject({ kind: "group" });
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.items[0]).toMatchObject({ id: "collapse-unchanged", active: true });
  });

  it("toggles by id when its button is chosen", () => {
    const toggle = vi.fn();
    const [group] = viewOptionItems("diff", {}, toggle);
    if (group.kind !== "group") throw new Error("expected a group");
    group.items[0].onSelect();
    expect(toggle).toHaveBeenCalledWith("collapse-unchanged");
  });

  it("disables every toggle while the pane says it is busy", () => {
    const [group] = viewOptionItems("diff", {}, vi.fn(), true);
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.items.every((item) => item.disabled)).toBe(true);
  });

  it("produces nothing for a window that offers no options", () => {
    // An empty group would still paint a border and a gap.
    expect(viewOptionItems("merge", {}, vi.fn())).toEqual([]);
  });
});
