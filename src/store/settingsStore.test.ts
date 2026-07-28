import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { followSettings, initialSettingsState, useSettingsStore } from "./settingsStore";
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

beforeEach(() => {
  vi.clearAllMocks();
  // Merge reset: restores data fields while keeping the action closures.
  useSettingsStore.setState(initialSettingsState);
});

describe("load", () => {
  it("fills the store from the backend", async () => {
    invokeMock.mockResolvedValue(settings({ theme: "vscode-light" }));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings?.theme).toBe("vscode-light");
    expect(useSettingsStore.getState().error).toBeNull();
  });

  it("reports a failure instead of leaving the window with no settings at all", async () => {
    invokeMock.mockRejectedValue("no config directory");
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings).toBeNull();
    expect(useSettingsStore.getState().error).toContain("no config directory");
  });
});

describe("save", () => {
  it("sends only the patched fields and adopts what came back", async () => {
    invokeMock.mockResolvedValue(settings({ fontSize: 18 }));
    await useSettingsStore.getState().save({ fontSize: 18 });

    expect(invokeMock).toHaveBeenCalledWith("settings_update", { patch: { fontSize: 18 } });
    // Adopted directly rather than waiting for the broadcast: otherwise the
    // control just changed shows one frame of the old value.
    expect(useSettingsStore.getState().settings?.fontSize).toBe(18);
  });

  it("keeps the previous settings when the write fails", async () => {
    useSettingsStore.setState({ settings: settings({ fontSize: 14 }) });
    invokeMock.mockRejectedValue("read-only config directory");

    await useSettingsStore.getState().save({ fontSize: 18 });

    expect(useSettingsStore.getState().settings?.fontSize).toBe(14);
    expect(useSettingsStore.getState().error).toContain("read-only config directory");
  });

  it("clears an earlier error once a save succeeds", async () => {
    useSettingsStore.setState({ error: "could not save settings: nope" });
    invokeMock.mockResolvedValue(settings());
    await useSettingsStore.getState().save({ theme: "vscode-light" });
    expect(useSettingsStore.getState().error).toBeNull();
  });
});

describe("followSettings", () => {
  it("adopts settings another window saved", async () => {
    // A holder rather than a bare `let`: assigning inside the callback is
    // invisible to control-flow analysis, which then narrows the variable to
    // `null` at the call below.
    const captured: { fire?: (event: { payload: Settings }) => void } = {};
    listenMock.mockImplementation((_name, callback) => {
      captured.fire = callback as (event: { payload: Settings }) => void;
      return Promise.resolve(vi.fn());
    });

    await followSettings();
    expect(listenMock).toHaveBeenCalledWith("settings://changed", expect.any(Function));

    captured.fire?.({ payload: settings({ theme: "vscode-light" }) });
    expect(useSettingsStore.getState().settings?.theme).toBe("vscode-light");
  });
});
