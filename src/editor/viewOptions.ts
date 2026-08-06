// What the editor windows let you turn on and off, and what the settings
// remember about it.
//
// Deliberately the same shape as `lib/keybindings`' ACTIONS/resolveBindings
// pair, and for the same reasons: the registry owns the ids, the labels and the
// defaults; `settings.viewOptions` stores nothing but the *overrides*; and an
// entry a hand-edited `config.json` gets wrong falls back to the default rather
// than leaving a dead toggle nobody can explain.
//
// Adding an option is one entry here plus one handler in whichever pane
// implements it. Nothing in either window's chrome changes, which is the whole
// point of the file.
//
// Entirely pure: no store, no DOM. `useViewOptions` decides when to read and
// write, and `EditorToolbar` decides how a toggle looks. The icons are React
// elements, which are values like any other — nothing here renders.

import type { ReactNode } from "react";
import type { Scope } from "../lib/keybindings";
import type { ToolbarItem, ToolbarToggle } from "./EditorToolbar";
import { Icons } from "./icons";

/**
 * Which toolbar cluster an option's control joins.
 *
 * Not a position: the pane decides where a cluster lands by where it splices
 * `viewOptionItems(…)` into its own item list. What the registry owns is *which*
 * cluster an option belongs to, so an option can be moved across the bar without
 * a pane ever learning its id — which is the point of this file.
 */
export type ViewOptionGroup = "view-options" | "view-mode";

const DEFAULT_GROUP: ViewOptionGroup = "view-options";

/** One button of a segmented pair. */
export interface ViewOptionFace {
  label: string;
  tooltip: string;
  icon?: ReactNode;
}

/**
 * How a boolean is offered.
 *
 * `toggle` is one button that is pressed or not. `segmented` is two mutually
 * exclusive buttons, for an option whose two states are two named things rather
 * than a thing and its absence: Split and Unified are both views, and neither of
 * them reads as "Unified, off".
 */
export type ViewOptionControl =
  | { kind: "toggle" }
  | { kind: "segmented"; off: ViewOptionFace; on: ViewOptionFace };

const TOGGLE: ViewOptionControl = { kind: "toggle" };

export interface ViewOption {
  /** Stable id; the key in `settings.viewOptions`. Never change one in place. */
  id: string;
  /**
   * The accessible name of the setting. Shown as the button's text when there is
   * no `icon`, and as its `aria-label` when there is. For a segmented option the
   * two buttons are named by `control`, and this names the option as one thing.
   */
  label: string;
  tooltip: string;
  /** Which windows offer it. An option can belong to more than one. */
  scopes: readonly Scope[];
  /** Used when the settings hold no override. */
  default: boolean;
  icon?: ReactNode;
  /** Defaults to `"view-options"`. */
  group?: ViewOptionGroup;
  /** Defaults to a plain toggle. */
  control?: ViewOptionControl;
}

/**
 * Every view option, in the order the toolbar shows them.
 *
 * Both are diff-window only. `collapse-unchanged` is not offered in the merge
 * window because `@codemirror/merge` provides collapsing as a `MergeView` option
 * and the merge window's three panes are three independent editors, so it would
 * be a different implementation wearing the same name; `unified-view` is not,
 * because a three-way merge has nothing to unify onto.
 */
export const VIEW_OPTIONS: readonly ViewOption[] = [
  {
    id: "collapse-unchanged",
    label: "Compact",
    tooltip: "Hide long runs of unchanged lines, leaving only the changes",
    scopes: ["diff"],
    default: false,
    icon: Icons.collapseUnchanged,
  },
  {
    id: "unified-view",
    label: "View mode",
    tooltip: "Whether the diff is laid out as two panes or one",
    scopes: ["diff"],
    default: false,
    group: "view-mode",
    control: {
      kind: "segmented",
      off: {
        label: "Two panels",
        tooltip: "HEAD and the working tree side by side",
        icon: Icons.splitView,
      },
      on: {
        label: "One panel",
        tooltip: "One document, with HEAD's lines shown above each change",
        icon: Icons.unifiedView,
      },
    },
  },
];

