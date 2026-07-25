import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listFonts, type FontFamily } from "../lib/settings";
import { useSettingsStore } from "../store/settingsStore";
import { useAppearanceSync } from "../hooks/useAppearance";
import { THEMES } from "../theme/themes";
import { KeybindingsTab } from "./KeybindingsTab";

// The settings window (label `settings`, one instance).
//
// It edits the same `config.json` every other window reads, and every save is
// broadcast as `settings://changed`, so the workspace and any open diff or
// merge window repaint as the control is used rather than on close. There is
// no Save button and no Cancel for that reason: a change *is* the save.

/** Sample line for the font preview. */
const PREVIEW_CODE = "const ok = (x) => x !== 0; // 1lI0O {}[]()";
/**
 * Powerline separators, box drawing and a handful of Nerd Font glyphs. If these
 * render as tofu, the chosen family is not a Nerd Font and the prompt in the
 * terminal will look wrong in exactly the same way. Showing it here is the
 * whole point of the setting.
 */
const PREVIEW_GLYPHS = "      │├─┤";

/** Mirrors `MIN_FONT_SIZE` / `MAX_FONT_SIZE` in src-tauri/src/settings.rs. */
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 40;

export function SettingsWindow() {
  const settings = useSettingsStore((state) => state.settings);
  const error = useSettingsStore((state) => state.error);
  const save = useSettingsStore((state) => state.save);
  const [fonts, setFonts] = useState<FontFamily[] | null>(null);
  const [fontError, setFontError] = useState<string | null>(null);
  const [monoOnly, setMonoOnly] = useState(true);
  /**
   * What has been typed into the font size field, or null when it is not being
   * edited and should show the saved setting.
   *
   * A nullable draft rather than a seeded one, so there is no effect copying
   * the setting into state: a change another window made reaches the field the
   * moment the draft clears, and while the user is typing the draft wins.
   */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);

  // Reads the settings, follows other windows' changes, and applies the result
  // to this window too — so the preview below is rendered in the very font it
  // is previewing.
  useAppearanceSync();

  const commitSize = useCallback(() => {
    const current = settings?.fontSize;
    if (current === undefined || sizeDraft === null) return;
    const size = Number(sizeDraft);
    // An unusable draft (empty, half-typed, out of range) is simply dropped
    // rather than clamped: a silent jump to 6 is harder to understand than the
    // field snapping back to what it was.
    if (Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) {
      if (size !== current) void save({ fontSize: size });
    }
    setSizeDraft(null);
  }, [save, settings?.fontSize, sizeDraft]);

  // The scan parses every installed font, so it happens once per window rather
  // than per render of the select.
  useEffect(() => {
    let cancelled = false;
    void listFonts()
      .then((families) => {
        if (!cancelled) setFonts(families);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setFontError(`could not list the installed fonts: ${String(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const accel = event.ctrlKey || event.metaKey;
      if (event.key === "Escape" || (accel && event.key.toLowerCase() === "w")) {
        event.preventDefault();
        void getCurrentWindow().close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const visibleFonts = useMemo(() => {
    if (fonts === null) return [];
    const filtered = monoOnly ? fonts.filter((font) => font.monospaced) : fonts;
    // A family that is set but no longer installed would otherwise vanish from
    // the select, silently changing the setting to whatever sorts first.
    const chosen = settings?.fontFamily.trim() ?? "";
    if (chosen !== "" && !filtered.some((font) => font.name === chosen)) {
      return [{ name: chosen, monospaced: true }, ...filtered];
    }
    return filtered;
  }, [fonts, monoOnly, settings]);

  if (settings === null) {
    return <div className="settings-window settings-window--loading">Loading settings…</div>;
  }

  return (
    <div className="settings-window">
      <h1 className="settings-title">Settings</h1>

      {error !== null && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <section className="settings-section">
        <h2 className="settings-section-title">Appearance</h2>

        <div className="settings-field">
          <label className="settings-label" htmlFor="theme">
            Theme
          </label>
          <select
            id="theme"
            className="settings-select"
            value={settings.theme}
            onChange={(event) => void save({ theme: event.target.value })}
          >
            {THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>
          <p className="settings-hint">
            Applies to the workspace, the terminals and every diff and merge window, straight
            away.
          </p>
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="font-family">
            Font
          </label>
          <select
            id="font-family"
            className="settings-select"
            value={settings.fontFamily}
            disabled={fonts === null}
            onChange={(event) => void save({ fontFamily: event.target.value })}
          >
            <option value="">Default (JetBrains Mono, Fira Code, Menlo, Consolas)</option>
            {visibleFonts.map((font) => (
              <option key={font.name} value={font.name}>
                {font.name}
              </option>
            ))}
          </select>
          <p className="settings-hint">
            Used by both terminals and both editors. Choose a Nerd Font if your shell prompt
            draws icons.
          </p>
          {fontError !== null && (
            <p className="settings-error" role="alert">
              {fontError}
            </p>
          )}
        </div>

        <div className="settings-field settings-field--inline">
          <input
            id="mono-only"
            type="checkbox"
            checked={monoOnly}
            onChange={(event) => setMonoOnly(event.target.checked)}
          />
          <label htmlFor="mono-only">Show monospace fonts only</label>
        </div>

        <div className="settings-field">
          <label className="settings-label" htmlFor="font-size">
            Font size
          </label>
          <input
            id="font-size"
            className="settings-number"
            type="number"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            // The draft while editing, the setting otherwise. Saving straight
            // from onChange makes the field untypable: going from 14 to 20
            // passes through "2", which is out of range, and a controlled input
            // that rejects the change writes the old value straight back — so
            // the field would snap to 14 on every keystroke.
            value={sizeDraft ?? String(settings.fontSize)}
            onChange={(event) => setSizeDraft(event.target.value)}
            onBlur={commitSize}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitSize();
            }}
          />
        </div>

        <div className="settings-preview" aria-label="Font preview">
          <div className="settings-preview-line">{PREVIEW_CODE}</div>
          <div className="settings-preview-line">{PREVIEW_GLYPHS}</div>
        </div>
      </section>

      <KeybindingsTab settings={settings} save={(patch) => void save(patch)} />
    </div>
  );
}
