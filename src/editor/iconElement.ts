// Lucide icons as plain DOM, for the two places React cannot reach.
//
// `@codemirror/merge`'s `renderRevertControl` and CodeMirror's `GutterMarker.toDOM`
// both want an `Element` back, synchronously, from code that is not in a React
// tree. Mounting a React root per gutter marker to render one `<svg>` is a lot of
// machinery for two glyphs, so these are built with `createElementNS` instead.
//
// The path data is lucide's own, copied rather than imported: lucide-react
// publishes each icon's `__iconNode` only at `dist/esm/icons/*.mjs`, an internal
// path with no types and no `exports` entry, so importing it would pin this file
// to the package's build layout. `iconElement.test.ts` renders the real lucide
// component and asserts the paths match, so a copy that goes stale fails the
// suite rather than quietly drawing a different arrow from the toolbar's.
//
// The attributes below are lucide's `defaultAttributes` with `width`/`height`
// dropped: these icons are sized from CSS, and a hardcoded 24 would win over a
// `width` rule on a bare `<svg>`.

/** The icons this module can build. Named as lucide names them. */
export type IconName = "chevrons-right" | "chevrons-left";

/** lucide-react v1.28.0 `__iconNode`, `d` attributes only — every path is a `<path>`. */
const PATHS: Record<IconName, readonly string[]> = {
  "chevrons-right": ["m6 17 5-5-5-5", "m13 17 5-5-5-5"],
  "chevrons-left": ["m11 17-5-5 5-5", "m18 17-5-5 5-5"],
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A fresh `<svg>` for `name`.
 *
 * Fresh rather than a shared node cloned on demand: a gutter marker's `toDOM` is
 * called once per line that has one, and the same element cannot be in two
 * places. Cheap enough — two `<path>`s, and only for lines that carry a control.
 */
export function iconElement(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // Decorative in both call sites: the button around it carries the label.
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `ib-icon ib-icon--${name}`);
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** The `d` attributes this module draws for `name`. Exported for the drift test. */
export function iconPaths(name: IconName): readonly string[] {
  return PATHS[name];
}
