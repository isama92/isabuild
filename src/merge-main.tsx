// Entry point for the merge window (merge.html). Separate from main.tsx for the
// same reason as diff-main.tsx: this document must never mount the workspace
// Layout, or opening a conflict would spawn a second Claude Code PTY.

import React from "react";
import ReactDOM from "react-dom/client";
import { MergeWindow } from "./merge/MergeWindow";
import "./merge/merge.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MergeWindow />
  </React.StrictMode>,
);
