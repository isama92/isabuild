import { describe, expect, it } from "vitest";
import { shouldAdoptDiskContent } from "./diffSync";

// Baseline: an external edit landed while the pane sat idle.
const external = {
  fetched: "from claude code\n",
  buffer: "loaded content\n",
  lastWritten: "loaded content\n",
  savePending: false,
};

describe("shouldAdoptDiskContent", () => {
  it("adopts content changed by someone else", () => {
    expect(shouldAdoptDiskContent(external)).toBe(true);
  });

  it("ignores a refresh while a save is still queued", () => {
    // The buffer is ahead of disk; adopting would undo what the user typed.
    expect(shouldAdoptDiskContent({ ...external, savePending: true })).toBe(false);
  });

  it("ignores a refresh that matches the buffer", () => {
    expect(shouldAdoptDiskContent({ ...external, fetched: external.buffer })).toBe(false);
  });

  it("ignores our own write echoing back through the watcher", () => {
    // Auto-save wrote "typed", the user has typed on since: disk equals our
    // last write, so the buffer is the newer copy and must survive.
    expect(
      shouldAdoptDiskContent({
        fetched: "typed\n",
        buffer: "typed more\n",
        lastWritten: "typed\n",
        savePending: false,
      }),
    ).toBe(false);
  });

  it("adopts a deletion of the file", () => {
    expect(shouldAdoptDiskContent({ ...external, fetched: null })).toBe(true);
  });

  it("ignores a deletion that the pane already shows", () => {
    expect(
      shouldAdoptDiskContent({
        fetched: null,
        buffer: null,
        lastWritten: null,
        savePending: false,
      }),
    ).toBe(false);
  });
});
