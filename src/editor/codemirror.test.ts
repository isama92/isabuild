import { describe, expect, it } from "vitest";
import { defaultKeymap } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  editableExtension,
  editableTransaction,
  PANE_KEYMAP,
  paneExtensions,
  readOnlyExtensions,
  readOnlyFocusableExtensions,
  searchExtensions,
  themeTransaction,
} from "./codemirror";
import { DEFAULT_THEME, themeById } from "../theme/themes";
import { ACTIONS } from "../lib/keybindings";

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
  it("makes a pane read-only and unfocusable", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "blob\n",
        extensions: [...paneExtensions(), ...readOnlyExtensions()],
      }),
    });
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    view.destroy();
  });
});

describe("readOnlyFocusableExtensions", () => {
  it("makes a pane read-only but still focusable", () => {
    // The diff window's HEAD pane. Losing focusability would lose Ctrl+F with it:
    // a keystroke never reaches a pane that cannot take focus.
    const view = new EditorView({
      state: EditorState.create({
        doc: "blob\n",
        extensions: [...paneExtensions(), ...readOnlyFocusableExtensions()],
      }),
    });
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
    view.destroy();
  });
});

describe("editableExtension", () => {
  it("seeds a pane either way", () => {
    const writable = EditorState.create({ extensions: [editableExtension(true)] });
    const frozen = EditorState.create({ extensions: [editableExtension(false)] });
    expect(writable.readOnly).toBe(false);
    expect(frozen.readOnly).toBe(true);
  });

  it("flips a live pane without touching its content", () => {
    // The diff window's case: a refresh finds the file deleted, so the pane it
    // has been editing must stop accepting edits — and must not lose them.
    const view = new EditorView({
      state: EditorState.create({
        doc: "typed\n",
        extensions: [...paneExtensions(), editableExtension(true)],
      }),
    });

    view.dispatch(editableTransaction(false));

    expect(view.state.readOnly).toBe(true);
    expect(view.state.doc.toString()).toBe("typed\n");
    view.destroy();
  });
});

describe("searchExtensions", () => {
  it("opens its panel above the editor", () => {
    // Below would push one pane's content out of step with the other, which are
    // aligned line for line. Asserted by actually opening it: with no panel on
    // screen, "there is no bottom panel" passes whatever `top` is set to.
    // Attached, unlike most views in this file: CodeMirror's panel plumbing only
    // materialises for a view that is actually in the document.
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "one\ntwo\n",
        extensions: [...paneExtensions(), ...searchExtensions()],
      }),
    });

    openSearchPanel(view);

    expect(view.dom.querySelector(".cm-panels-top .cm-search")).toBeInTheDocument();
    expect(view.dom.querySelector(".cm-panels-bottom")).toBeNull();
    view.destroy();
  });
});

