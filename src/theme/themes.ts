// The theme registry.
//
// One `Theme` per palette, and a select rendered from the list: adding a third
// is another object here and nothing else. Every colour in the app comes from
// one of these tokens — the CSS through custom properties written on the
// document root, and xterm, Monaco and CodeMirror through the same object,
// because none of the three can read CSS for its own drawing.
//
// The token names are *roles*, not colours. `--ib-danger` is what a destructive
// action looks like; that it happens to be red in both shipped themes is a
// property of the themes, not of the name. A name like `--ib-red` would have to
// lie the moment a theme disagreed.

/** Every colour the app can render. Keys become `--ib-<key>` custom properties. */
export interface ThemeTokens {
  // Surfaces, from the deepest background outward.
  bg: string;
  bgChrome: string;
  bgRaised: string;
  bgHover: string;
  bgButton: string;
  bgButtonHover: string;
  bgButtonActive: string;

  // Lines.
  border: string;
  borderStrong: string;
  borderStronger: string;

  // Text, from most to least prominent.
  textBright: string;
  text: string;
  textMuted: string;
  textDim: string;
  textDisabled: string;
  /**
   * Text on an **accent or danger** fill. Not "text on any non-`bg` surface":
   * a neutral fill like `bgButton` is pale in a light theme, and white on it
   * is invisible. Bright text on a neutral surface is `textBright`.
   */
  textOnFill: string;

  // Accent: the primary action, and the focus ring.
  accent: string;
  accentHover: string;
  accentAlt: string;
  focus: string;

  // Git and merge status.
  added: string;
  modified: string;
  deleted: string;
  conflict: string;
  /** Tint behind a conflict banner. */
  conflictBg: string;
  conflictBorder: string;

  // Failure and warning.
  danger: string;
  dangerHover: string;
  dangerBorder: string;
  /** Tint for a failure banner sitting on an already-opaque panel. */
  dangerBg: string;
  /**
   * Opaque fill for a failure surface that floats over other content. The
   * tint above would let the terminal show through the one message that has to
   * stay readable.
   */
  dangerSurface: string;
  warnBorder: string;
  warnBg: string;

  // Overlays and depth.
  /** Behind a modal, dimming the whole window. */
  backdrop: string;
  /** The terminal's exit overlay, and anything else veiling one region. */
  overlay: string;
  overlayStrong: string;
  /** Drop shadow under a raised surface: a modal, a popover menu. */
  shadow: string;

  // Editor internals. Separate from the surfaces above because the editors
  // paint them themselves and their contrast requirements differ.
  selection: string;
  lineNumber: string;
  /** Tints marking which side a merge chunk came from. */
  chunkOurs: string;
  chunkTheirs: string;
  chunkAgreed: string;
  chunkConflict: string;
  /** Scrollbar overview marks in the diff window. */
  markAdded: string;
  markModified: string;
  markDeleted: string;

  // Syntax highlighting, shared by Monaco and CodeMirror so a file looks the
  // same in the diff window and the merge window.
  synKeyword: string;
  synString: string;
  synComment: string;
  synNumber: string;
  synFunction: string;
  synType: string;
  synVariable: string;
  synOperator: string;
  synInvalid: string;

  // The 16 ANSI colours, for xterm. Without these a light theme leaves the
  // shell drawing its dark-terminal palette on a white background.
  ansiBlack: string;
  ansiRed: string;
  ansiGreen: string;
  ansiYellow: string;
  ansiBlue: string;
  ansiMagenta: string;
  ansiCyan: string;
  ansiWhite: string;
  ansiBrightBlack: string;
  ansiBrightRed: string;
  ansiBrightGreen: string;
  ansiBrightYellow: string;
  ansiBrightBlue: string;
  ansiBrightMagenta: string;
  ansiBrightCyan: string;
  ansiBrightWhite: string;
}

export interface Theme {
  /** Stored in `config.json`; must stay stable across releases. */
  id: string;
  /** Shown in the settings select. */
  label: string;
  /**
   * Whether this is a dark theme. Editors need it as a flag, not as a colour:
   * CodeMirror's `EditorView.theme` takes `{ dark }`, and Monaco's theme `base`
   * picks the defaults for everything we do not name.
   */
  dark: boolean;
  tokens: ThemeTokens;
}

