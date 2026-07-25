// Keeping three panes scrolled together, and the guard that stops them fighting.
//
// Proportional rather than aligned: no filler blocks are inserted to make
// corresponding chunks land on the same screen row (see the Part 7 plan's known
// limits), so the panes drift apart in a long file. Next/previous conflict is the
// answer to that, and `scrollTopForLine` is what it uses.
//
// Pure functions, like lib/diffSync: the arithmetic and the re-entrancy rule are
// what can go wrong, and neither needs a DOM to test.

/** The scroll geometry of one pane. */
export interface PaneMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Where `target` should be scrolled to mirror `source`'s position.
 *
 * Expressed as a fraction of scrollable distance rather than a line offset,
 * because the three texts have different line counts — matching absolute
 * `scrollTop` would put a short pane at its end while a long one is halfway.
 *
 * A pane with nothing to scroll stays at 0 rather than dividing by zero.
 */
export function mirrorScrollTop(source: PaneMetrics, target: PaneMetrics): number {
  const sourceRange = source.scrollHeight - source.clientHeight;
  const targetRange = target.scrollHeight - target.clientHeight;
  if (sourceRange <= 0 || targetRange <= 0) return 0;
  const fraction = Math.min(1, Math.max(0, source.scrollTop / sourceRange));
  return Math.round(fraction * targetRange);
}

/**
 * Whether a mirrored scroll is worth applying.
 *
 * Setting `scrollTop` fires another scroll event, so mirroring unconditionally
 * makes three panes bounce off each other indefinitely. A tolerance of one line
 * breaks that loop: rounding differences between panes of different heights are
 * never worth a second round trip. (The caller still needs its own "I am
 * currently syncing" flag for the same-frame case; this is the cheap check that
 * makes the common case never reach it.)
 */
export function worthScrolling(current: number, next: number, lineHeight: number): boolean {
  return Math.abs(current - next) >= Math.max(1, lineHeight);
}

/**
 * Scroll offset that puts `line` (0-based) a little below the top of the pane.
 *
 * The margin is what makes a chunk readable rather than flush against the top
 * edge, and it is clamped so a chunk near the end of a short file still scrolls
 * as far as it can.
 */
export function scrollTopForLine(
  line: number,
  lineHeight: number,
  metrics: Pick<PaneMetrics, "scrollHeight" | "clientHeight">,
  marginLines = 2,
): number {
  const target = (line - marginLines) * lineHeight;
  const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return Math.min(max, Math.max(0, Math.round(target)));
}
