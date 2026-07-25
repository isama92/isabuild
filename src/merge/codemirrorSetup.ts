// One-time CodeMirror wiring for the merge window: theme, highlighting, and the
// extensions every one of the three panes shares.
//
// The counterpart of diff/monacoSetup, and composed by hand for the same reason:
// nothing here pulls in a feature the panes do not use. There is no `basicSetup`
// import — that bundle brings autocompletion, search, lint gutters and a fold
// gutter, none of which belong in a merge pane, and its line numbers would fight
// the chunk gutter.
//
// Colours are lifted from App.css and merge.css so all three windows read as one
// app: ours green, theirs blue, base dimmed — the same split Part 6 established.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { FONT_FAMILY_VAR, FONT_SIZE_VAR } from "../lib/appearance";

/** Ours green, theirs blue: the chunk tints, shared with merge.css. */
export const PANE_COLORS = {
  ours: "rgba(137, 209, 133, 0.10)",
  theirs: "rgba(108, 182, 255, 0.10)",
  conflict: "rgba(224, 143, 76, 0.13)",
  agreed: "rgba(255, 255, 255, 0.04)",
} as const;

/**
 * Dark highlight style.
 *
 * CodeMirror's `defaultHighlightStyle` is built for a light background — its
 * keywords are near-black blue — so on #1e1e1e it is unreadable. These are the
 * same hues the Monaco diff window uses, kept deliberately few: a merge pane wants
 * enough colour to read structure and no more.
 */
const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: "#c586c0" },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName], color: "#9cdcfe" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#dcdcaa" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "#4ec9b0" },
  { tag: [tags.number, tags.bool, tags.null], color: "#b5cea8" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ce9178" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6a9955", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation], color: "#d4d4d4" },
  { tag: tags.invalid, color: "#f14c4c" },
]);

const THEME = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "#1e1e1e",
      color: "#d4d4d4",
      // The font setting, via the custom properties `lib/appearance` writes on
      // the document root. Reading them here rather than reconfiguring the
      // theme means a font change repaints with no CodeMirror transaction at
      // all; MergePanes only has to ask the views to re-measure afterwards.
      fontSize: `var(${FONT_SIZE_VAR}, 12px)`,
    },
    ".cm-scroller": {
      fontFamily: `var(${FONT_FAMILY_VAR}, 'JetBrains Mono', ui-monospace, monospace)`,
      lineHeight: "1.5",
      // Never wrap: a wrapped line breaks the correspondence between what is on
      // screen and what is in the file, and it desynchronises the panes' scroll
      // heights on top of that.
      overflowX: "auto",
    },
    ".cm-content": { caretColor: "#d4d4d4" },
    ".cm-gutters": {
      backgroundColor: "#1e1e1e",
      color: "#6a6a6a",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#264f78",
    },
    // Chunk tints, applied as line decorations by MergePanes.
    ".cm-line.isabuild-chunk-ours": { backgroundColor: PANE_COLORS.ours },
    ".cm-line.isabuild-chunk-theirs": { backgroundColor: PANE_COLORS.theirs },
    ".cm-line.isabuild-chunk-conflict": { backgroundColor: PANE_COLORS.conflict },
    ".cm-line.isabuild-chunk-agreed": { backgroundColor: PANE_COLORS.agreed },
    // A marker line in the result buffer. It is real text the user can edit, so
    // it is styled to read as structure rather than as code.
    ".cm-line.isabuild-marker": {
      color: "#e08f4c",
      backgroundColor: "rgba(224, 143, 76, 0.20)",
      fontStyle: "italic",
    },
    // The chunk gutter: an arrow per actionable chunk.
    ".cm-gutterElement.isabuild-arrow": {
      cursor: "pointer",
      color: "#8a8a8a",
      textAlign: "center",
      width: "16px",
    },
    ".cm-gutterElement.isabuild-arrow:hover": { color: "#ffffff" },
  },
  { dark: true },
);

/** Extensions every pane shares. */
export function paneExtensions(): Extension[] {
  return [lineNumbers(), THEME, syntaxHighlighting(HIGHLIGHT, { fallback: true })];
}

/** The read-only panes: ours and theirs are git blobs and can never be written. */
export function readOnlyExtensions(): Extension[] {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}