const VSCODE_DARK: Theme = {
  id: "vscode-dark",
  label: "Dark (Visual Studio Code Dark+)",
  dark: true,
  tokens: {
    bg: "#1e1e1e",
    bgChrome: "#252526",
    bgRaised: "#2d2d2d",
    bgHover: "#2a2d2e",
    bgButton: "#3a3a3a",
    bgButtonHover: "#3d3d3d",
    bgButtonActive: "#484848",

    border: "#333333",
    borderStrong: "#3c3c3c",
    borderStronger: "#454545",

    textBright: "#e8e8e8",
    text: "#cccccc",
    textMuted: "#b9b9b9",
    textDim: "#8a8a8a",
    textDisabled: "#6b6b6b",
    textOnFill: "#ffffff",

    accent: "#2f6feb",
    accentHover: "#3b7ff5",
    accentAlt: "#0e639c",
    focus: "#6cb6ff",

    added: "#89d185",
    modified: "#e2c08d",
    deleted: "#f14c4c",
    conflict: "#e08f4c",
    conflictBg: "#2b2318",
    conflictBorder: "#6b4a1f",

    danger: "#a92828",
    dangerHover: "#cc3333",
    dangerBorder: "#a1260d",
    dangerBg: "rgba(161, 38, 13, 0.18)",
    dangerSurface: "#3a1d15",
    warnBorder: "#6b5a2a",
    warnBg: "rgba(226, 192, 141, 0.12)",

    backdrop: "rgba(0, 0, 0, 0.5)",
    overlay: "rgba(20, 20, 20, 0.6)",
    overlayStrong: "rgba(20, 20, 20, 0.88)",
    shadow: "rgba(0, 0, 0, 0.45)",

    selection: "#264f78",
    lineNumber: "#6a6a6a",
    chunkOurs: "rgba(137, 209, 133, 0.10)",
    chunkTheirs: "rgba(108, 182, 255, 0.10)",
    chunkAgreed: "rgba(137, 137, 137, 0.08)",
    chunkConflict: "rgba(224, 143, 76, 0.12)",
    markAdded: "#89d185",
    markModified: "#6cb6ff",
    markDeleted: "#f14c4c",

    synKeyword: "#569cd6",
    synString: "#ce9178",
    synComment: "#6a9955",
    synNumber: "#b5cea8",
    synFunction: "#dcdcaa",
    synType: "#4ec9b0",
    synVariable: "#9cdcfe",
    synOperator: "#d4d4d4",
    synInvalid: "#f14c4c",

    ansiBlack: "#000000",
    ansiRed: "#cd3131",
    ansiGreen: "#0dbc79",
    ansiYellow: "#e5e510",
    ansiBlue: "#2472c8",
    ansiMagenta: "#bc3fbc",
    ansiCyan: "#11a8cd",
    ansiWhite: "#e5e5e5",
    ansiBrightBlack: "#666666",
    ansiBrightRed: "#f14c4c",
    ansiBrightGreen: "#23d18b",
    ansiBrightYellow: "#f5f543",
    ansiBrightBlue: "#3b8eea",
    ansiBrightMagenta: "#d670d6",
    ansiBrightCyan: "#29b8db",
    ansiBrightWhite: "#e5e5e5",
  },
};

const VSCODE_LIGHT: Theme = {
  id: "vscode-light",
  label: "Light (Visual Studio Code Light+)",
  dark: false,
  tokens: {
    bg: "#ffffff",
    bgChrome: "#f3f3f3",
    bgRaised: "#f8f8f8",
    bgHover: "#e8e8e8",
    // Wider steps than a naive lightening of the dark theme's: on white, a
    // two-percent luminance change between a button and its hover is not
    // perceptible, and several controls in the app have no other hover cue.
    bgButton: "#e4e4e4",
    bgButtonHover: "#d3d3d3",
    bgButtonActive: "#bfbfbf",

    border: "#e0e0e0",
    borderStrong: "#cecece",
    borderStronger: "#c8c8c8",

    textBright: "#000000",
    text: "#3b3b3b",
    textMuted: "#4d4d4d",
    textDim: "#6b6b6b",
    textDisabled: "#a0a0a0",
    textOnFill: "#ffffff",

    accent: "#005fb8",
    accentHover: "#0070d8",
    accentAlt: "#0060c0",
    // Darker than the dark theme's focus ring: a pale blue outline on white is
    // invisible, and a focus ring nobody can see fails the keyboard user this
    // whole mechanism exists for.
    focus: "#0066cc",

    added: "#487e02",
    modified: "#895503",
    deleted: "#ad0707",
    conflict: "#b5620a",
    conflictBg: "#fdf3e4",
    conflictBorder: "#e5c08a",

    danger: "#c72e0f",
    dangerHover: "#e13a19",
    dangerBorder: "#c72e0f",
    dangerBg: "rgba(199, 46, 15, 0.10)",
    dangerSurface: "#fdeceb",
    warnBorder: "#d9b45f",
    warnBg: "rgba(191, 143, 0, 0.10)",

    backdrop: "rgba(0, 0, 0, 0.30)",
    overlay: "rgba(250, 250, 250, 0.72)",
    overlayStrong: "rgba(250, 250, 250, 0.94)",
    shadow: "rgba(0, 0, 0, 0.18)",

    selection: "#add6ff",
    lineNumber: "#767676",
    chunkOurs: "rgba(72, 126, 2, 0.10)",
    chunkTheirs: "rgba(0, 95, 184, 0.10)",
    chunkAgreed: "rgba(120, 120, 120, 0.08)",
    chunkConflict: "rgba(181, 98, 10, 0.12)",
    markAdded: "#487e02",
    markModified: "#005fb8",
    markDeleted: "#ad0707",

    synKeyword: "#0000ff",
    synString: "#a31515",
    synComment: "#008000",
    synNumber: "#098658",
    synFunction: "#795e26",
    synType: "#267f99",
    synVariable: "#001080",
    synOperator: "#000000",
    synInvalid: "#cd3131",

    ansiBlack: "#000000",
    ansiRed: "#cd3131",
    ansiGreen: "#00bc00",
    ansiYellow: "#949800",
    ansiBlue: "#0451a5",
    ansiMagenta: "#bc05bc",
    ansiCyan: "#0598bc",
    ansiWhite: "#555555",
    ansiBrightBlack: "#666666",
    ansiBrightRed: "#cd3131",
    ansiBrightGreen: "#14ce14",
    ansiBrightYellow: "#b5ba00",
    ansiBrightBlue: "#0451a5",
    ansiBrightMagenta: "#bc05bc",
    ansiBrightCyan: "#0598bc",
    ansiBrightWhite: "#a5a5a5",
  },
};

/** Every theme the settings select offers, in the order it offers them. */
export const THEMES: readonly Theme[] = [VSCODE_DARK, VSCODE_LIGHT];

/** The theme a fresh install starts on. Matches `DEFAULT_THEME` in settings.rs. */
export const DEFAULT_THEME = VSCODE_DARK;

/**
 * The theme with this id, falling back to the default.
 *
 * A stored id can name a theme that no longer exists (a hand-edited config, a
 * downgrade). Falling back beats refusing to paint.
 */
export function themeById(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME;
}
