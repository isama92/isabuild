import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { render } from "@testing-library/react";
import { nextOverrides, useViewOptions, type ViewOptions } from "./useViewOptions";
import { initialSettingsState, useSettingsStore } from "../store/settingsStore";
import type { Settings, SettingsPatch } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const save = vi.fn<(patch: SettingsPatch) => Promise<void>>();

function settings(viewOptions: Record<string, boolean> = {}): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings: {},
    viewOptions,
    lastProject: null,
    recentProjects: [],
  };
}

let seen: ViewOptions | null = null;

function Harness() {
  const options = useViewOptions();
  // In an effect, not during render: see the note in useEditorWindow.test.
  useEffect(() => {
    seen = options;
  }, [options]);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  seen = null;
  save.mockResolvedValue(undefined);
  useSettingsStore.setState({ ...initialSettingsState, settings: settings(), save });
});

describe("useViewOptions", () => {
  it("resolves the defaults before anything has been toggled", () => {
    render(<Harness />);
    expect(seen?.state["collapse-unchanged"]).toBe(false);
  });

  it("reflects what the settings hold", () => {
    useSettingsStore.setState({ settings: settings({ "collapse-unchanged": true }) });
    render(<Harness />);
    expect(seen?.state["collapse-unchanged"]).toBe(true);
  });

  it("resolves the defaults before the settings have been read at all", () => {
    // A window paints before its first settings read resolves; the toolbar must
    // not be blank or crash in that frame.
    useSettingsStore.setState({ settings: null });
    render(<Harness />);
    expect(seen?.state["collapse-unchanged"]).toBe(false);
  });

  it("persists a change", () => {
    render(<Harness />);
    seen?.set("collapse-unchanged", true);
    expect(save).toHaveBeenCalledWith({ viewOptions: { "collapse-unchanged": true } });
  });

  it("writes nothing before the settings have been read", () => {
    // The map is replaced wholesale, so a write built from `{}` would erase every
    // override this build does not recognise. Swallowing the click for the frame or
    // two before the first read resolves is the cheaper mistake.
    useSettingsStore.setState({ settings: null });
    render(<Harness />);

    seen?.set("collapse-unchanged", true);

    expect(save).not.toHaveBeenCalled();
  });

  it("keeps an option this build does not know about", () => {
    // A newer version's option would otherwise be erased the first time an older
    // one wrote — so rolling back to chase a bug would silently lose settings.
    useSettingsStore.setState({ settings: settings({ "from-the-future": true }) });
    render(<Harness />);
    seen?.set("collapse-unchanged", true);

    expect(save).toHaveBeenCalledWith({
      viewOptions: { "from-the-future": true, "collapse-unchanged": true },
    });
  });

  it("stops storing an option once it is back on its default", () => {
    // `viewOptions` holds overrides only, like `keybindings`, so config.json says
    // what you changed and nothing else.
    useSettingsStore.setState({ settings: settings({ "collapse-unchanged": true }) });
    render(<Harness />);
    seen?.set("collapse-unchanged", false);

    expect(save).toHaveBeenCalledWith({ viewOptions: {} });
  });

  it("hands back a stable state object while the settings do not move", () => {
    // Consumers put it in dependency arrays; a fresh identity per render makes
    // every memo downstream of it useless.
    const { rerender } = render(<Harness />);
    const first = seen?.state;
    rerender(<Harness />);
    expect(seen?.state).toBe(first);
  });

  it("writes against the settings as they now stand, not as they were rendered", () => {
    // Another window's change arrives through `settings://changed` between this
    // window's render and its click. Reading the store at click time is what makes
    // the write merge into what is actually stored — here, dropping the override
    // rather than writing `false` into a map built from a stale read.
    render(<Harness />);
    useSettingsStore.setState({ settings: settings({ "collapse-unchanged": true }) });

    seen?.set("collapse-unchanged", false);

    expect(save).toHaveBeenCalledWith({ viewOptions: {} });
  });

  describe("set", () => {
    it("writes the value it is asked for, not the opposite of what it read", () => {
      render(<Harness />);
      seen?.set("collapse-unchanged", true);
      expect(save).toHaveBeenCalledWith({ viewOptions: { "collapse-unchanged": true } });
    });

    it("writes nothing when the value is already the one held", () => {
      // Clicking the selected face of a segmented pair. A write here would be an
      // IPC round trip and a `settings://changed` telling every other window that
      // nothing happened.
      useSettingsStore.setState({ settings: settings({ "collapse-unchanged": true }) });
      render(<Harness />);

      seen?.set("collapse-unchanged", true);

      expect(save).not.toHaveBeenCalled();
    });

    it("swallows the click while the settings have not arrived", () => {
      // The map is replaced wholesale, so a write built from `{}` would erase every
      // override this build does not recognise.
      useSettingsStore.setState({ settings: null });
      render(<Harness />);

      seen?.set("collapse-unchanged", true);

      expect(save).not.toHaveBeenCalled();
    });
  });
});

describe("nextOverrides", () => {
  it("writes an override that differs from the default", () => {
    expect(nextOverrides({}, "collapse-unchanged", true)).toEqual({
      "collapse-unchanged": true,
    });
  });

  it("drops one that has come back to its default", () => {
    expect(nextOverrides({ "collapse-unchanged": true }, "collapse-unchanged", false)).toEqual({});
  });

  it("passes unknown ids through untouched", () => {
    expect(nextOverrides({ later: false }, "collapse-unchanged", true)).toEqual({
      later: false,
      "collapse-unchanged": true,
    });
  });

  it("leaves the other registry options as they were", () => {
    // With one option in the registry there is nothing to prove yet; this is the
    // test that starts failing the day a second one is added and the write forgets
    // it, which is the failure that would be hardest to spot by hand.
    const stored = { "collapse-unchanged": true };
    expect(nextOverrides(stored, "collapse-unchanged", true)).toEqual(stored);
  });
});
