// Entry point for the merge window (merge.html). Separate from main.tsx for the
// same reason as diff-main.tsx: this document must never mount the workspace
// Layout, or opening a conflict would spawn a second Claude Code PTY.

import React from "react";
import ReactDOM from "react-dom/client";
import { MergeWindow } from "./merge/MergeWindow";
import { applyInitialTheme } from "./theme/initialTheme";
import "./merge/merge.css";

// Before the first render: every colour in the CSS is a custom property,
// and an unset one paints as unstyled. Secondary windows are told the
// theme in their URL; the main window starts on the default until its
// settings arrive.
applyInitialTheme(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MergeWindow />
  </React.StrictMode>,
);
