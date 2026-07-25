import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { initialProjectState, useProjectStore } from "./projectStore";
import { initialSettingsState, useSettingsStore } from "./settingsStore";
import { initialGitState, useGitStore } from "./gitStore";
import type { Bootstrap, Project, RecentProject, RecentState, Settings } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    theme: "vscode-dark",
    fontFamily: "",
    fontSize: 14,
    keybindings: {},
    lastProject: null,
    recentProjects: [],
    ...overrides,
  };
}

function recent(path: string, state: RecentState = "ok"): RecentProject {
  return { path, name: path.split("/").pop() ?? path, state };
}

const PROJECT: Project = { repoRoot: "/repos/one", name: "one" };

function bootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    settings: settings(),
    recents: [],
    project: null,
    projectError: null,
    settingsWarning: null,
    launchFolder: null,
    ...overrides,
  };
}

/** Route each invoke by command name, the gitStore.test.ts pattern. */
function routeInvokes(routes: Record<string, unknown>) {
  invokeMock.mockImplementation((command: string) => {
    if (!(command in routes)) return Promise.resolve(undefined);
    const value = routes[command];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState(initialProjectState);
  useSettingsStore.setState(initialSettingsState);
  useGitStore.setState(initialGitState);
});

describe("start", () => {
  it("goes to the welcome screen when nothing was open", async () => {
    routeInvokes({ bootstrap: bootstrap({ recents: [recent("/repos/one")] }) });
    await useProjectStore.getState().start();

    const state = useProjectStore.getState();
    expect(state.phase).toBe("welcome");
    expect(state.project).toBeNull();
    expect(state.recents).toHaveLength(1);
  });

  it("reopens the last project straight into the workspace", async () => {
    routeInvokes({ bootstrap: bootstrap({ project: PROJECT }) });
    await useProjectStore.getState().start();

    expect(useProjectStore.getState().phase).toBe("open");
    expect(useProjectStore.getState().project).toEqual(PROJECT);
  });

  it("adopts the settings that arrive with the bootstrap payload", async () => {
    // One round trip, so the appearance is right on the very first paint.
    routeInvokes({ bootstrap: bootstrap({ settings: settings({ fontSize: 18 }) }) });
    await useProjectStore.getState().start();
    expect(useSettingsStore.getState().settings?.fontSize).toBe(18);
  });

  it("shows why the remembered project would not reopen, keeping it in the list", async () => {
    routeInvokes({
      bootstrap: bootstrap({
        projectError: "'/repos/gone' no longer exists",
        recents: [recent("/repos/gone", "missing")],
      }),
    });
    await useProjectStore.getState().start();

    const state = useProjectStore.getState();
    expect(state.phase).toBe("welcome");
    expect(state.error).toContain("no longer exists");
    expect(state.recents[0].state).toBe("missing");
  });

  it("surfaces a settings-file warning as a notice, not an error", async () => {
    routeInvokes({ bootstrap: bootstrap({ settingsWarning: "kept as config.json.bak" }) });
    await useProjectStore.getState().start();

    expect(useProjectStore.getState().notice).toContain("config.json.bak");
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("still reaches the welcome screen when bootstrap itself fails", async () => {
    routeInvokes({ bootstrap: new Error("backend unavailable") });
    await useProjectStore.getState().start();

    expect(useProjectStore.getState().phase).toBe("welcome");
    expect(useProjectStore.getState().error).toContain("backend unavailable");
  });
});

describe("open", () => {
  it("moves to the workspace and refreshes the recents", async () => {
    routeInvokes({ project_open: PROJECT, recent_projects: [recent("/repos/one")] });
    await useProjectStore.getState().open("/repos/one");

    const state = useProjectStore.getState();
    expect(state.phase).toBe("open");
    expect(state.project).toEqual(PROJECT);
    expect(state.recents).toEqual([recent("/repos/one")]);
    expect(state.busy).toBe(false);
  });

  it("clears the previous repo's git state", async () => {
    // The git store is a module singleton: without the reset the remounted
    // Layout renders the old repo's file list for a frame.
    useGitStore.setState({ repoRoot: "/repos/old", phase: "ready" });
    routeInvokes({ project_open: PROJECT, recent_projects: [] });

    await useProjectStore.getState().open("/repos/one");

    expect(useGitStore.getState().repoRoot).toBeNull();
    expect(useGitStore.getState().phase).toBe("idle");
    // A merge reset, so the actions survive.
    expect(typeof useGitStore.getState().refresh).toBe("function");
  });

  it("stays where it is and says why when the folder is not a repo", async () => {
    useProjectStore.setState({ phase: "welcome" });
    routeInvokes({
      project_open: new Error("'/tmp/plain' is not inside a git repository"),
      recent_projects: [],
    });

    await useProjectStore.getState().open("/tmp/plain");

    const state = useProjectStore.getState();
    expect(state.phase).toBe("welcome");
    expect(state.project).toBeNull();
    expect(state.error).toContain("not inside a git repository");
    expect(state.busy).toBe(false);
  });

  it("refuses to start a second open while one is in flight", async () => {
    useProjectStore.setState({ busy: true });
    await useProjectStore.getState().open("/repos/one");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("openWithPicker", () => {
  it("opens whatever the picker returned", async () => {
    routeInvokes({ pick_folder: "/repos/two", project_open: PROJECT, recent_projects: [] });
    await useProjectStore.getState().openWithPicker();
    expect(invokeMock).toHaveBeenCalledWith("project_open", { path: "/repos/two" });
  });

  it("does nothing at all when the picker is cancelled", async () => {
    routeInvokes({ pick_folder: null });
    await useProjectStore.getState().openWithPicker();

    expect(invokeMock).not.toHaveBeenCalledWith("project_open", expect.anything());
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("reports a picker that could not be opened", async () => {
    routeInvokes({ pick_folder: new Error("no portal") });
    await useProjectStore.getState().openWithPicker();
    expect(useProjectStore.getState().error).toContain("no portal");
  });
});

describe("close", () => {
  it("returns to the welcome screen and forgets the project", async () => {
    useProjectStore.setState({ phase: "open", project: PROJECT });
    useGitStore.setState({ repoRoot: "/repos/one" });
    routeInvokes({ project_close: undefined, recent_projects: [recent("/repos/one")] });

    await useProjectStore.getState().close();

    const state = useProjectStore.getState();
    expect(state.phase).toBe("welcome");
    expect(state.project).toBeNull();
    expect(useGitStore.getState().repoRoot).toBeNull();
  });

  it("stays in the workspace when the backend refuses", async () => {
    useProjectStore.setState({ phase: "open", project: PROJECT });
    routeInvokes({ project_close: new Error("could not stop the watcher") });

    await useProjectStore.getState().close();

    expect(useProjectStore.getState().phase).toBe("open");
    expect(useProjectStore.getState().error).toContain("could not stop the watcher");
    expect(useProjectStore.getState().busy).toBe(false);
  });
});

describe("removeRecent", () => {
  it("adopts the list the backend returns", async () => {
    useProjectStore.setState({ recents: [recent("/a"), recent("/b")] });
    routeInvokes({ recent_remove: [recent("/b")] });

    await useProjectStore.getState().removeRecent("/a");

    expect(useProjectStore.getState().recents).toEqual([recent("/b")]);
    expect(invokeMock).toHaveBeenCalledWith("recent_remove", { path: "/a" });
  });

  it("keeps the list it had when the removal fails", async () => {
    useProjectStore.setState({ recents: [recent("/a")] });
    routeInvokes({ recent_remove: new Error("disk full") });

    await useProjectStore.getState().removeRecent("/a");

    expect(useProjectStore.getState().recents).toEqual([recent("/a")]);
    expect(useProjectStore.getState().error).toContain("disk full");
  });
});
