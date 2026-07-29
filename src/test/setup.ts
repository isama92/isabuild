import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// React 18 requires this flag for act() outside of jest environments.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// RTL only auto-cleans when the test runner exposes a global afterEach.
afterEach(cleanup);

// jsdom implements neither `getClientRects` nor `getBoundingClientRect` on a Range,
// and CodeMirror's measure pass calls the first on every text node it wants a width
// for. That pass rides an animation frame, so any editor test that stays alive long
// enough for one takes a `TypeError` with it — an unhandled error, in whichever test
// happened to be running, rather than a failure where the cause is.
//
// Both halves of the pair are stubbed rather than only the one CodeMirror asks for:
// they are the same missing capability, and stubbing one would read as accidental to
// the next person here.
//
// An empty list is the honest answer for an environment with no layout, and it
// changes nothing else: CodeMirror falls back to measuring a dummy line, jsdom
// reports that as zero pixels high, and CodeMirror's own `lineHeight > 0` guard then
// keeps the 14px-per-line estimate the editor tests read. What this does *not* do is
// make anything measurable — a test that needs geometry still stubs the numbers it
// needs, as `DiffPane.test`'s `withLayout` does.
if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () => {
    const rects: DOMRect[] = [];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
