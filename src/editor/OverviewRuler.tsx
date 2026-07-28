// The change map beside the panes: one mark per chunk, at the height of the
// change, in the three colours Part 4 asked for.
//
// Presentational. Stripes arrive as fractions from `lib/diffStripes`, already
// classified and already positioned, and a click comes back out as a chunk index.
// The component never touches an editor, which is what lets it be tested in jsdom
// at all — the measuring is the caller's problem, and it is the caller who has the
// live view to measure.
//
// Lives in `editor/` rather than `diff/` because nothing here is diff-specific:
// the merge window can hang it beside its panes as soon as they are aligned
// enough for a shared vertical scale to mean anything.

import type { MouseEvent } from "react";
import type { Stripe, StripeKind } from "../lib/diffStripes";

export interface OverviewRulerProps {
  stripes: readonly Stripe[];
  colors: Record<StripeKind, string>;
  /** A click on a mark, or on the strip between marks. */
  onSeek: (chunk: number) => void;
  /** Which chunk a click at `fraction` of the strip's height belongs to. */
  chunkAt: (fraction: number) => number | null;
}

const LABEL: Record<StripeKind, string> = {
  added: "added",
  modified: "changed",
  removed: "removed",
};

export function OverviewRuler({ stripes, colors, onSeek, chunkAt }: OverviewRulerProps) {
  function onClick(event: MouseEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.height === 0) return;
    const chunk = chunkAt((event.clientY - box.top) / box.height);
    if (chunk !== null) onSeek(chunk);
  }

  return (
    // Not a listbox or a scrollbar: it is a decoration you may click, and the
    // changes it marks are reachable from the toolbar's Previous/Next and their
    // keybindings. `aria-hidden` would be wrong (the marks are meaningful), so it
    // gets a plain label and stays out of the tab order.
    <div className="ew-ruler" onClick={onClick} aria-label="Changes in this file">
      {stripes.map((stripe) => (
        <div
          className="ew-ruler-mark"
          key={stripe.chunk}
          data-kind={stripe.kind}
          title={`${LABEL[stripe.kind]} — click to scroll here`}
          style={{
            top: `${stripe.top * 100}%`,
            height: `${stripe.height * 100}%`,
            background: colors[stripe.kind],
          }}
        />
      ))}
    </div>
  );
}
