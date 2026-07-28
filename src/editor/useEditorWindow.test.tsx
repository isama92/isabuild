// The shell hook, exercised through a harness component.
//
// Everything it touches is a boundary — the window's own URL, the Tauri window,
// the repo watcher, the settings store — so the whole file is that boundary being
// stood up and then poked. The one thing worth reading closely is the close guard:
// its synchronous/asynchronous distinction is what decides whether a close is
// intercepted at all, and there is a test per branch.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onRepoChanged } from "../lib/gitStatus";
import { useEditorWindow, type EditorWindowOptions } from "./useEditorWindow";
import { initialSettingsState, useSettingsStore } from "../store/settingsStore";
import type { Settings } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("../lib/gitStatus", () => ({ onRepoChanged: vi.fn() }));
vi.mock("../hooks/useAppearance", () => ({ useAppearanceSync: vi.fn() }));

const close = vi.fn();
const destroy = vi.fn();
const unlistenClose = vi.fn();
const unlistenRepo = vi.fn();

/** The handler the hook registered, so a test can be the OS asking to close. */
let fireClose: ((event: { preventDefault: () => void }) => Promise<void>) | null = null;
/** The watcher callback the hook registered. */
let fireRepo: (() => void) | null = null;

interface Params {
  repo: string;
  path: string;
}

function parse(search: string): Params {
  const params = new URLSearchParams(search);
  const repo = params.get("repo");
  const path = params.get("path");
  if (!repo || !path) throw new Error("opened without a repository and file path");
  return { repo, path };
}

function settings(): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings: {},
    viewOptions: {},
    lastProject: null,
    recentProjects: [],
  };
}

let seen: { params?: Params; error?: string } | null = null;

function Harness(options: Partial<EditorWindowOptions<Params>>) {
  const target = useEditorWindow<Params>({
    scope: "diff",
    parse,
    titlePrefix: "Diff",
    pathOf: (params) => params.path,
    ...options,
  });
  // Captured in an effect rather than during render: assigning to a variable
  // outside the component mid-render is a side effect, and effects run inside
  // `render`'s own act(), so it is set by the time a test reads it.
  useEffect(() => {
    seen = target;
  }, [target]);
  return null;
}

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const preventDefault = vi.spyOn(event, "preventDefault");
  window.dispatchEvent(event);
  return { preventDefault };
}

/**
 * Let the subscriptions' promises resolve.
 *
 * Both `onCloseRequested` and `onRepoChanged` hand back their unlisten handle in a
 * microtask, and the hook's cleanup can therefore run before it has one — which it
 * handles, by cancelling the pending subscription instead. Tests that want to see
 * the handle *used* have to wait for it to exist first.
 */
async function settle() {
  await act(async () => {});
}

/** Ask to close, and report whether the hook took the event over. */
async function requestClose() {
  const preventDefault = vi.fn();
  await act(async () => {
    await fireClose?.({ preventDefault });
  });
  return { intercepted: preventDefault.mock.calls.length > 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  seen = null;
  fireClose = null;
  fireRepo = null;
  window.history.replaceState({}, "", "/diff.html?repo=%2Fr&path=src%2Fa.ts");
  document.title = "";
  useSettingsStore.setState({ ...initialSettingsState, settings: settings() });

  vi.mocked(getCurrentWindow).mockReturnValue({
    close,
    destroy,
    onCloseRequested: (handler: (event: { preventDefault: () => void }) => Promise<void>) => {
      fireClose = handler;
      return Promise.resolve(unlistenClose);
    },
  } as unknown as ReturnType<typeof getCurrentWindow>);

  vi.mocked(onRepoChanged).mockImplementation((callback: () => void) => {
    fireRepo = callback;
    return Promise.resolve(unlistenRepo);
  });
});

describe("the target", () => {
  it("comes from the window's own query string", () => {
    render(<Harness />);
    expect(seen).toEqual({ params: { repo: "/r", path: "src/a.ts" } });
  });

  it("is an error message when the window was opened by hand", () => {
    window.history.replaceState({}, "", "/diff.html");
    render(<Harness />);
    expect(seen?.params).toBeUndefined();
    expect(seen?.error).toBe("opened without a repository and file path");
  });

  it("survives a re-render rather than being parsed again", () => {
    const { rerender } = render(<Harness />);
    const first = seen;
    rerender(<Harness />);
    expect(seen).toBe(first);
  });
});

describe("the title", () => {
  it("names the file the window is showing", () => {
    render(<Harness />);
    expect(document.title).toBe("Diff: src/a.ts");
  });

  it("is left alone when there is no file", () => {
    window.history.replaceState({}, "", "/diff.html");
    render(<Harness />);
    expect(document.title).toBe("");
  });
});

