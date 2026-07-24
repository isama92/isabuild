import { useEffect, useRef, type ReactNode } from "react";

// The app's first modal primitive, introduced for the Part 5 branch dialogs.
//
// A plain div with the dialog ARIA roles rather than the native `<dialog>`
// element: `showModal` is not reliably implemented under jsdom, so a native
// dialog would leave every dialog in this app untestable. The behaviour the
// native element would give us for free is provided here instead — Esc to
// dismiss, a focus trap, and focus restored to whatever was focused before.

interface ModalProps {
  title: string;
  /** Dismiss (Esc, the backdrop, a Cancel button). */
  onClose: () => void;
  children: ReactNode;
  /** Footer buttons, right-aligned. */
  actions?: ReactNode;
}

/** Everything focusable inside the dialog, in tab order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function Modal({ title, onClose, children, actions }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Captured on mount so dismissing returns focus where the user left it,
  // rather than dumping it on document.body (which would strand the keyboard).
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const dialog = dialogRef.current;
    // The first field or button, so typing works immediately.
    if (dialog) focusables(dialog)[0]?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, []);

  // Held in a ref so a new onClose identity does not re-register the listener.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = focusables(dialog);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Wrap at both ends, so Tab can never reach the workspace behind us.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    // Capture phase, like useGlobalKeybindings: xterm must not see Esc while a
    // dialog is open, or it would forward it to the PTY.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      {/* Stop the backdrop dismissal from firing for clicks inside the box. */}
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        {actions !== undefined && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
