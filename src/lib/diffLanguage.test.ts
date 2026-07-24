import { describe, expect, it } from "vitest";
import { FALLBACK_LANGUAGE, languageForPath, type LanguageLike } from "./diffLanguage";

// A slice of Monaco's real registry, including the .php/.blade.php overlap.
const languages: LanguageLike[] = [
  { id: "typescript", extensions: [".ts", ".tsx"] },
  { id: "rust", extensions: [".rs"] },
  { id: "php", extensions: [".php"] },
  { id: "blade", extensions: [".blade.php"] },
  { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile"] },
  { id: "css", extensions: [".css"] },
];

describe("languageForPath", () => {
  it("matches on extension", () => {
    expect(languageForPath("src/lib/diffSource.ts", languages)).toBe("typescript");
    expect(languageForPath("src-tauri/src/diff.rs", languages)).toBe("rust");
  });

  it("prefers the longest matching extension", () => {
    expect(languageForPath("resources/views/mail.blade.php", languages)).toBe("blade");
    expect(languageForPath("app/Http/Kernel.php", languages)).toBe("php");
  });

  it("matches an exact filename ahead of any extension", () => {
    expect(languageForPath("docker/Dockerfile", languages)).toBe("dockerfile");
  });

  it("ignores case in both the path and the registry", () => {
    expect(languageForPath("App/Models/USER.PHP", languages)).toBe("php");
    expect(languageForPath("build/DOCKERFILE", languages)).toBe("dockerfile");
  });

  it("falls back to plaintext for unknown and extensionless files", () => {
    expect(languageForPath("LICENSE", languages)).toBe(FALLBACK_LANGUAGE);
    expect(languageForPath("notes.unknownext", languages)).toBe(FALLBACK_LANGUAGE);
    expect(languageForPath("src/lib/diffSource.ts", [])).toBe(FALLBACK_LANGUAGE);
  });

  it("does not treat a directory name as the filename", () => {
    // The ".ts" is in a directory, so this is not TypeScript.
    expect(languageForPath("weird.ts/readme", languages)).toBe(FALLBACK_LANGUAGE);
  });
});
