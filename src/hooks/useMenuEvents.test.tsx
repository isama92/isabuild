import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { useMenuEvents } from "./useMenuEvents";
import { openSettingsWindow } from "../lib/settingsWindow";
import { initialProjectState, useProjectStore } from "../store/projectStore";
import type { MenuActionEvent, Project, RecentProject } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../lib/settingsWindow", () => ({ openSettingsWindow: vi.fn() }));

const listenMock = vi.mocked(listen);
const openSettingsWindowMock = vi.mocked(openSettingsWindow);

const PROJECT: Project = { repoRoot: "/repos/one", name: "one" };

function recent(path: string): RecentProject {
  return { path, name: path.split("/").pop() ?? path, state: "ok" };
}

/** Fires whatever handler the hook subscribed with. */
let fire: (payload: MenuActionEvent) => void = () => {
  throw new Error("nothing subscribed to menu://action");
};

const open = vi.fn();
const openWithPicker = vi.fn();
const close = vi.fn();

/** Renders the hook and exposes its pending state through the DOM. */
function Harness() {
  const { pending, confirm, cancel } = useMenuEvents();
  return (
    <div>
      <span data-testid="pending">{pending === null ? "none" : pending.kind}</span>
      <button type="button" onClick={confirm}>
        confirm
      </button>
      <button type="button" onClick={cancel}>
        cancel
      </button>
    </div>
  );
}

/** Let the async listen subscription settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount() {
  render(<Harness />);
  await act(tick);
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ ...initialProjectState, open, openWithPicker, close });
  listenMock.mockImplementation((_name, handler) => {
    fire = (payload) =>
      (handler as (event: { payload: MenuActionEvent }) => void)({ payload });
    return Promise.resolve(vi.fn());
  });
});

describe("with no project open", () => {
  it("opens the picker immediately, with nothing to confirm", async () => {
    await mount();
    act(() => fire({ action: "open-folder" }));

    expect(openWithPicker).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pending")).toHaveTextContent("none");
  });

  it("opens a recent project immediately", async () => {
    useProjectStore.setState({ recents: [recent("/repos/one"), recent("/repos/two")] });
    await mount();
    act(() => fire({ action: "open-recent", index: 1 }));

    expect(open).toHaveBeenCalledWith("/repos/two");
  });

  it("ignores Close Project, which the menu disables anyway", async () => {
    await mount();
    act(() => fire({ action: "close-project" }));

    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId("pending")).toHaveTextContent("none");
  });
});

describe("with a project open", () => {
  beforeEach(() => {
    useProjectStore.setState({ phase: "open", project: PROJECT, recents: [recent("/repos/two")] });
  });

  it("asks before closing, because it ends a running Claude Code session", async () => {
    await mount();
    act(() => fire({ action: "close-project" }));

    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId("pending")).toHaveTextContent("close-project");
  });

  it("carries the action out on confirm, exactly once", async () => {
    await mount();
    act(() => fire({ action: "close-project" }));
    act(() => screen.getByText("confirm").click());

    // Once, not twice: the work is deliberately outside the setState updater,
    // which StrictMode double-invokes.
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pending")).toHaveTextContent("none");
  });

  it("does nothing on cancel", async () => {
    await mount();
    act(() => fire({ action: "open-folder" }));
    act(() => screen.getByText("cancel").click());

    expect(openWithPicker).not.toHaveBeenCalled();
    expect(screen.getByTestId("pending")).toHaveTextContent("none");
  });

  it("asks before switching to a recent project, and remembers which one", async () => {
    await mount();
    act(() => fire({ action: "open-recent", index: 0 }));
    expect(open).not.toHaveBeenCalled();

    act(() => screen.getByText("confirm").click());
    expect(open).toHaveBeenCalledWith("/repos/two");
  });
});

describe("settings", () => {
  it("opens the settings window with no confirmation", async () => {
    openSettingsWindowMock.mockResolvedValue(undefined);
    await mount();
    act(() => fire({ action: "settings" }));

    expect(openSettingsWindowMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pending")).toHaveTextContent("none");
  });

  it("surfaces a window that would not open, rather than a click that did nothing", async () => {
    openSettingsWindowMock.mockRejectedValue(new Error("could not open the settings window"));
    await mount();
    act(() => fire({ action: "settings" }));
    await act(tick);

    expect(useProjectStore.getState().error).toContain("could not open the settings window");
  });
});

describe("a stale menu", () => {
  it("ignores a recent index past the end of the list", async () => {
    // The menu was built from a list the user has since shortened.
    useProjectStore.setState({ recents: [recent("/repos/one")] });
    await mount();
    act(() => fire({ action: "open-recent", index: 4 }));

    expect(open).not.toHaveBeenCalled();
    expect(screen.getByTestId("pending")).toHaveTextContent("none");
  });
});