describe("PANE_KEYMAP", () => {
  it("gives up the combinations the app binds to its own navigation", () => {
    // `defaultKeymap` maps Alt+ArrowUp/Down to moveLineUp/moveLineDown, and those
    // are also the defaults for next/previous change and next/previous conflict.
    // CodeMirror wins that race and marks the event handled, so the keystroke would
    // silently reorder lines — and in the diff window auto-save would put the
    // reordered file on disk 400 ms later.
    const claimed = PANE_KEYMAP.filter((binding) =>
      [binding.key, binding.mac, binding.win, binding.linux].some(
        (chord) => chord === "Alt-ArrowUp" || chord === "Alt-ArrowDown",
      ),
    );
    expect(claimed).toEqual([]);
  });

  /**
   * Chords a pane is *allowed* to consume before the window sees them.
   *
   * Only Escape, and deliberately: `useWindowKeybindings` skips an event something
   * else has handled, which is what lets Escape dismiss the find panel first and
   * close the window only when there was no panel to dismiss.
   */
  const SHARED_WITH_THE_PANES = new Set(["Escape"]);

  it("gives up every chord the diff and merge windows bind, on every platform", () => {
    // The generalisation of the case above, and the reason it is generalised: the
    // horizontal Alt+Arrow pair went into the registry without going in here, and
    // nothing failed — the window tests dispatch on `window` with no CodeMirror in
    // the loop, so a keybinding that could never fire in the app looked covered.
    //
    // Derived from the registry rather than listed, so the next accelerator added
    // to a pane's scope is checked against what the panes already eat, on every
    // platform's spelling rather than just `key`.
    const asChords = new Set(
      ACTIONS.filter(
        (action) => action.scopes.includes("diff") || action.scopes.includes("merge"),
      )
        .map((action) => action.defaultAccelerator)
        .filter((accelerator) => !SHARED_WITH_THE_PANES.has(accelerator))
        // The registry spells a chord "Alt+PageDown"; CodeMirror spells it
        // "Alt-PageDown". Same thing, different separator.
        .map((accelerator) => accelerator.replace(/\+/g, "-")),
    );

    const collisions = PANE_KEYMAP.filter((binding) =>
      [binding.key, binding.mac, binding.win, binding.linux].some(
        (chord) => chord !== undefined && asChords.has(chord),
      ),
    ).map((binding) => binding.key ?? binding.mac);

    expect(collisions).toEqual([]);
  });

  it("keeps the shifted pair, which the app has not bound", () => {
    // copyLineUp/copyLineDown. An Alt-modified arrow may still change the file; what
    // must not happen is the *unshifted* pair doing it while looking like navigation.
    const shifted = PANE_KEYMAP.filter(
      (binding) =>
        binding.key === "Shift-Alt-ArrowUp" || binding.key === "Shift-Alt-ArrowDown",
    );
    expect(shifted).toHaveLength(2);
  });

  it("keeps everything else defaultKeymap offers", () => {
    // A blanket replacement would cost the panes their editing keys; this drops two
    // bindings and nothing else.
    expect(PANE_KEYMAP).toHaveLength(defaultKeymap.length - 2);
    expect(PANE_KEYMAP.some((binding) => binding.key === "Mod-a")).toBe(true);
  });

  it("leaves Alt+Arrow unhandled, so the window's binding can have it", () => {
    // The end of the chain that matters: `useWindowKeybindings` skips an event
    // something else has already handled, so "unhandled here" is what makes the
    // navigation keybinding reachable at all.
    const view = new EditorView({
      state: EditorState.create({
        doc: "one\ntwo\nthree\n",
        extensions: [...paneExtensions(), keymap.of([...PANE_KEYMAP])],
      }),
    });
    view.dispatch({ selection: { anchor: 0 } });

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      code: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree\n");
    view.destroy();
  });
});

describe("the merge-view rules", () => {
  it("tints each side's changed lines from the theme, not from the package", () => {
    // @codemirror/merge's base theme hardcodes a brown for side a and a green
    // for side b; both have to lose to the registry or the diff window paints
    // colours no theme chose.
    const theme = themeById("vscode-light");
    const view = new EditorView({ state: stateWith(theme) });
    const css = injectedCss();

    expect(css).toContain(theme.tokens.diffDeletedBg);
    expect(css).toContain(theme.tokens.diffInsertedBg);
    expect(css).toContain(theme.tokens.diffChangedText);
    expect(css).toContain(".cm-merge-a .cm-changedLine");
    expect(css).toContain(".cm-merge-b .cm-changedLine");
    view.destroy();
  });

  it("styles the widgets that live inside a pane", () => {
    // Spacers and the collapsed-lines band are both WidgetTypes in the editor's
    // own content, so a scoped theme rule reaches them.
    const view = new EditorView({ state: stateWith() });
    const css = injectedCss();
    expect(css).toContain(".cm-collapsedLines");
    expect(css).toContain(".cm-mergeSpacer");
    view.destroy();
  });

  it("leaves the revert control to the stylesheet", () => {
    // `.cm-merge-revert` is a sibling of the two editors, so an EditorView.theme
    // rule would compile scoped to an editor root and never match it. If this
    // starts failing, the `»` has silently lost its colours.
    const view = new EditorView({ state: stateWith() });
    expect(injectedCss()).not.toContain("cm-merge-revert");
    view.destroy();
  });
});
