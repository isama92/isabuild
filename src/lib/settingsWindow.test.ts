import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openSettingsWindow, SETTINGS_WINDOW_LABEL } from "./settingsWindow";

const created: { label: string; options: Record<string, unknown> }[] = [];
let failWith: string | null = null;

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  // A plain function, not an arrow: production code calls it with `new`.
  WebviewWindow: Object.assign(
    vi.fn(function (
      this: Record<string, unknown>,
      label: string,
      options: Record<string, unknown>,
    ) {
      created.push({ label, options });
      this.once = (event: string, handler: (payload: { payload: string }) => void) => {
        if (event === "tauri://created" && failWith === null) {
          handler({ payload: "" });
        }
        if (event === "tauri://error" && failWith !== null) {
          handler({ payload: failWith });
        }
        return Promise.resolve(vi.fn());
      };
    }),
    { getByLabel: vi.fn() },
  ),
}));

const getByLabelMock = vi.mocked(WebviewWindow.getByLabel);

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  failWith = null;
  getByLabelMock.mockResolvedValue(null);
});

describe("openSettingsWindow", () => {
  it("creates one window at the fixed settings label", async () => {
    // No hash: unlike a diff or merge window there is nothing per-file to
    // identify, and the constant label is what makes it a singleton.
    await openSettingsWindow();

    expect(created).toHaveLength(1);
    expect(created[0].label).toBe(SETTINGS_WINDOW_LABEL);
    expect(created[0].options.url).toBe("settings.html");
  });

  it("focuses the window already open instead of creating a second", async () => {
    const unminimize = vi.fn().mockResolvedValue(undefined);
    const setFocus = vi.fn().mockResolvedValue(undefined);
    getByLabelMock.mockResolvedValue({ unminimize, setFocus } as never);

    await openSettingsWindow();

    expect(created).toHaveLength(0);
    // Unminimize first: focusing a minimised window does nothing on its own.
    expect(unminimize).toHaveBeenCalled();
    expect(setFocus).toHaveBeenCalled();
  });

  it("rejects with something the user can read when creation fails", async () => {
    failWith = "label already in use";
    await expect(openSettingsWindow()).rejects.toThrow(
      "could not open the settings window: label already in use",
    );
  });
});
