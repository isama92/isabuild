// The chrome an editor window puts around its panes: a header row, notices, and
// the body the panes fill.
//
// Slots rather than configuration. The two windows' headers say genuinely
// different things — a sha and two paths on one side of the diff, git's own
// marker labels over three merge panes — so the shell owns the *row*, its height,
// its border and its colours, and each window owns what goes in it. What the
// shell does own outright is the notice vocabulary, because "something failed" and
// "something needs your attention" should not look like two different apps
// depending on which window you are in.
//
// The pane's *own* toolbar is not a slot here. It is rendered by the pane
// components, which is where the live editor is: see EditorToolbar's own comment.
// The `toolbar` slot below is for the other kind — controls that must outlive the
// pane, because they are how you get a different pane.

import type { ReactNode } from "react";

export type NoticeTone = "info" | "warn" | "error";

export interface Notice {
  id: string;
  tone: NoticeTone;
  /**
   * A node rather than a string: a notice that declined to do something usually
   * has to offer to do it after all, and the merge window's "reload it" link is
   * part of the sentence rather than a control beside it.
   */
  text: ReactNode;
}

export interface EditorWindowProps {
  /** Added to `.ew-window`, for the few rules a window still owns. */
  className?: string;
  header: ReactNode;
  /**
   * A row above the header, for controls the *window* owns rather than the pane.
   *
   * The diff window's file navigation lives here rather than in the pane's own
   * toolbar because the pane is unmounted during every load and for a binary file
   * — a "10 / 26 files" counter rendered there would vanish at exactly the moment
   * it is being used, and the button you just pressed would disappear under the
   * cursor. The merge window passes none.
   */
  toolbar?: ReactNode;
  /**
   * Shown above the body, in order. An error is `role="alert"` and anything else
   * `role="status"`, so a save failure interrupts a screen reader and a hint does
   * not.
   */
  notices?: readonly Notice[];
  children: ReactNode;
}

const ROLE: Record<NoticeTone, "alert" | "status"> = {
  info: "status",
  warn: "status",
  error: "alert",
};

export function EditorWindow({
  className,
  header,
  toolbar,
  notices = [],
  children,
}: EditorWindowProps) {
  return (
    <div className={className === undefined ? "ew-window" : `ew-window ${className}`}>
      {toolbar}
      <div className="ew-header">{header}</div>
      {notices.map((notice) => (
        <p className={`ew-notice ew-notice--${notice.tone}`} role={ROLE[notice.tone]} key={notice.id}>
          {notice.text}
        </p>
      ))}
      <div className="ew-body">{children}</div>
    </div>
  );
}
