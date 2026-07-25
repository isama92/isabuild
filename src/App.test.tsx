import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import App from "./App";
import { initialProjectState, useProjectStore } from "./store/projectStore";
import type { Project } from "./lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
// The workspace and its PTYs are covered by Layout's own tests; here the only
// question is *whether* it is mounted, and with which key.
vi.mock("./components/Layout", () => ({
  Layout: () => <div data-testid="workspace" />,
}));
vi.mock("./hooks/useAppearance", () => ({ useAppearance: vi.fn() }));

const start = vi.fn().mockResolvedValue(undefined);
const close = vi.fn();

const PROJECT: Project = { repoRoot: "/repos/one", name: "one" };

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ ...initialProjectState, start, close });
});

describe("App", () => {
  it("renders neither screen until it knows which is right", () => {
    // A welcome screen shown for one frame and then replaced would flash on
    // every launch.
    render(<App />);
    expect(screen.getByRole("status", { name: "Starting isabuild" })).toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).toBeNull();
  });

  it("reads the persisted state on mount", async () => {
    render(<App />);
    await act(tick);
    expect(start).toHaveBeenCalled();
  });

  it("shows the welcome screen when no project is open", async () => {
    useProjectStore.setState({ phase: "welcome" });
    render(<App />);
    await act(tick);

    expect(screen.getByText("Open folder…")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).toBeNull();
  });

  it("mounts the workspace once a project is open", async () => {
    useProjectStore.setState({ phase: "open", project: PROJECT });
    render(<App />);
    await act(tick);

    expect(screen.getByTestId("workspace")).toBeInTheDocument();
    expect(screen.queryByText("Open folder…")).toBeNull();
  });

  it("surfaces an error while the workspace is up, where no welcome screen can", async () => {
    // Every menu failure with a project open (a picker that would not open, a
    // recent project since deleted) would otherwise be a click that silently
    // did nothing.
    useProjectStore.setState({ phase: "open", project: PROJECT });
    render(<App />);
    await act(tick);

    act(() => useProjectStore.setState({ error: "could not open the folder picker" }));
    expect(screen.getByRole("alert")).toHaveTextContent("could not open the folder picker");

    act(() => screen.getByRole("button", { name: "Dismiss" }).click());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves the error to the welcome screen when that is what is showing", async () => {
    // The welcome screen renders `error` in place, so the toast must not add a
    // second banner saying the same thing.
    useProjectStore.setState({ phase: "welcome", error: "'/repos/gone' no longer exists" });
    const { container } = render(<App />);
    await act(tick);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(container.querySelector(".app-error")).toBeNull();
  });

  it("swaps back to the welcome screen when the project closes", async () => {
    useProjectStore.setState({ phase: "open", project: PROJECT });
    render(<App />);
    await act(tick);

    act(() => useProjectStore.setState({ phase: "welcome", project: null }));

    expect(screen.queryByTestId("workspace")).toBeNull();
    expect(screen.getByText("Open folder…")).toBeInTheDocument();
  });
});