describe("closing", () => {
  it("closes on the bound key", () => {
    render(<Harness />);
    press({ code: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes on Ctrl+W", () => {
    render(<Harness />);
    press({ key: "w", ctrlKey: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes on Cmd+W", () => {
    render(<Harness />);
    press({ key: "w", metaKey: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves Ctrl+W alone once something else has handled it", () => {
    render(<Harness />);
    const claim = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", claim, { capture: true });
    press({ key: "w", ctrlKey: true });
    window.removeEventListener("keydown", claim, { capture: true });

    expect(close).not.toHaveBeenCalled();
  });

  it("runs the window's own accelerator", () => {
    const run = vi.fn();
    render(<Harness accelerator={{ key: "s", run }} />);
    const { preventDefault } = press({ key: "s", ctrlKey: true });

    expect(run).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("ignores Ctrl+Shift+W and Ctrl+Shift+S", () => {
    // Modifiers compare exactly, as `lib/keybindings`' `matches` does: a binding
    // that fires on any superset shadows every combination built on top of it.
    const run = vi.fn();
    render(<Harness accelerator={{ key: "s", run }} />);

    press({ key: "w", ctrlKey: true, shiftKey: true });
    press({ key: "s", ctrlKey: true, shiftKey: true });
    press({ key: "w", ctrlKey: true, altKey: true });

    expect(close).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores a bare letter that only matters with the accelerator", () => {
    const run = vi.fn();
    render(<Harness accelerator={{ key: "s", run }} />);
    press({ key: "s" });
    expect(run).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", async () => {
    const { unmount } = render(<Harness />);
    await settle();
    unmount();

    press({ key: "w", ctrlKey: true });
    expect(close).not.toHaveBeenCalled();
    expect(unlistenClose).toHaveBeenCalled();
  });

  it("cancels a subscription that has not landed yet", async () => {
    // Unmounting inside the same tick as the mount — a StrictMode double-render,
    // or a window closed the instant it opened. The handle arrives after the
    // cleanup has run, and has to be dropped rather than leaked.
    const { unmount } = render(<Harness />);
    unmount();
    await settle();

    expect(unlistenClose).toHaveBeenCalled();
  });
});

describe("the close guard", () => {
  it("lets the close through untouched when nothing is outstanding", async () => {
    // The synchronous `true` branch. Intercepting here would mean the window
    // destroys itself by hand for no reason, and every close would go the long
    // way round.
    render(<Harness onCloseRequest={() => true} />);
    const { intercepted } = await requestClose();

    expect(intercepted).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("takes the close over and destroys the window once the guard agrees", async () => {
    render(<Harness onCloseRequest={() => Promise.resolve(true)} />);
    const { intercepted } = await requestClose();

    expect(intercepted).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("keeps the window open when the guard refuses", async () => {
    render(<Harness onCloseRequest={() => Promise.resolve(false)} />);
    const { intercepted } = await requestClose();

    expect(intercepted).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("keeps the window open on a synchronous refusal too", async () => {
    render(<Harness onCloseRequest={() => false} />);
    const { intercepted } = await requestClose();

    expect(intercepted).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("closes rather than trapping the window when the guard throws", async () => {
    // The close is already intercepted by the time a rejection arrives, so refusing
    // would leave a window that cannot be shut and nothing on screen to say why.
    render(<Harness onCloseRequest={() => Promise.reject(new Error("boom"))} />);
    const { intercepted } = await requestClose();

    expect(intercepted).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("gets out of the way when the guard throws before it decides anything", async () => {
    // A synchronous throw happens before `preventDefault`, so Tauri is still free
    // to close the window — and leaving it to do so is one less thing to get wrong.
    render(
      <Harness
        onCloseRequest={() => {
          throw new Error("boom");
        }}
      />,
    );
    const { intercepted } = await requestClose();

    expect(intercepted).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("does nothing at all when the window has no guard", async () => {
    render(<Harness />);
    const { intercepted } = await requestClose();

    expect(intercepted).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("asks the guard the window last handed over", async () => {
    // The window rebuilds this closure whenever its buffer changes, and the stale
    // one would answer about a buffer that is no longer there.
    const stale = vi.fn(() => true);
    const fresh = vi.fn(() => true);
    const { rerender } = render(<Harness onCloseRequest={stale} />);
    rerender(<Harness onCloseRequest={fresh} />);

    await requestClose();

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });
});

describe("following the file", () => {
  it("subscribes to the watcher and passes events on", () => {
    const onRepoEvent = vi.fn();
    render(<Harness onRepoEvent={onRepoEvent} />);

    act(() => fireRepo?.());

    expect(onRepoEvent).toHaveBeenCalledOnce();
  });

  it("does not subscribe when the window has no target to follow", () => {
    window.history.replaceState({}, "", "/diff.html");
    render(<Harness onRepoEvent={vi.fn()} />);
    expect(onRepoChanged).not.toHaveBeenCalled();
  });

  it("does not subscribe when the window does not care", () => {
    render(<Harness />);
    expect(onRepoChanged).not.toHaveBeenCalled();
  });

  it("does not re-subscribe when the caller passes a fresh closure", () => {
    // The normal call site is an inline arrow, so a new function every render.
    const { rerender } = render(<Harness onRepoEvent={vi.fn()} />);
    rerender(<Harness onRepoEvent={vi.fn()} />);
    expect(onRepoChanged).toHaveBeenCalledOnce();
  });

  it("calls the newest callback, not the one it subscribed with", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = render(<Harness onRepoEvent={stale} />);
    rerender(<Harness onRepoEvent={fresh} />);

    act(() => fireRepo?.());

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<Harness onRepoEvent={vi.fn()} />);
    await settle();
    unmount();
    expect(unlistenRepo).toHaveBeenCalled();
  });
});
