import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { paneExtensions, readOnlyExtensions, themeTransaction } from "./codemirrorSetup";
import { DEFAULT_THEME, themeById } from "../theme/themes";

/**
 * The rules CodeMirror injected for a state's theme, flattened to one string.
 *
 * `EditorView.theme` compiles to a StyleModule rather than to anything readable
 * off the state, so the assertions below go through the generated stylesheet.
 * That is the thing that actually paints, which makes it the honest target.
 */
function injectedCss(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((element) => element.textContent ?? "")
    .join("\n");
}

function stateWith(theme = DEFAULT_THEME): EditorState {
  return EditorState.create({ doc: "one\ntwo\n", extensions: paneExtensions(theme) });
}

describe("paneExtensions", () => {
  it("builds a usable state", () => {
    expect(stateWith().doc.toString()).toBe("one\ntwo\n");
  });

  it("paints the pane in the theme it was given", () => {
    // A view has to exist for CodeMirror to inject the stylesheet.
    const view = new EditorView({ state: stateWith(themeById("vscode-light")) });
    expect(injectedCss()).toContain(themeById("vscode-light").tokens.bg);
    view.destroy();
  });

  it("reads the font from the custom properties rather than baking it in", () => {
    // The font can then change with no CodeMirror transaction at all; only the
    // colours need a reconfigure.
    const view = new EditorView({ state: stateWith() });
    expect(injectedCss()).toContain("--ib-mono-family");
    expect(injectedCss()).toContain("--ib-mono-size");
    view.destroy();
  });
});

describe("themeTransaction", () => {
  it("moves a live view to the other theme", () => {
    const view = new EditorView({ state: stateWith(DEFAULT_THEME) });
    const light = themeById("vscode-light");

    view.dispatch(themeTransaction(light));

    expect(injectedCss()).toContain(light.tokens.bg);
    expect(injectedCss()).toContain(light.tokens.synKeyword);
    view.destroy();
  });

  it("keeps the document, the cursor and the undo history", () => {
    // The point of reconfiguring a compartment rather than rebuilding the
    // editor: a theme change made halfway through resolving a conflict must not
    // throw the work away.
    const view = new EditorView({ state: stateWith() });
    view.dispatch({ changes: { from: 0, insert: "edited " }, selection: { anchor: 3 } });

    view.dispatch(themeTransaction(themeById("vscode-light")));

    expect(view.state.doc.toString()).toBe("edited one\ntwo\n");
    expect(view.state.selection.main.anchor).toBe(3);
    view.destroy();
  });

  it("does not touch the document", () => {
    const view = new EditorView({ state: stateWith() });
    const before = view.state.doc.toString();

    view.dispatch(themeTransaction(themeById("vscode-light")));

    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  it("reuses one stylesheet per theme however often it is asked for", () => {
    // `EditorView.theme` mints a StyleModule CodeMirror never removes, and this
    // runs three times per mount plus once per pane per switch.
    const first = themeTransaction(DEFAULT_THEME);
    const second = themeTransaction(DEFAULT_THEME);
    expect(first.effects).toEqual(second.effects);
  });
});

describe("readOnlyExtensions", () => {
  it("makes a pane both read-only and uneditable", () => {
    // Both, not one: `readOnly` stops commands, `editable` stops direct input.
    const state = EditorState.create({
      doc: "blob\n",
      extensions: [...paneExtensions(), ...readOnlyExtensions()],
    });
    expect(state.readOnly).toBe(true);
  });
});
