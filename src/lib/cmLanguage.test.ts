import { describe, expect, it } from "vitest";
import { languageForPath, type LanguageDescriptorLike } from "./cmLanguage";

// A slice of @codemirror/language-data's real shape: extensions without the
// leading dot, exact filenames as anchored regexes.
const LANGUAGES: LanguageDescriptorLike[] = [
  { name: "TypeScript", extensions: ["ts", "mts"] },
  { name: "TSX", extensions: ["tsx"] },
  { name: "Rust", extensions: ["rs"] },
  { name: "PHP", extensions: ["php"] },
  { name: "HTML", extensions: ["html", "blade.php"] },
  { name: "Dockerfile", filename: /^Dockerfile$/ },
  { name: "CMake", extensions: ["cmake"], filename: /^CMakeLists\.txt$/ },
];

describe("languageForPath", () => {
  it("matches on extension", () => {
    expect(languageForPath("src/lib/gitMerge.ts", LANGUAGES)?.name).toBe("TypeScript");
    expect(languageForPath("src-tauri/src/merge.rs", LANGUAGES)?.name).toBe("Rust");
  });

  it("prefers the longer extension when two languages claim a suffix", () => {
    // The rule diffLanguage already applies, so the same file highlights the same
    // way in both windows.
    expect(languageForPath("resources/views/home.blade.php", LANGUAGES)?.name).toBe("HTML");
    expect(languageForPath("public/index.php", LANGUAGES)?.name).toBe("PHP");
  });

  it("matches an exact filename before any extension", () => {
    expect(languageForPath("build/Dockerfile", LANGUAGES)?.name).toBe("Dockerfile");
    expect(languageForPath("CMakeLists.txt", LANGUAGES)?.name).toBe("CMake");
  });

  it("does not treat part of a name as an extension", () => {
    // Without the dot, "components" ends with "ts".
    expect(languageForPath("src/components", LANGUAGES)).toBeNull();
  });

  it("is case-insensitive on extensions", () => {
    expect(languageForPath("SRC/MAIN.RS", LANGUAGES)?.name).toBe("Rust");
  });

  it("returns null for a file with no language, which is a fine answer", () => {
    expect(languageForPath("notes.txt", LANGUAGES)).toBeNull();
    expect(languageForPath("LICENSE", LANGUAGES)).toBeNull();
  });

  it("handles a bare filename with no directory", () => {
    expect(languageForPath("main.rs", LANGUAGES)?.name).toBe("Rust");
  });
});
