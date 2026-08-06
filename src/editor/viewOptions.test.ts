import { describe, expect, it, vi } from "vitest";
import {
  optionsForGroup,
  optionsForScope,
  renderViewOptions,
  resolveViewOptions,
  viewOptionItems,
  VIEW_OPTIONS,
  type ViewOption,
} from "./viewOptions";
import type { ToolbarGroup, ToolbarToggle } from "./EditorToolbar";

/** Narrow an item to a group, so a failure says which item was not one. */
function group(item: unknown): ToolbarGroup {
  const candidate = item as ToolbarGroup | undefined;
  if (candidate?.kind !== "group") {
    throw new Error(`expected a group, got ${String(candidate?.kind)}`);
  }
  return candidate;
}

/** A group's children as toggles, for the cases that read `active`. */
function toggles(item: unknown): ToolbarToggle[] {
  return group(item).items.map((child) => {
    if (child.kind !== "toggle") throw new Error(`expected a toggle, got ${child.kind}`);
    return child;
  });
}

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

  it("ignores a value that is not a boolean", () => {
    // Belt and braces rather than a reachable path from `config.json`: a string
    // there fails `BTreeMap<String, bool>` on the Rust side and takes the whole file
    // to `config.json.bak` long before this runs. The guard is here so a value
    // arriving from anywhere else cannot leave a toggle that reads as on and behaves
    // as off.
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

describe("optionsForGroup", () => {
  it("puts an option with no group of its own in the default cluster", () => {
    expect(optionsForGroup("diff", "view-options").map((option) => option.id)).toContain(
      "collapse-unchanged",
    );
  });

  it("leaves it out of every other cluster", () => {
    expect(optionsForGroup("diff", "view-mode").map((option) => option.id)).not.toContain(
      "collapse-unchanged",
    );
  });

  it("puts an option in the cluster it names", () => {
    expect(optionsForGroup("diff", "view-mode").map((option) => option.id)).toEqual([
      "unified-view",
    ]);
  });
});

describe("viewOptionItems", () => {
  it("turns the registry into one group of toggles", () => {
    const items = viewOptionItems("diff", { "collapse-unchanged": true }, vi.fn());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "group", id: "view-options" });
  });

  it("reflects the resolved state onto the toggle", () => {
    const [item] = viewOptionItems("diff", { "collapse-unchanged": true }, vi.fn());
    expect(group(item).items[0]).toMatchObject({ id: "collapse-unchanged", active: true });
  });

  it("asks for the opposite value when a toggle is chosen", () => {
    const set = vi.fn();
    const [item] = viewOptionItems("diff", {}, set);
    group(item).items[0].onSelect();
    expect(set).toHaveBeenCalledWith("collapse-unchanged", true);
  });

  it("disables every toggle while the pane says it is busy", () => {
    const [item] = viewOptionItems("diff", {}, vi.fn(), { disabled: true });
    expect(group(item).items.every((child) => child.disabled)).toBe(true);
  });

  it("produces nothing for a window that offers no options", () => {
    // An empty group would still paint a border and a gap.
    expect(viewOptionItems("merge", {}, vi.fn())).toEqual([]);
  });

  it("keeps the clusters apart, so a pane can place them at opposite ends", () => {
    // The whole reason `group` exists: Compact belongs on the left of the diff
    // toolbar and the view-mode pair on the right, and neither call may emit the
    // other's buttons.
    const left = viewOptionItems("diff", {}, vi.fn());
    const right = viewOptionItems("diff", {}, vi.fn(), { group: "view-mode" });

    expect(left.map((item) => group(item).id)).toEqual(["view-options"]);
    expect(group(left[0]).items.map((child) => child.id)).toEqual(["collapse-unchanged"]);
    expect(right.map((item) => group(item).id)).toEqual(["unified-view"]);
  });
});

describe("renderViewOptions", () => {
  // Fixtures rather than the registry: these are cases about how an option is
  // presented, and would otherwise break the day a real setting moved cluster.
  const toggle: ViewOption = {
    id: "fixture-toggle",
    label: "Compact",
    tooltip: "Hide unchanged lines",
    scopes: ["diff"],
    default: false,
  };
  const segmented: ViewOption = {
    id: "fixture-mode",
    label: "View mode",
    tooltip: "How the diff is laid out",
    scopes: ["diff"],
    default: false,
    control: {
      kind: "segmented",
      off: { label: "Split", tooltip: "Two panes" },
      on: { label: "Unified", tooltip: "One pane" },
    },
  };

  it("gives a segmented option a joined group of its own", () => {
    const [item] = renderViewOptions([segmented], {}, vi.fn());
    expect(group(item)).toMatchObject({ id: "fixture-mode", variant: "segmented" });
    expect(group(item).items.map((child) => child.label)).toEqual(["Split", "Unified"]);
  });

  it("presses exactly one face of a segmented pair", () => {
    const off = toggles(renderViewOptions([segmented], { "fixture-mode": false }, vi.fn())[0]);
    expect(off.map((child) => child.active)).toEqual([true, false]);

    const on = toggles(renderViewOptions([segmented], { "fixture-mode": true }, vi.fn())[0]);
    expect(on.map((child) => child.active)).toEqual([false, true]);
  });

  it("asks a segmented face for its own value, so the active one is a no-op", () => {
    // The bug this exists for: a face that flipped would make clicking Unified
    // twice go back to Split, which is not what a radio does.
    const set = vi.fn();
    const [item] = renderViewOptions([segmented], { "fixture-mode": true }, set);
    group(item).items[1].onSelect();
    expect(set).toHaveBeenCalledWith("fixture-mode", true);
  });

  it("keeps registry order when the two kinds are interleaved", () => {
    const items = renderViewOptions([toggle, segmented, { ...toggle, id: "after" }], {}, vi.fn());
    expect(items.map((item) => group(item).id)).toEqual([
      "view-options",
      "fixture-mode",
      "view-options-2",
    ]);
  });

  it("names the emitted cluster", () => {
    const [item] = renderViewOptions([toggle], {}, vi.fn(), "view-mode");
    expect(group(item).id).toBe("view-mode");
  });

  it("disables both faces of a segmented pair", () => {
    const [item] = renderViewOptions([segmented], {}, vi.fn(), "view-mode", true);
    expect(group(item).items.every((child) => child.disabled)).toBe(true);
  });

  it("produces nothing from an empty list", () => {
    expect(renderViewOptions([], {}, vi.fn())).toEqual([]);
  });
});
