// What this file exists for is the drift test at the bottom.
//
// `iconElement` copies lucide's path data rather than importing it, because
// lucide-react publishes `__iconNode` only at an internal `dist/esm` path. A copy
// can go stale in a way nobody would notice by looking — the toolbar's chevron
// and the gutter's chevron would simply be different chevrons — so the copy is
// checked against the real component here.
//
// jsdom renders SVG as DOM and nothing more: this asserts the markup, never that
// either icon *looks* like anything. That is the manual pass.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { iconElement, iconPaths, type IconName } from "./iconElement";

/** The `d` of every `<path>` lucide's own component renders, in order. */
function lucidePaths(element: React.ReactElement): string[] {
  const { container } = render(element);
  return Array.from(container.querySelectorAll("path")).map(
    (path) => path.getAttribute("d") ?? "",
  );
}

describe("iconElement", () => {
  it("builds an svg that takes its colour and size from CSS", () => {
    const svg = iconElement("chevrons-right");

    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    // A hardcoded width would beat a CSS rule on a bare <svg>, so there is none.
    expect(svg.hasAttribute("width")).toBe(false);
    expect(svg.hasAttribute("height")).toBe(false);
  });

  it("hides itself from assistive tech, because the button around it has the name", () => {
    expect(iconElement("chevrons-left").getAttribute("aria-hidden")).toBe("true");
  });

  it("draws every path of the icon", () => {
    const paths = Array.from(iconElement("chevrons-right").querySelectorAll("path"));
    expect(paths.map((path) => path.getAttribute("d"))).toEqual([
      ...iconPaths("chevrons-right"),
    ]);
  });

  it("returns a fresh element each time, because one node cannot be in two gutters", () => {
    expect(iconElement("chevrons-right")).not.toBe(iconElement("chevrons-right"));
  });

  it.each<[IconName, React.ReactElement]>([
    ["chevrons-right", <ChevronsRight key="r" />],
    ["chevrons-left", <ChevronsLeft key="l" />],
  ])("draws the same %s lucide does", (name, component) => {
    expect([...iconPaths(name)]).toEqual(lucidePaths(component));
  });
});
