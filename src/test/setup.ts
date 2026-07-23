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
