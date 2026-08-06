// One-time CodeMirror wiring for every editor pane in the app: theme,
// highlighting, and the extensions the panes share. Used by the merge window's
// three panes and by the diff window's two.
//
// Composed by hand. There is no `basicSetup` import — that bundle brings
// autocompletion, lint gutters and a fold gutter, none of which belong in a pane
// for reviewing or resolving a file, and its line numbers would fight the merge
// window's chunk gutter. Search is the one exception, and it is opt-in
// (`searchExtensions`) rather than shared: the diff window replaces a find bar
// Monaco used to provide, and three find panels in the merge window at once
// would be three answers to one question.
//
// Every colour comes from the theme registry (src/theme/themes), the same source
// the CSS reads, so the windows agree by construction rather than by hand-copied
// palettes staying in step. That includes `@codemirror/merge`'s own classes: its
// base theme ships hardcoded reds and greens, and the rules here override them
// from tokens.
//
// The theme and the highlight style live in a Compartment each. A theme change
// is then one `reconfigure` transaction on a live view, rather than rebuilding
// the editor and losing the cursor, the scroll position and the undo history.

import { defaultKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, type KeyBinding } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { FONT_FAMILY_VAR, FONT_SIZE_VAR } from "../lib/appearance";
import { DEFAULT_THEME, type Theme } from "../theme/themes";

/** Chunk tints for the pane backgrounds. */
function paneColors(theme: Theme) {
  return {
    ours: theme.tokens.chunkOurs,
    theirs: theme.tokens.chunkTheirs,
    conflict: theme.tokens.chunkConflict,
    agreed: theme.tokens.chunkAgreed,
  } as const;
}

/**
 * Syntax colours, from the theme's tokens.
 *
 * CodeMirror's `defaultHighlightStyle` is built for a light background, so on a
 * dark one its near-black keywords are unreadable; and its scope set is much
 * larger than a merge pane needs. Every pane in the app reads this one style,
 * so a file looks identical in the diff window and here by construction.
 */
function highlightFor(theme: Theme): HighlightStyle {
  const t = theme.tokens;
  return HighlightStyle.define([
    { tag: tags.keyword, color: t.synKeyword },
    { tag: [tags.name, tags.deleted, tags.character, tags.propertyName], color: t.synVariable },
    { tag: [tags.function(tags.variableName), tags.labelName], color: t.synFunction },
    { tag: [tags.typeName, tags.className, tags.tagName], color: t.synType },
    { tag: [tags.number, tags.bool, tags.null], color: t.synNumber },
    { tag: [tags.string, tags.special(tags.string)], color: t.synString },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment],
      color: t.synComment,
      fontStyle: "italic",
    },
    { tag: [tags.operator, tags.punctuation], color: t.synOperator },
    { tag: tags.invalid, color: t.synInvalid },
  ]);
}

