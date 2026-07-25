import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WelcomeScreen } from "./WelcomeScreen";
import { initialProjectState, useProjectStore } from "../store/projectStore";
import type { RecentProject, RecentState } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function recent(path: string, state: RecentState = "ok"): RecentProject {
  return { path, name: path.split("/").pop() ?? path, state };
}

const open = vi.fn();
const openWithPicker = vi.fn();
const removeRecent = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({
    ...initialProjectState,
    phase: "welcome",
    open,
    openWithPicker,
    removeRecent,
  });
});

describe("WelcomeScreen", () => {
  it("says so when there are no recent projects", () => {
    render(<WelcomeScreen />);
    expect(screen.getByText("No recent projects yet.")).toBeInTheDocument();
  });

  it("opens the picker from the main button", () => {
    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
    expect(openWithPicker).toHaveBeenCalledTimes(1);
  });

  it("lists each recent project with its name and full path", () => {
    // Two projects can share a name; the path is what tells them apart.
    useProjectStore.setState({ recents: [recent("/repos/api"), recent("/work/api")] });
    render(<WelcomeScreen />);

    expect(screen.getAllByText("api")).toHaveLength(2);
    expect(screen.getByText("/repos/api")).toBeInTheDocument();
    expect(screen.getByText("/work/api")).toBeInTheDocument();
  });

  it("opens a recent project when its row is clicked", () => {
    useProjectStore.setState({ recents: [recent("/repos/one")] });
    render(<WelcomeScreen />);

    fireEvent.click(screen.getByText("/repos/one"));
    expect(open).toHaveBeenCalledWith("/repos/one");
  });

  it("marks a missing folder instead of dropping it from the list", () => {
    useProjectStore.setState({ recents: [recent("/repos/gone", "missing")] });
    render(<WelcomeScreen />);

    expect(screen.getByText("/repos/gone")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  it("says when a folder is still there but is no longer a repository", () => {
    // A different problem with a different fix; "missing" would be a lie about
    // a folder the user can see in their file manager.
    useProjectStore.setState({ recents: [recent("/repos/plain", "notARepo")] });
    render(<WelcomeScreen />);

    expect(screen.getByText("not a repository")).toBeInTheDocument();
  });

  it("removes a recent project from its ×, identified by path", () => {
    useProjectStore.setState({ recents: [recent("/repos/one")] });
    render(<WelcomeScreen />);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove /repos/one from recent projects" }),
    );
    expect(removeRecent).toHaveBeenCalledWith("/repos/one");
  });

  it("shows why the last project would not reopen, and dismisses it", () => {
    useProjectStore.setState({ error: "'/repos/gone' no longer exists" });
    render(<WelcomeScreen />);

    expect(screen.getByRole("alert")).toHaveTextContent("no longer exists");
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("shows a settings warning as a status rather than an alert", () => {
    useProjectStore.setState({ notice: "settings kept as config.json.bak" });
    render(<WelcomeScreen />);
    expect(screen.getByRole("status")).toHaveTextContent("config.json.bak");
  });

  it("offers the launch folder when it is not already in the list", () => {
    useProjectStore.setState({ launchFolder: recent("/repos/here") });
    render(<WelcomeScreen />);

    const button = screen.getByRole("button", { name: /Open the current folder/ });
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith("/repos/here");
  });

  it("does not offer the launch folder when it is already a recent", () => {
    // It would just be the same row twice.
    useProjectStore.setState({
      launchFolder: recent("/repos/here"),
      recents: [recent("/repos/here")],
    });
    render(<WelcomeScreen />);

    expect(screen.queryByRole("button", { name: /Open the current folder/ })).toBeNull();
  });

  it("disables every control while an open is in flight", () => {
    useProjectStore.setState({ busy: true, recents: [recent("/repos/one")] });
    render(<WelcomeScreen />);

    expect(screen.getByRole("button", { name: "Open folder…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove /repos/one from recent projects" }),
    ).toBeDisabled();
  });
});
