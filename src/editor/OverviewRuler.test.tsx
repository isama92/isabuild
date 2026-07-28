import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverviewRuler } from "./OverviewRuler";
import { markerColors, type Stripe } from "../lib/diffStripes";
import { DEFAULT_THEME } from "../theme/themes";

const COLORS = markerColors(DEFAULT_THEME);

function stripe(overrides: Partial<Stripe> = {}): Stripe {
  return { chunk: 0, kind: "modified", top: 0.25, height: 0.1, ...overrides };
}

function marks(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".ew-ruler-mark"));
}

describe("OverviewRuler", () => {
  it("paints one mark per stripe, positioned as a percentage", () => {
    // Percentages, not pixels: the strip resizes with the window and the marks
    // have to follow without anything re-measuring.
    const { container } = render(
      <OverviewRuler
        stripes={[stripe({ chunk: 0, top: 0.25, height: 0.1 })]}
        colors={COLORS}
        onSeek={vi.fn()}
        chunkAt={vi.fn()}
      />,
    );

    const [mark] = marks(container);
    expect(mark).toHaveStyle({ top: "25%", height: "10%" });
  });

  it("colours each mark by kind", () => {
    const { container } = render(
      <OverviewRuler
        stripes={[
          stripe({ chunk: 0, kind: "added" }),
          stripe({ chunk: 1, kind: "modified" }),
          stripe({ chunk: 2, kind: "removed" }),
        ]}
        colors={COLORS}
        onSeek={vi.fn()}
        chunkAt={vi.fn()}
      />,
    );

    expect(marks(container).map((mark) => mark.getAttribute("data-kind"))).toEqual([
      "added",
      "modified",
      "removed",
    ]);
    expect(marks(container)[0]).toHaveStyle({ background: COLORS.added });
    expect(marks(container)[2]).toHaveStyle({ background: COLORS.removed });
  });

  it("says what each mark is, for a hover", () => {
    render(
      <OverviewRuler
        stripes={[stripe({ kind: "removed" })]}
        colors={COLORS}
        onSeek={vi.fn()}
        chunkAt={vi.fn()}
      />,
    );
    expect(screen.getByTitle("removed — click to scroll here")).toBeInTheDocument();
  });

  it("scrolls to the chunk under a click", () => {
    const onSeek = vi.fn();
    const chunkAt = vi.fn().mockReturnValue(3);
    const { container } = render(
      <OverviewRuler stripes={[stripe()]} colors={COLORS} onSeek={onSeek} chunkAt={chunkAt} />,
    );

    const strip = container.querySelector(".ew-ruler") as HTMLElement;
    // jsdom measures every box as zero, so the fraction has to be forced.
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      top: 100,
      height: 400,
    } as DOMRect);
    strip.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: 300 }));

    expect(chunkAt).toHaveBeenCalledWith(0.5);
    expect(onSeek).toHaveBeenCalledWith(3);
  });

  it("does nothing for a click on empty strip", () => {
    const onSeek = vi.fn();
    const { container } = render(
      <OverviewRuler
        stripes={[stripe()]}
        colors={COLORS}
        onSeek={onSeek}
        chunkAt={() => null}
      />,
    );

    const strip = container.querySelector(".ew-ruler") as HTMLElement;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({ top: 0, height: 400 } as DOMRect);
    strip.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: 10 }));

    expect(onSeek).not.toHaveBeenCalled();
  });

  it("does not divide by an unmeasured strip", () => {
    // The first paint, before layout: height 0 would put the fraction at Infinity
    // and scroll to whatever chunk that resolved to.
    const chunkAt = vi.fn();
    const { container } = render(
      <OverviewRuler stripes={[stripe()]} colors={COLORS} onSeek={vi.fn()} chunkAt={chunkAt} />,
    );

    const strip = container.querySelector(".ew-ruler") as HTMLElement;
    strip.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: 10 }));

    expect(chunkAt).not.toHaveBeenCalled();
  });

  it("stays out of the accessibility tree", () => {
    // A mouse shortcut to what Previous/Next already reach. The label it used to
    // carry was inert anyway — a plain `aria-label` on a `div` is not exposed — so
    // it read as labelled while being silent.
    const { container } = render(
      <OverviewRuler stripes={[stripe()]} colors={COLORS} onSeek={vi.fn()} chunkAt={vi.fn()} />,
    );
    expect(container.querySelector(".ew-ruler")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders an empty strip for a file with no changes", () => {
    const { container } = render(
      <OverviewRuler stripes={[]} colors={COLORS} onSeek={vi.fn()} chunkAt={vi.fn()} />,
    );
    expect(marks(container)).toHaveLength(0);
    expect(container.querySelector(".ew-ruler")).toBeInTheDocument();
  });
});
