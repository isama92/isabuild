import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition } from "../lib/contextMenu";
import { fileMenuItems, type FileAction, type FileTarget } from "../lib/fileActions";

// The status panel's per-row context menu: commit, rollback, stage/unstage and
// the three forms of the path. Which items appear is decided by
// `lib/fileActions.fileMenuItems`; this component only renders and navigates.
//
// A plain fixed-position div rather than a native menu. Tauri's menu API has no
// popup plumbing wired up here, a native menu would need a capability per window
// label, and — decisively — it would be untestable under jsdom, where every other
// dialog and popover in this app is covered. `position: fixed` escapes
// `#root { overflow: hidden }` the way Modal's backdrop does, so no portal is
// needed either.
//
// Modelled on BranchMenu (click-outside on `mousedown`, `onClose` in a ref, arrow
// keys over real buttons) and on Modal (focusables found in the DOM rather than
// tracked in a ref array, and focus restored on the way out).

export interface FileContextMenuProps {
  target: FileTarget;
  /** Where the menu wants its top-left corner: the cursor, or a row's corner. */
  x: number;
  y: number;
  /** True while a merge, rebase, cherry-pick or revert is in progress. */
  operationInProgress: boolean;
  onAction: (action: FileAction, target: FileTarget) => void;
  onClose: () => void;
}

export function FileContextMenu({
  target,
  x,
  y,
  operationInProgress,
  onAction,
  onClose,
}: FileContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  // Set when the submenu was opened from the keyboard, so focus follows it in.
  // A mouse user is already pointing at where they want to go.
  const enterSubmenu = useRef(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [position, setPosition] = useState({ left: x, top: y });

  const items = fileMenuItems(target, operationInProgress);

  // Measured after layout but before paint: rendering at the raw cursor and
  // correcting in an effect would flash the menu half off-screen for a frame.
  // Re-runs when the submenu opens, which really does change the measured height —
  // the submenu expands *in flow* precisely so that it does (see App.css).
  useLayoutEffect(() => {
    const box = containerRef.current?.getBoundingClientRect();
    setPosition(
      clampMenuPosition(
        { x, y, width: box?.width ?? 0, height: box?.height ?? 0 },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [x, y, submenuOpen]);

  useEffect(() => {
    // Focus the first item, so arrows drive the menu immediately, and remember
    // where focus was so closing returns it to the row — a keyboard user who
    // opened this with Shift+F10 must not be dumped on document.body.
    const previous = document.activeElement;
    menuItems(containerRef.current)[0]?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (submenuOpen && enterSubmenu.current) {
      enterSubmenu.current = false;
      submenuRef.current?.querySelector("button")?.focus();
    }
  }, [submenuOpen]);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Mousedown, not click, so a drag that starts outside does not leave the menu
  // open behind a selection — as BranchMenu does.
  useEffect(() => {
    function onMouseDown(event: MouseEvent) {
      const container = containerRef.current;
      if (container && event.target instanceof Node && !container.contains(event.target)) {
        onCloseRef.current();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  function move(delta: number) {
    const all = menuItems(containerRef.current);
    if (all.length === 0) return;
    const current = all.indexOf(document.activeElement as HTMLButtonElement);
    // Entering the list: Down starts at the top, Up wraps to the bottom.
    const next = current === -1 ? (delta > 0 ? 0 : all.length - 1) : current + delta;
    all[(next + all.length) % all.length].focus();
  }

  /** The item that owns the submenu; there is at most one. */
  function submenuParent(): HTMLButtonElement | null {
    return containerRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') ?? null;
  }

  function closeSubmenu() {
    setSubmenuOpen(false);
    submenuParent()?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "Escape":
        // stopPropagation as well as preventDefault: xterm must not see the
        // Escape and forward it to the PTY, the reason Modal captures it too.
        event.preventDefault();
        event.stopPropagation();
        if (submenuOpen) closeSubmenu();
        else onClose();
        break;
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "ArrowRight":
        // Only from the item that owns the submenu, as a menu is expected to
        // behave: ArrowRight anywhere else means nothing here.
        if (!submenuOpen && document.activeElement === submenuParent()) {
          event.preventDefault();
          enterSubmenu.current = true;
          setSubmenuOpen(true);
        }
        break;
      case "ArrowLeft":
        if (submenuOpen) {
          event.preventDefault();
          closeSubmenu();
        }
        break;
      default:
        break;
    }
  }

  function fire(action: FileAction) {
    // Closed first, so the menu is gone by the time a dialog opens over it and
    // the focus restore above hands the row back before the dialog captures it.
    onClose();
    onAction(action, target);
  }

  return (
    <div
      className="file-menu"
      role="menu"
      aria-label={`Actions for ${target.path}`}
      ref={containerRef}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) =>
        item.kind === "action" ? (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            className={
              item.destructive ? "file-menu-item file-menu-item--danger" : "file-menu-item"
            }
            disabled={item.disabledReason !== undefined}
            title={item.disabledReason}
            onClick={() => fire(item.action)}
          >
            {item.label}
          </button>
        ) : (
          // role="none": only menuitem/group/separator are valid children of a
          // menu, and this wrapper is pure layout.
          <div className="file-menu-nest" role="none" key={item.label}>
            <button
              type="button"
              role="menuitem"
              className="file-menu-item"
              aria-haspopup="menu"
              aria-expanded={submenuOpen}
              onClick={() => setSubmenuOpen((open) => !open)}
            >
              <span>{item.label}</span>
              <span className="file-menu-arrow" aria-hidden="true">
                {"›"}
              </span>
            </button>
            {submenuOpen && (
              <div className="file-submenu" role="menu" aria-label={item.label} ref={submenuRef}>
                {item.items.map((leaf) => (
                  <button
                    key={leaf.action}
                    type="button"
                    role="menuitem"
                    className="file-menu-item"
                    onClick={() => fire(leaf.action)}
                  >
                    {leaf.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The usable items, in visual order, read from the DOM — the same approach as
 * Modal's focus trap. DOM order is visual order here (the submenu renders inside
 * its parent item), so arrow keys walk what the user sees without a parallel
 * index to keep in step.
 */
function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])'),
  );
}
