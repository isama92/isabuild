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
// write, and `EditorToolbar` decides how a toggle looks.

import type { Scope } from "../lib/keybindings";
import type { ToolbarItem } from "./EditorToolbar";

export interface ViewOption {
  /** Stable id; the key in `settings.viewOptions`. Never change one in place. */
  id: string;
  /** On the toolbar button. Kept to one word where it can be. */
  label: string;
  tooltip: string;
  /** Which windows offer it. An option can belong to more than one. */
  scopes: readonly Scope[];
  /** Used when the settings hold no override. */
  default: boolean;
}

/**
 * Every view option, in the order the toolbar shows them.
 *
 * `collapse-unchanged` is the diff window's only one so far. It is not offered
 * in the merge window: `@codemirror/merge` provides collapsing as a `MergeView`
 * option, and the merge window's three panes are three independent editors, so
 * it would be a different implementation wearing the same name.
 */
export const VIEW_OPTIONS: readonly ViewOption[] = [
  {
    id: "collapse-unchanged",
    label: "Compact",
    tooltip: "Hide long runs of unchanged lines, leaving only the changes",
    scopes: ["diff"],
    default: false,
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

/**
 * The registry as toolbar items, ready to concatenate into a pane's own.
 *
 * Grouped, so however many options a window grows they read as one cluster
 * rather than as a row of unrelated buttons.
 */
export function viewOptionItems(
  scope: Scope,
  state: ViewOptionState,
  toggle: (id: string) => void,
  disabled = false,
): ToolbarItem[] {
  const options = optionsForScope(scope);
  if (options.length === 0) return [];
  return [
    {
      kind: "group",
      id: "view-options",
      items: options.map((option) => ({
        kind: "toggle" as const,
        id: option.id,
        label: option.label,
        tooltip: option.tooltip,
        active: state[option.id] ?? option.default,
        disabled,
        onSelect: () => toggle(option.id),
      })),
    },
  ];
}
