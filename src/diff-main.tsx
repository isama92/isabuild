// Entry point for the diff window (diff.html). Separate from main.tsx on
// purpose: this document must never mount the workspace Layout, or opening a
// diff would spawn a second Claude Code PTY.

import React from "react";
import ReactDOM from "react-dom/client";
import { DiffWindow } from "./diff/DiffWindow";
import { applyInitialTheme } from "./theme/initialTheme";
import "./diff/diff.css";

// Before the first render: every colour in the CSS is a custom property,
// and an unset one paints as unstyled. Secondary windows are told the
// theme in their URL; the main window starts on the default until its
// settings arrive.
applyInitialTheme(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DiffWindow />
  </React.StrictMode>,
);
