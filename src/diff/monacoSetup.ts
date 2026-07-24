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

export const DIFF_THEME = "isabuild-diff-dark";

const TRANSPARENT = "#00000000";

let configured = false;

/** Idempotent: safe to call from every editor mount (StrictMode included). */
export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };

  monaco.editor.defineTheme(DIFF_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1e1e1e",
      "editorGutter.background": "#1e1e1e",
      "editor.lineHighlightBorder": "#00000000",
      // Monaco's built-in diff ruler distinguishes only inserted from removed.
      // Blank it out so the scrollbar shows our three-colour decorations
      // (see lib/diffMarkers) instead of two overlapping sets of marks.
      "diffEditorOverview.insertedForeground": TRANSPARENT,
      "diffEditorOverview.removedForeground": TRANSPARENT,
    },
  });
}
