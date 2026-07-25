// Entry point for the settings window (settings.html). Separate from main.tsx
// for the same reason as diff-main and merge-main: this document must never
// mount the workspace Layout, or opening Settings would spawn a second Claude
// Code PTY.

import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsWindow } from "./settings/SettingsWindow";
import "./settings/settings.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>,
);
