// Entry point for the settings window (settings.html). Separate from main.tsx
// for the same reason as diff-main and merge-main: this document must never
// mount the workspace Layout, or opening Settings would spawn a second Claude
// Code PTY.

import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsWindow } from "./settings/SettingsWindow";
import { applyInitialTheme } from "./theme/initialTheme";
import "./settings/settings.css";

// Before the first render: every colour in the CSS is a custom property,
// and an unset one paints as unstyled. Secondary windows are told the
// theme in their URL; the main window starts on the default until its
// settings arrive.
applyInitialTheme(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>,
);
