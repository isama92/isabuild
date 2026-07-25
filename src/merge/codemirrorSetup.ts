// One-time CodeMirror wiring for the merge window: theme, highlighting, and the
// extensions every one of the three panes shares.
//
// The counterpart of diff/monacoSetup, and composed by hand for the same reason:
// nothing here pulls in a feature the panes do not use. There is no `basicSetup`
// import — that bundle brings autocompletion, search, lint gutters and a fold
// gutter, none of which belong in a merge pane, and its line numbers would fight
// the chunk gutter.
//
// Every colour comes from the theme registry (src/theme/themes), the same source
// the CSS and the Monaco diff read, so all four windows agree by construction
// rather than by three hand-copied palettes staying in step.
//
// The theme and the highlight style live in a Compartment each. A theme change
// is then one `reconfigure` transaction on a live view, rather than rebuilding
// the editor and losing the cursor, the scroll position and the undo history.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
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
 * larger than a merge pane needs. These are the same nine roles the Monaco
 * theme names, so a file looks identical in the diff window and here.
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
      // The chunk gutter: an arrow per actionable chunk.
      ".cm-gutterElement.isabuild-arrow": {
        cursor: "pointer",
        color: t.textDim,
        textAlign: "center",
        width: "16px",
      },
      ".cm-gutterElement.isabuild-arrow:hover": { color: t.textBright },
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

/** The read-only panes: ours and theirs are git blobs and can never be written. */
export function readOnlyExtensions(): Extension[] {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}