/** An option's state, id-keyed. */
export type ViewOptionState = Record<string, boolean>;

/**
 * Resolve the stored overrides against the defaults.
 *
 * Only ids in the registry come out, so an option a newer build wrote cannot reach
 * a pane that has no idea what it means. Keeping it in `config.json` is a separate
 * job, and `useViewOptions.nextOverrides` is where that happens.
 */
export function resolveViewOptions(overrides: Record<string, boolean>): ViewOptionState {
  const state: ViewOptionState = {};
  for (const option of VIEW_OPTIONS) {
    const override = overrides[option.id];
    state[option.id] = typeof override === "boolean" ? override : option.default;
  }
  return state;
}

/** The options a window offers, in registry order. */
export function optionsForScope(scope: Scope): readonly ViewOption[] {
  return VIEW_OPTIONS.filter((option) => option.scopes.includes(scope));
}

/** The options a window offers in one cluster, in registry order. */
export function optionsForGroup(scope: Scope, group: ViewOptionGroup): readonly ViewOption[] {
  return optionsForScope(scope).filter((option) => (option.group ?? DEFAULT_GROUP) === group);
}

export interface ViewOptionItemsConfig {
  /** Which cluster to emit. Defaults to `"view-options"`. */
  group?: ViewOptionGroup;
  /** Greys the controls out while the pane says it is busy. */
  disabled?: boolean;
}

/**
 * One cluster of the registry as toolbar items, ready to splice into a pane's own.
 *
 * `set(id, value)` rather than `toggle(id)`: a segmented pair has to be able to
 * say "be false", and clicking the face that is already on must not flip it off.
 */
export function viewOptionItems(
  scope: Scope,
  state: ViewOptionState,
  set: (id: string, value: boolean) => void,
  config: ViewOptionItemsConfig = {},
): ToolbarItem[] {
  const group = config.group ?? DEFAULT_GROUP;
  return renderViewOptions(optionsForGroup(scope, group), state, set, group, config.disabled);
}

/**
 * The rendering half, over an explicit list of options.
 *
 * Split from `viewOptionItems` so how an option *looks* can be tested without
 * depending on what the registry happens to hold today — otherwise every case
 * for the segmented presentation would be a case about one particular setting,
 * and would break the day that setting moved.
 *
 * Plain toggles collect into a single group, so however many a window grows they
 * read as one cluster rather than a row of unrelated buttons. A segmented option
 * gets a group to itself, because its two buttons are one control.
 */
export function renderViewOptions(
  options: readonly ViewOption[],
  state: ViewOptionState,
  set: (id: string, value: boolean) => void,
  group: string = DEFAULT_GROUP,
  disabled = false,
): ToolbarItem[] {
  const items: ToolbarItem[] = [];

  // Consecutive toggles are batched rather than all of them being hoisted to the
  // front, so an option's position in the cluster is its position in the registry
  // however the two kinds are interleaved.
  let batch: ToolbarToggle[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    items.push({ kind: "group", id: items.length === 0 ? group : `${group}-${items.length}`, items: batch });
    batch = [];
  };

  for (const option of options) {
    const active = state[option.id] ?? option.default;
    const control = option.control ?? TOGGLE;
    if (control.kind === "toggle") {
      batch.push({
        kind: "toggle",
        id: option.id,
        label: option.label,
        tooltip: option.tooltip,
        icon: option.icon,
        active,
        disabled,
        onSelect: () => set(option.id, !active),
      });
      continue;
    }
    flush();
    items.push({
      kind: "group",
      id: option.id,
      variant: "segmented",
      items: ([false, true] as const).map((value) => {
        const face = value ? control.on : control.off;
        return {
          kind: "toggle" as const,
          id: `${option.id}:${value ? "on" : "off"}`,
          label: face.label,
          tooltip: face.tooltip,
          icon: face.icon,
          active: active === value,
          disabled,
          // Not a flip: the face that is already on is a no-op, not the way back.
          onSelect: () => set(option.id, value),
        };
      }),
    });
  }
  flush();

  return items;
}
