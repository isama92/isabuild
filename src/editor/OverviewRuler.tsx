// The change map beside the panes: one mark per chunk, at the height of the
// change.
//
// Presentational. Stripes arrive as fractions from `lib/diffStripes` or
// `lib/mergeStripes`, already classified and already positioned, and a click
// comes back out as a chunk index. The component never touches an editor, which
// is what lets it be tested in jsdom at all — the measuring is the caller's
// problem, and it is the caller who has the live view to measure.
//
// Both windows use it, which is what decides the shape of the props: the *kinds*
// are the caller's, because a diff mark says which way a line moved and a merge
// mark says whose a chunk is, so the colour and the label for each come in
// alongside rather than being known here.

import type { MouseEvent } from "react";
import type { Stripe } from "../lib/overviewStripes";

export interface OverviewRulerProps {
  stripes: readonly Stripe[];
  /** Colour per kind. A kind with no entry paints as nothing rather than throwing. */
  colors: Record<string, string>;
  /** What each kind is called, for the hover. */
  labels: Record<string, string>;
  /** A click on a mark, or on the strip between marks. */
  onSeek: (chunk: number) => void;
  /** Which chunk a click at `fraction` of the strip's height belongs to. */
  chunkAt: (fraction: number) => number | null;
}

export function OverviewRuler({
  stripes,
  colors,
  labels,
  onSeek,
  chunkAt,
}: OverviewRulerProps) {
  function onClick(event: MouseEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.height === 0) return;
    const chunk = chunkAt((event.clientY - box.top) / box.height);
    if (chunk !== null) onSeek(chunk);
  }

  return (
    // Hidden from assistive tech, deliberately. Everything the strip conveys is
    // available without it: the toolbar says how many changes there are, and
    // Previous/Next — with their keybindings — is the way to reach them. The strip
    // is a mouse shortcut to the same thing, and it cannot be anything else here
    // because it is not focusable and has no keyboard equivalent of its own.
    //
    // The alternative was `role="img"` with a label, which would have been exposed
    // but would announce "Changes in this file" and nothing about the marks. A
    // plain `aria-label` on a `div`, which is what this had, is the worst of the
    // three: the generic role does not expose it, so it reads as labelled while
    // being silent.
    <div className="ew-ruler" onClick={onClick} aria-hidden="true">
      {stripes.map((stripe) => (
        <div
          className="ew-ruler-mark"
          key={stripe.chunk}
          data-kind={stripe.kind}
          title={`${labels[stripe.kind] ?? stripe.kind}, click to scroll here`}
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
