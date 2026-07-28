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

export interface ToolbarButton {
  kind: "button";
  id: string;
  label: string;
  /** Tooltip. Always set: several buttons are two words for a whole gesture. */
  tooltip: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ToolbarToggle {
  kind: "toggle";
  id: string;
  label: string;
  tooltip: string;
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

/** Buttons that read as one control. Rendered with no gap between them. */
export interface ToolbarGroup {
  kind: "group";
  id: string;
  items: readonly (ToolbarButton | ToolbarToggle)[];
}

export type ToolbarItem = ToolbarButton | ToolbarToggle | ToolbarStatus | ToolbarGroup;

export interface EditorToolbarProps {
  items: readonly ToolbarItem[];
  /** For the accessible name; there is more than one toolbar in the app. */
  label: string;
}

function Control({ item }: { item: ToolbarButton | ToolbarToggle }) {
  const active = item.kind === "toggle" && item.active;
  return (
    <button
      type="button"
      className={active ? "ew-button ew-button--active" : "ew-button"}
      title={item.tooltip}
      disabled={item.disabled ?? false}
      aria-pressed={item.kind === "toggle" ? item.active : undefined}
      onClick={item.onSelect}
    >
      {item.label}
    </button>
  );
}

export function EditorToolbar({ items, label }: EditorToolbarProps) {
  return (
    <div className="ew-toolbar" role="toolbar" aria-label={label}>
      {items.map((item) => {
        if (item.kind === "group") {
          return (
            <div className="ew-toolbar-group" key={item.id}>
              {item.items.map((child) => (
                <Control item={child} key={child.id} />
              ))}
            </div>
          );
        }
        if (item.kind === "status") {
          return (
            <span className="ew-toolbar-status" key={item.id}>
              {item.text}
            </span>
          );
        }
        return <Control item={item} key={item.id} />;
      })}
    </div>
  );
}
