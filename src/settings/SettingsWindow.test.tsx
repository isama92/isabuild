import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SettingsWindow } from "./SettingsWindow";
import { listFonts } from "../lib/settings";
import { initialSettingsState, useSettingsStore } from "../store/settingsStore";
import type { FontFamily, Settings } from "../lib/settings";
import { THEMES } from "../theme/themes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: closeMock }) }));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  listFonts: vi.fn(),
}));
// Appearance has its own tests; stubbed so this window does not subscribe to
// the real settings event.
vi.mock("../hooks/useAppearance", () => ({ useAppearanceSync: vi.fn() }));

const closeMock = vi.fn();
const listFontsMock = vi.mocked(listFonts);
const save = vi.fn();

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

const FONTS: FontFamily[] = [
  { name: "Arial", monospaced: false },
  { name: "Fira Code", monospaced: true },
  { name: "JetBrainsMono Nerd Font", monospaced: true },
];

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Render and let the font scan resolve. */
async function mount() {
  render(<SettingsWindow />);
  await act(tick);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ ...initialSettingsState, settings: settings(), save });
  listFontsMock.mockResolvedValue(FONTS);
});

describe("SettingsWindow", () => {
  it("waits for the settings rather than rendering controls with no value", () => {
    useSettingsStore.setState({ settings: null });
    render(<SettingsWindow />);
    expect(screen.getByText("Loading settings…")).toBeInTheDocument();
  });

  it("lists every theme in the registry", async () => {
    await mount();
    for (const theme of THEMES) {
      expect(screen.getByRole("option", { name: theme.label })).toBeInTheDocument();
    }
  });

  it("saves the chosen theme", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "vscode-light" } });
    expect(save).toHaveBeenCalledWith({ theme: "vscode-light" });
  });

  it("shows the stored theme as the selection", async () => {
    useSettingsStore.setState({ settings: settings({ theme: "vscode-light" }) });
    await mount();
    expect(screen.getByLabelText("Theme")).toHaveValue("vscode-light");
  });

  it("lists only monospace fonts by default", async () => {
    // A proportional font in a terminal is unusable, so it is not offered
    // until asked for.
    await mount();

    expect(screen.getByRole("option", { name: "Fira Code" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Arial" })).toBeNull();
  });

  it("shows every family once the mono filter is turned off", async () => {
    await mount();
    fireEvent.click(screen.getByLabelText("Show monospace fonts only"));
    expect(screen.getByRole("option", { name: "Arial" })).toBeInTheDocument();
  });

  it("saves the chosen family", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Font"), {
      target: { value: "JetBrainsMono Nerd Font" },
    });
    expect(save).toHaveBeenCalledWith({ fontFamily: "JetBrainsMono Nerd Font" });
  });

  it("offers the default stack as an explicit choice", async () => {
    // Distinguishable from any real family, so "no choice made" stays
    // expressible after one has been.
    await mount();
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "" } });
    expect(save).toHaveBeenCalledWith({ fontFamily: "" });
  });

  it("keeps a chosen family visible after it has been uninstalled", async () => {
    // Otherwise the select would silently snap to whatever sorts first, saving
    // a font the user never picked.
    useSettingsStore.setState({ settings: settings({ fontFamily: "Uninstalled Mono" }) });
    await mount();

    expect(screen.getByRole("option", { name: "Uninstalled Mono" })).toBeInTheDocument();
    expect(screen.getByLabelText("Font")).toHaveValue("Uninstalled Mono");
  });

  it("saves the font size on blur", async () => {
    await mount();
    const field = screen.getByLabelText("Font size");
    fireEvent.change(field, { target: { value: "18" } });
    fireEvent.blur(field);
    expect(save).toHaveBeenCalledWith({ fontSize: 18 });
  });

  it("saves the font size on Enter", async () => {
    await mount();
    const field = screen.getByLabelText("Font size");
    fireEvent.change(field, { target: { value: "18" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(save).toHaveBeenCalledWith({ fontSize: 18 });
  });

  it("lets an out-of-range value be typed through on the way to a valid one", async () => {
    // The regression this guards: saving per keystroke made the field
    // untypable, because clearing 14 to type 20 passes through "2", which a
    // controlled input then rejected by writing 14 straight back.
    await mount();
    const field = screen.getByLabelText("Font size");

    fireEvent.change(field, { target: { value: "2" } });
    expect(field).toHaveValue(2);
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "20" } });
    fireEvent.blur(field);
    expect(save).toHaveBeenCalledWith({ fontSize: 20 });
  });

  it("reverts an unusable size rather than clamping it", async () => {
    await mount();
    const field = screen.getByLabelText("Font size");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);

    expect(save).not.toHaveBeenCalled();
    expect(field).toHaveValue(14);
  });

  it("does not save a size that did not change", async () => {
    await mount();
    fireEvent.blur(screen.getByLabelText("Font size"));
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a size another window saved once the field is not being edited", async () => {
    await mount();
    act(() => {
      useSettingsStore.setState({ settings: settings({ fontSize: 22 }) });
    });
    expect(screen.getByLabelText("Font size")).toHaveValue(22);
  });

  it("reports a font scan that failed, and still lets the size be changed", async () => {
    listFontsMock.mockRejectedValue(new Error("no font directories"));
    await mount();

    expect(screen.getByRole("alert")).toHaveTextContent("no font directories");
    expect(screen.getByLabelText("Font size")).toBeEnabled();
  });

  it("shows a save failure", async () => {
    useSettingsStore.setState({ error: "could not save settings: read-only" });
    await mount();
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("read-only");
  });

  it("closes on Escape", async () => {
    await mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeMock).toHaveBeenCalled();
  });

  it("closes on Ctrl+W", async () => {
    await mount();
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(closeMock).toHaveBeenCalled();
  });

  it("leaves a key another handler already dealt with alone", async () => {
    await mount();
    // `defaultPrevented` is derived, not assignable: a capture-phase listener
    // that calls preventDefault is the only way to reproduce a key something
    // else has claimed (a select's own Escape, most obviously).
    const claim = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", claim, { capture: true });
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", claim, { capture: true });

    expect(closeMock).not.toHaveBeenCalled();
  });
});
