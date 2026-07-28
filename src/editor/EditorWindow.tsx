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
// The toolbar is not a slot here. It is rendered by the pane components, which is
// where the live editor is: see EditorToolbar's own comment.

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

export function EditorWindow({ className, header, notices = [], children }: EditorWindowProps) {
  return (
    <div className={className === undefined ? "ew-window" : `ew-window ${className}`}>
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
