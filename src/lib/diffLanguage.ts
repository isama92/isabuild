// Syntax highlighting language for a path, resolved against Monaco's own
// language registry rather than a hand-kept extension table — Monaco already
// ships the mapping, and it grows with the package.
//
// Pure by construction: the registry is passed in, so this module never loads
// Monaco (which does not run under jsdom) and stays unit-testable.

/** The part of `monaco.languages.ILanguageExtensionPoint` we look at. */
export interface LanguageLike {
  id: string;
  extensions?: readonly string[];
  filenames?: readonly string[];
}

export const FALLBACK_LANGUAGE = "plaintext";

/**
 * Match `path` against the registry: exact filename first (so `Dockerfile` and
 * `Makefile` win over any extension), then the longest matching extension, so
 * `.blade.php` beats `.php` where a language claims both.
 */
export function languageForPath(path: string, languages: readonly LanguageLike[]): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();

  for (const language of languages) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === name)) {
      return language.id;
    }
  }

  let best: { id: string; length: number } | null = null;
  for (const language of languages) {
    for (const extension of language.extensions ?? []) {
      const suffix = extension.toLowerCase();
      if (suffix && name.endsWith(suffix) && (!best || suffix.length > best.length)) {
        best = { id: language.id, length: suffix.length };
      }
    }
  }

  return best?.id ?? FALLBACK_LANGUAGE;
}
