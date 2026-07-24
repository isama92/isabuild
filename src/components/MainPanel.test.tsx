import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CLAUDE_INSTALL_URL, MainPanel } from "./MainPanel";

const hoisted = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock("./TerminalView", () => ({
  TerminalView: (props: Record<string, unknown>) => {
    hoisted.props.push(props);
    return <div data-testid={`term-${String(props.sessionId)}`} />;
  },
}));

beforeEach(() => {
  hoisted.props.length = 0;
});

describe("MainPanel", () => {
  it("renders the Claude Code terminal with install guidance and autofocus", () => {
    render(<MainPanel />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(hoisted.props.at(-1)).toMatchObject({
      sessionId: "claude-main",
      cmd: "claude",
      label: "Claude Code",
      installHintUrl: CLAUDE_INSTALL_URL,
      autoFocus: true,
    });
  });
});
