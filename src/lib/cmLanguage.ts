// Syntax highlighting for the editor panes, resolved against CodeMirror's own
// language table.
//
// The same shape as lib/diffLanguage, and for the same reason: the descriptor
// list is passed in, so this module never imports @codemirror/language-data and
// stays a pure unit test. What differs is what a match *is*. The registry holds one
// global registry keyed by language id, whereas CodeMirror ships a list of
// descriptors that each carry their own lazy `load()`; the caller resolves a
// descriptor here and awaits its module only if it found one.
//
// Matching rules are deliberately the same in both windows, so a conflicted
// file highlights the same way in the merge window as in the diff window:
// filename wins over extension, and a longer extension wins over a shorter one.

/** The part of `@codemirror/language`'s `LanguageDescription` we look at. */
export interface LanguageDescriptorLike {
  name: string;
  /** Without the leading dot, which is how language-data spells them. */
  extensions?: readonly string[];
  filename?: RegExp;
  alias?: readonly string[];
}

/**
 * Pick the descriptor for `path`, or null for "no highlighting" — which is a
 * perfectly good answer, and the one a plain `.txt` conflict should get.
 *
 * Exact filenames are matched first: language-data spells those as a `filename`
 * regex (`/^Dockerfile$/`), so `Dockerfile` is not mistaken for an extensionless
 * plain-text file.
 */
export function languageForPath<T extends LanguageDescriptorLike>(
  path: string,
  languages: readonly T[],
): T | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();

  for (const language of languages) {
    // Tested against the original-case name too: these regexes are usually
    // anchored and case-sensitive (`/^Dockerfile$/`).
    const original = path.split("/").pop() ?? path;
    if (language.filename?.test(original) || language.filename?.test(name)) {
      return language;
    }
  }

  let best: { language: T; length: number } | null = null;
  for (const language of languages) {
    for (const extension of language.extensions ?? []) {
      // language-data omits the dot; adding it stops `.ts` matching `components`.
      const suffix = `.${extension.toLowerCase()}`;
      if (name.endsWith(suffix) && (!best || suffix.length > best.length)) {
        best = { language, length: suffix.length };
      }
    }
  }

  return best?.language ?? null;
}
