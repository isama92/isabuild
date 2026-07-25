// One-time Monaco wiring for the diff window: what to load, its worker, and
// its theme.
//
// Monaco is composed by hand rather than imported wholesale. The bare
// `monaco-editor` entry also registers the four worker-backed language services
// (TypeScript, JSON, CSS, HTML), which would ask for workers we do not ship and
// fail on hover; and a diff viewer wants none of their diagnostics anyway. So:
// the editor API, every editor feature (find, folding, bracket matching…) and
// the monarch tokenizers for every language — highlighting without a single
// language worker. That leaves exactly one worker to wire, the core editor one,
// which is what computes the diff.
//
// Paths carry no `esm/vs/` prefix: since 0.56 the package's `exports` map
// ("./*" -> "./esm/vs/*.js") adds it, and the older specifiers that the Monaco
// docs still show no longer resolve.

import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import "monaco-editor/basic-languages/monaco.contribution";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import { THEMES, type Theme } from "../theme/themes";

/** Monaco theme name for one of ours. Registered for every theme up front. */
export function monacoThemeName(theme: Theme): string {
  return `isabuild-${theme.id}`;
}

const TRANSPARENT = "#00000000";

let configured = false;

/**
 * Monaco's own syntax rules, from our tokens.
 *
 * Monaco's monarch tokenizers emit its own scope names, so the mapping is by
 * hand — but the *colours* come from the same tokens CodeMirror's
 * `HighlightStyle` reads, which is what keeps a file looking identical in the
 * diff window and the merge window.
 */
function syntaxRules(theme: Theme): monaco.editor.ITokenThemeRule[] {
  const t = theme.tokens;
  return [
    { token: "keyword", foreground: t.synKeyword },
    { token: "string", foreground: t.synString },
    { token: "comment", foreground: t.synComment, fontStyle: "italic" },
    { token: "number", foreground: t.synNumber },
    { token: "type", foreground: t.synType },
    { token: "identifier", foreground: t.synVariable },
    { token: "delimiter", foreground: t.synOperator },
    { token: "operator", foreground: t.synOperator },
    { token: "invalid", foreground: t.synInvalid },
    // Monaco wants rule colours without the leading `#`.
  ].map((rule) => ({ ...rule, foreground: rule.foreground.replace("#", "") }));
}

/** Idempotent: safe to call from every editor mount (StrictMode included). */
export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };

  // Every theme is defined once, and switching is `setTheme` on an existing
  // name: `defineTheme` on a name already in use while an editor holds it is
  // the path where Monaco keeps stale colours.
  for (const theme of THEMES) {
    monaco.editor.defineTheme(monacoThemeName(theme), {
      base: theme.dark ? "vs-dark" : "vs",
      inherit: true,
      rules: syntaxRules(theme),
      colors: {
        "editor.background": theme.tokens.bg,
        "editor.foreground": theme.tokens.textBright,
        "editorGutter.background": theme.tokens.bg,
        "editorLineNumber.foreground": theme.tokens.lineNumber,
        "editor.selectionBackground": theme.tokens.selection,
        "editor.lineHighlightBorder": TRANSPARENT,
        // Monaco's built-in diff ruler distinguishes only inserted from
        // removed. Blank it out so the scrollbar shows our three-colour
        // decorations (see lib/diffMarkers) instead of two overlapping sets of
        // marks.
        "diffEditorOverview.insertedForeground": TRANSPARENT,
        "diffEditorOverview.removedForeground": TRANSPARENT,
      },
    });
  }
}
