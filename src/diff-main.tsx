// Entry point for the diff window (diff.html). Separate from main.tsx on
// purpose: this document must never mount the workspace Layout, or opening a
// diff would spawn a second Claude Code PTY.

import React from "react";
import ReactDOM from "react-dom/client";
import { DiffWindow } from "./diff/DiffWindow";
import "./diff/diff.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DiffWindow />
  </React.StrictMode>,
);
