// The toolbar row shared by the diff and merge windows.
//
// A declarative item list rather than markup per window, for one reason: a
// button that belongs in *both* windows should be describable once. That is what
// `viewOptions.viewOptionItems` produces — the registry turns into items, the
// items turn into buttons here, and neither window's chrome has to know a new
// option exists.
//
// Window-specific actions stay window-specific: the merge window's Take
// mine/theirs/both live next to the state that drives them, and only pass
// through this component to look like everything else.
//
// Rendering only. No state, no store, no CodeMirror — so it tests as a pure
// component and cannot become the place window logic accretes.
//
// `label` is the accessible name whether or not there is an icon: with one it
// becomes `aria-label` and the icon is hidden, without one it is the button's
// text. That is deliberate and load-bearing — it means giving a button an icon
// never changes what `getByRole("button", { name })` finds, here or in a test.

import type { ReactNode } from "react";

export interface ToolbarButton {
  kind: "button";
  id: string;
  /**
   * The accessible name, always. Shown as text when there is no `icon`, and put
   * on `aria-label` when there is — an icon-only button still has to be findable
   * and announceable by the same words.
   */
  label: string;
  /** Tooltip. Always set: several buttons are two words for a whole gesture. */
  tooltip: string;
  /** Rendered instead of the label, `aria-hidden`. See `label`. */
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ToolbarToggle {
  kind: "toggle";
  id: string;
  label: string;
  tooltip: string;
  icon?: ReactNode;
  /** Reflected as `aria-pressed`, so the state is not colour-only. */
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Read-only text, for "Chunk 2 of 7 — both sides changed this". */
export interface ToolbarStatus {
  kind: "status";
  id: string;
  text: string;
}

/**
 * The slack between clusters. Whatever follows one is pinned right.
 *
 * Explicit rather than a property of the status text, which is what used to take
 * the slack: the diff toolbar wants its count *beside* the controls on the right
 * rather than stranded in the middle, and "who absorbs the empty space" is a
 * layout decision the window should be able to state.
 */
export interface ToolbarSpacer {
  kind: "spacer";
  id: string;
}

/** A hairline between two clusters. Cosmetic; the gap already groups them. */
export interface ToolbarSeparator {
  kind: "separator";
  id: string;
}

/** Buttons that read as one control. */
export interface ToolbarGroup {
  kind: "group";
  id: string;
  /**
   * `segmented` joins the buttons into one control with shared borders, for a
   * mutually exclusive choice such as Split/Unified — two buttons that happen to
   * sit together read as two independent toggles, which these are not.
   * Presentation only: `aria-pressed` still carries which one is on.
   */
  variant?: "default" | "segmented";
  items: readonly (ToolbarButton | ToolbarToggle)[];
}

export type ToolbarItem =
  | ToolbarButton
  | ToolbarToggle
  | ToolbarStatus
  | ToolbarSpacer
  | ToolbarSeparator
  | ToolbarGroup;

export interface EditorToolbarProps {
  items: readonly ToolbarItem[];
  /** For the accessible name; there is more than one toolbar in the app. */
  label: string;
}

function Control({ item }: { item: ToolbarButton | ToolbarToggle }) {
  const active = item.kind === "toggle" && item.active;
  const classes = ["ew-button"];
  if (item.icon !== undefined) classes.push("ew-button--icon");
  if (active) classes.push("ew-button--active");
  return (
    <button
      type="button"
      className={classes.join(" ")}
      title={item.tooltip}
      disabled={item.disabled ?? false}
      aria-label={item.icon === undefined ? undefined : item.label}
      aria-pressed={item.kind === "toggle" ? item.active : undefined}
      onClick={item.onSelect}
    >
      {item.icon === undefined ? item.label : <span aria-hidden="true">{item.icon}</span>}
    </button>
  );
}

export function EditorToolbar({ items, label }: EditorToolbarProps) {
  return (
    <div className="ew-toolbar" role="toolbar" aria-label={label}>
      {items.map((item) => {
        switch (item.kind) {
          case "group":
            return (
              <div
                className={
                  item.variant === "segmented"
                    ? "ew-toolbar-group ew-toolbar-group--segmented"
                    : "ew-toolbar-group"
                }
                key={item.id}
              >
                {item.items.map((child) => (
                  <Control item={child} key={child.id} />
                ))}
              </div>
            );
          case "status":
            return (
              <span className="ew-toolbar-status" key={item.id}>
                {item.text}
              </span>
            );
          case "spacer":
            return <span className="ew-toolbar-spacer" key={item.id} />;
          case "separator":
            return (
              <span
                className="ew-toolbar-separator"
                role="separator"
                aria-orientation="vertical"
                key={item.id}
              />
            );
          default:
            return <Control item={item} key={item.id} />;
        }
      })}
    </div>
  );
}
