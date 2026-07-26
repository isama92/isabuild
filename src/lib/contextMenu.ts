// Where a popup menu goes so it stays on screen. Pure arithmetic, kept out of
// the component because jsdom reports every bounding rect as zero: the flipping
// is only testable as a function.

export interface MenuBox {
  /** Preferred top-left corner — the cursor, or a row's bottom-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface MenuPosition {
  left: number;
  top: number;
}

/**
 * Place a menu of `box`'s size at `box`'s corner, flipped back over that corner
 * when it would overflow, and clamped to the viewport when even the flip does
 * not fit (a menu taller than the window, which the copy submenu can reach in a
 * short window).
 *
 * Flipping rather than sliding: a menu that slid left would sit under the
 * cursor, and the first item would be armed under a pointer the user has not
 * moved yet.
 */
export function clampMenuPosition(
  box: MenuBox,
  viewport: Viewport,
  margin = 4,
): MenuPosition {
  return {
    left: place(box.x, box.width, viewport.width, margin),
    top: place(box.y, box.height, viewport.height, margin),
  };
}

function place(start: number, size: number, limit: number, margin: number): number {
  const flipped = start + size > limit - margin ? start - size : start;
  // Math.max last so a menu larger than the viewport is pinned to the near edge
  // and loses its far end, rather than starting off-screen and losing its head.
  return Math.max(margin, Math.min(flipped, limit - size - margin));
}