function themeFor(theme: Theme): Extension {
  const t = theme.tokens;
  const chunks = paneColors(theme);
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: t.bg,
        color: t.textBright,
        // The font setting, via the custom properties `lib/appearance` writes
        // on the document root. Reading them here rather than through this
        // compartment means a font change repaints with no CodeMirror
        // transaction at all; MergePanes only has to ask the views to
        // re-measure afterwards.
        fontSize: `var(${FONT_SIZE_VAR}, 12px)`,
      },
      ".cm-scroller": {
        fontFamily: `var(${FONT_FAMILY_VAR}, 'JetBrains Mono', ui-monospace, monospace)`,
        lineHeight: "1.5",
        // Never wrap: a wrapped line breaks the correspondence between what is
        // on screen and what is in the file, and it desynchronises the panes'
        // scroll heights on top of that.
        overflowX: "auto",
      },
      ".cm-content": { caretColor: t.textBright },
      ".cm-gutters": {
        backgroundColor: t.bg,
        color: t.lineNumber,
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: "transparent" },
      ".cm-activeLineGutter": { backgroundColor: "transparent" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: t.selection,
      },
      // Chunk tints, applied as line decorations by MergePanes.
      ".cm-line.isabuild-chunk-ours": { backgroundColor: chunks.ours },
      ".cm-line.isabuild-chunk-theirs": { backgroundColor: chunks.theirs },
      ".cm-line.isabuild-chunk-conflict": { backgroundColor: chunks.conflict },
      ".cm-line.isabuild-chunk-agreed": { backgroundColor: chunks.agreed },
      // A marker line in the result buffer. It is real text the user can edit,
      // so it is styled to read as structure rather than as code.
      ".cm-line.isabuild-marker": {
        color: t.conflict,
        backgroundColor: t.chunkConflict,
        fontStyle: "italic",
      },
      // The chunk gutter: an arrow per actionable chunk, on the seam between the
      // side it takes from and the result. `display: flex` rather than
      // `text-align`, because the marker is an `<svg>` now rather than a glyph.
      ".cm-gutterElement.isabuild-arrow": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: t.textDim,
        width: "16px",
      },
      ".cm-gutterElement.isabuild-arrow:hover": { color: t.textBright },
      ".cm-gutterElement.isabuild-arrow svg": { width: "14px", height: "14px" },
      // The arrow column sits against the pane's edge with nothing between it and
      // the next pane, so it needs the seam drawn. The package gives
      // `.cm-gutters-after` a left border in its light theme only; both sides get
      // one here, from the registry.
      ".cm-gutters.isabuild-arrow-gutter, .cm-gutters-after": {
        borderLeft: `1px solid ${t.border}`,
      },

      // --- @codemirror/merge's own classes, retinted from the registry -------
      //
      // `cm-merge-a`/`cm-merge-b` are classes the package puts on each editor
      // root, so the two sides can say different things with the same class: on
      // the left a changed line is what HEAD had, on the right what the file has
      // now. Its base theme hardcodes a brown and a green for these; both are
      // overridden here.
      "&.cm-merge-a .cm-changedLine": { backgroundColor: t.diffDeletedBg },
      "&.cm-merge-b .cm-changedLine": { backgroundColor: t.diffInsertedBg },
      // The characters that actually differ within a changed line. One colour
      // for both sides, and the same blue the overview strip uses for "changed":
      // which side you are looking at already says whether it went or arrived.
      // A background rather than the package's underline gradient, which is
      // nearly invisible at 12px.
      "&.cm-merge-a .cm-changedText, &.cm-merge-b .cm-changedText": {
        background: t.diffChangedText,
      },
      // Alignment padding. Deliberately not `bg`: an empty stretch opposite an
      // insertion should read as "nothing here", not as blank file.
      ".cm-mergeSpacer": { backgroundColor: t.bgChrome },
      // The band standing in for a collapsed run of unchanged lines.
      ".cm-collapsedLines": {
        color: t.textDim,
        backgroundColor: t.bgChrome,
        // The package draws a vertical gradient here, which reads as a seam in a
        // themed window. Flat, with the borders doing the separating.
        background: "none",
        borderTop: `1px solid ${t.border}`,
        borderBottom: `1px solid ${t.border}`,
      },
      // The revert control of the *two-pane* view is deliberately not styled here:
      // `.cm-merge-revert` is a sibling of the two editors rather than a part of
      // either, so an `EditorView.theme` rule — which compiles scoped to an editor
      // root — could never match it. It lives in editorWindow.css.

      // --- the one-pane view's deleted lines ---------------------------------
      //
      // These *are* inside the editor root, so unlike `.cm-merge-revert` a scoped
      // rule reaches them. All of them are hardcoded in the package's base theme
      // (a brown, a red and a green picked for a white page), and all of them are
      // overridden. `.cm-deletedChunk` is the block standing in for what HEAD had,
      // so it carries the same tint the left pane's changed lines do.
      ".cm-deletedChunk": {
        backgroundColor: t.diffDeletedBg,
        color: t.text,
        paddingLeft: "6px",
      },
      ".cm-deletedChunk .cm-deletedText": {
        // The package draws a 2px underline gradient here, which is all but
        // invisible at 12px. A background, matching the two-pane view's
        // `.cm-changedText`.
        background: t.diffChangedText,
      },
      // `del` for the deleted lines is the package's markup, not a decision the
      // theme should honour: a whole block already reads as removed, and a struck
      // -through code block is unreadable.
      ".cm-deletedLine, .cm-deletedLine del": { textDecoration: "none" },
      // The restore-from-HEAD control, one per changed block. The package
      // positions it; the colours are ours, and match the two-pane view's.
      ".cm-deletedChunk .cm-chunkButtons button": {
        border: "none",
        borderRadius: "2px",
        background: "none",
        color: t.textDim,
        cursor: "pointer",
        lineHeight: 1,
        padding: 0,
        margin: "0 2px",
      },
      ".cm-deletedChunk .cm-chunkButtons button:hover": { color: t.textBright },
      // `iconElement` deliberately ships no `width`/`height`, so every call site
      // has to size its own — and an unsized outermost `<svg>` does not shrink to
      // nothing, it falls back to the default object size. Without this the
      // chevron would be enormous.
      ".cm-deletedChunk .cm-chunkButtons button svg": {
        display: "block",
        width: "14px",
        height: "14px",
      },
      // Only reachable with `allowInlineDiffs`, which is off — but the package's
      // green would survive a later decision to turn it on, so it is retinted now.
      ".cm-inlineChangedLine": { backgroundColor: t.diffInsertedBg },

      // --- the find panel ----------------------------------------------------
      ".cm-panels": { backgroundColor: t.bgChrome, color: t.text },
      ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${t.border}` },
      ".cm-panel.cm-search": { padding: "4px 6px", fontFamily: "inherit" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        backgroundColor: t.bg,
        color: t.text,
        border: `1px solid ${t.border}`,
        borderRadius: "2px",
      },
      ".cm-panel.cm-search button:hover": { borderColor: t.borderStronger },
      ".cm-panel.cm-search label": { color: t.textDim },
      ".cm-searchMatch": { backgroundColor: t.chunkAgreed },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: t.selection },
    },
    { dark: theme.dark },
  );
}

const themeCompartment = new Compartment();
const highlightCompartment = new Compartment();

// `EditorView.theme` and `HighlightStyle.define` each mint a StyleModule that
// CodeMirror injects and never removes, and these are called three times per
// mount plus once per pane per theme change. There are two themes, so caching
// by identity bounds the injected stylesheets at two apiece.
const themeCache = new Map<Theme, Extension>();
const highlightCache = new Map<Theme, Extension>();

function cachedTheme(theme: Theme): Extension {
  const cached = themeCache.get(theme);
  if (cached !== undefined) return cached;
  const built = themeFor(theme);
  themeCache.set(theme, built);
  return built;
}

function cachedHighlight(theme: Theme): Extension {
  const cached = highlightCache.get(theme);
  if (cached !== undefined) return cached;
  const built = syntaxHighlighting(highlightFor(theme), { fallback: true });
  highlightCache.set(theme, built);
  return built;
}

/** Extensions every pane shares. */
export function paneExtensions(theme: Theme = DEFAULT_THEME): Extension[] {
  return [
    lineNumbers(),
    themeCompartment.of(cachedTheme(theme)),
    highlightCompartment.of(cachedHighlight(theme)),
  ];
}

/**
 * The transaction that moves a live view to `theme`. One reconfigure rather
 * than a rebuild, so the cursor, the scroll position and the undo history all
 * survive a theme change made while a conflict is half resolved.
 */
export function themeTransaction(theme: Theme): TransactionSpec {
  return {
    effects: [
      themeCompartment.reconfigure(cachedTheme(theme)),
      highlightCompartment.reconfigure(cachedHighlight(theme)),
    ],
  };
}

/**
 * The merge window's side panes: ours and theirs are git blobs and can never be
 * written, and there is nothing to do in them but click an arrow.
 *
 * `editable.of(false)` is the strong form — it drops `contenteditable` as well, so
 * the pane cannot even be focused. That is right here and wrong for the diff
 * window's HEAD pane; see [`readOnlyFocusableExtensions`].
 */
export function readOnlyExtensions(): Extension[] {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}

/**
 * The diff window's HEAD pane: unwritable, but you can put a cursor in it.
 *
 * `EditorState.readOnly` is what refuses input; `EditorView.editable` is only what
 * decides whether the pane can be focused at all. Keeping the second one on is the
 * difference between a HEAD side you can search and copy out of and one that
 * silently swallows Ctrl+F — a keystroke never reaches a pane that cannot take
 * focus. Monaco's `originalEditable: false` behaved this way, so this is also what
 * keeps Part 4's behaviour intact.
 */
export function readOnlyFocusableExtensions(): Extension[] {
  return [EditorState.readOnly.of(true)];
}

const editableCompartment = new Compartment();

/**
 * A pane whose editability can change while it is open.
 *
 * The diff window's right pane is the one case: a file deleted in the working
 * tree has nothing to edit, and a save must not recreate it. Through a
 * compartment rather than a rebuild, for the same reason as the theme — the
 * window may have to flip this on a watcher refresh, mid-edit.
 */
export function editableExtension(editable: boolean): Extension {
  return editableCompartment.of(editableFacets(editable));
}

/** The transaction that moves a live view to `editable`. */
export function editableTransaction(editable: boolean): TransactionSpec {
  return { effects: editableCompartment.reconfigure(editableFacets(editable)) };
}

function editableFacets(editable: boolean): Extension {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

/**
 * Combinations `defaultKeymap` claims that the app has its own use for.
 *
 * `Alt-ArrowUp`/`Alt-ArrowDown` are `moveLineUp`/`moveLineDown` in CodeMirror, and
 * they are also the defaults for next/previous conflict and next/previous change.
 * Both cannot win, and the way it loses is genuinely bad: CodeMirror's keymap runs
 * on the pane's own handler and calls `preventDefault` when a command returns true,
 * while `useWindowKeybindings` listens on `window` in the bubble phase and skips a
 * handled event. So with a pane focused the keystroke silently **reorders lines in
 * the file** — and in the diff window that reaches disk 400 ms later through
 * auto-save — while appearing to be a navigation key that does nothing.
 *
 * Dropping them rather than out-prioritising them, because a pane for reviewing a
 * diff or resolving a conflict has no business moving lines around in the first
 * place; the app's own navigation is what these keys are for here.
 *
 * Only this pair goes. `Shift-Alt-ArrowUp`/`Shift-Alt-ArrowDown` (`copyLineUp`/
 * `copyLineDown`) survive deliberately: an Alt-modified arrow can still change the
 * file, just not on the two combinations the app has bound to navigation.
 */
const CLAIMED_BY_THE_APP = new Set(["Alt-ArrowUp", "Alt-ArrowDown"]);

/**
 * `defaultKeymap` minus [`CLAIMED_BY_THE_APP`].
 *
 * Every field a binding can name a chord in is checked, not just `key`: a
 * `KeyBinding` may carry `mac`, `win` and `linux` aliases that take precedence over
 * `key` on their platform, so matching on `key` alone would let a future
 * platform-specific spelling of the same command slip back in — on one OS only,
 * which is the worst way to find out.
 *
 * Composed by each pane rather than exported as a finished keymap: the diff's
 * editable side wants `indentWithTab` and the merge result pane deliberately does
 * not, and that difference predates this module.
 */
export const PANE_KEYMAP: readonly KeyBinding[] = defaultKeymap.filter(
  (binding) =>
    ![binding.key, binding.mac, binding.win, binding.linux].some(
      (chord) => chord !== undefined && CLAIMED_BY_THE_APP.has(chord),
    ),
);

/**
 * Find, for the diff panes only.
 *
 * `top: true` puts the panel above the editor: the panes are aligned line for
 * line, and a panel at the bottom of one of them would push its content out of
 * step with the other. Escape closes the panel, and because
 * `useWindowKeybindings` listens in the bubble phase and skips a handled event,
 * that Escape does not also close the window.
 */
export function searchExtensions(): Extension[] {
  return [search({ top: true }), keymap.of(searchKeymap)];
}
