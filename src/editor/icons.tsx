// The toolbar's icons, named by what they mean rather than what they look like.
//
// One module so the shape-to-meaning mapping is in one place: if "next change"
// should stop being a down arrow, this is the only file that has to know. The
// windows import `Icons.nextChange`, never `ArrowDown`.
//
// These are elements, not components. They are static and immutable, so the same
// element can be handed to every render and to more than one button at once,
// which keeps the toolbar item lists free of JSX noise.
//
// The two icons that are *not* here are the ones React cannot place: the revert
// control between the diff panes and the merge window's gutter arrows both need a
// DOM node from a non-React callback. See `iconElement.ts`, and the test that
// keeps its copy of the path data honest.

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  FoldVertical,
  Square,
} from "lucide-react";

/** Comfortable inside the 22px square `.ew-button--icon` gives it. */
const SIZE = 16;

export const Icons = {
  previousChange: <ArrowUp size={SIZE} />,
  nextChange: <ArrowDown size={SIZE} />,
  previousFile: <ArrowLeft size={SIZE} />,
  nextFile: <ArrowRight size={SIZE} />,
  /** Compact. Two arrows folding towards each other, which is what it does. */
  collapseUnchanged: <FoldVertical size={SIZE} />,
  /** Two panes, side by side. */
  splitView: <Columns2 size={SIZE} />,
  /** One pane. */
  unifiedView: <Square size={SIZE} />,
} as const;
