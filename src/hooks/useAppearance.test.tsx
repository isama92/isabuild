import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppearance, useAppearanceSync } from "./useAppearance";
import {
  currentAppearance,
  FONT_FAMILY_VAR,
  FONT_SIZE_VAR,
  resetAppearance,
} from "../lib/appearance";
import { initialSettingsState, useSettingsStore } from "../store/settingsStore";
import type { Settings } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings: {},
    viewOptions: {},
    lastProject: null,
    recentProjects: [],
    ...overrides,
  };
}

// One component per hook: choosing between them inside a single component would
// call a hook conditionally.
function Harness() {
  useAppearance();
  return null;
}

function SyncHarness() {
  useAppearanceSync();
  return null;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState(initialSettingsState);
  resetAppearance();
  document.documentElement.style.removeProperty(FONT_FAMILY_VAR);
  document.documentElement.style.removeProperty(FONT_SIZE_VAR);
  listenMock.mockResolvedValue(vi.fn());
});

afterEach(() => resetAppearance());

describe("useAppearance", () => {
  it("publishes nothing until the settings are known", async () => {
    render(<Harness />);
    await act(tick);
    expect(currentAppearance()).toBeNull();
  });

  it("writes the resolved font onto the document root", async () => {
    useSettingsStore.setState({ settings: settings({ fontFamily: "Fira Code", fontSize: 16 }) });
    render(<Harness />);
    await act(tick);

    expect(document.documentElement.style.getPropertyValue(FONT_FAMILY_VAR)).toContain(
      "'Fira Code'",
    );
    expect(document.documentElement.style.getPropertyValue(FONT_SIZE_VAR)).toBe("16px");
  });

  it("republishes when the settings change", async () => {
    useSettingsStore.setState({ settings: settings({ fontSize: 14 }) });
    render(<Harness />);
    await act(tick);

    act(() => useSettingsStore.setState({ settings: settings({ fontSize: 20 }) }));

    expect(currentAppearance()?.fontSize).toBe(20);
  });

  it("follows settings changed in another window", async () => {
    render(<Harness />);
    await act(tick);
    expect(listenMock).toHaveBeenCalledWith("settings://changed", expect.any(Function));
  });

  it("does not read the settings itself", async () => {
    // The main window already has them from its bootstrap call; a second read
    // here would be a wasted round trip on every launch.
    render(<Harness />);
    await act(tick);
    expect(invokeMock).not.toHaveBeenCalledWith("settings_get", expect.anything());
  });
});

describe("useAppearanceSync", () => {
  it("reads the settings for a window that has no other source", async () => {
    invokeMock.mockResolvedValue(settings({ fontSize: 17 }));
    render(<SyncHarness />);
    await act(tick);

    expect(invokeMock).toHaveBeenCalledWith("settings_get");
    expect(currentAppearance()?.fontSize).toBe(17);
  });
});
