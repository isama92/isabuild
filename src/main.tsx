import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyInitialTheme } from "./theme/initialTheme";
import "@xterm/xterm/css/xterm.css";

// Before the first render: every colour in the CSS is a custom property,
// and an unset one paints as unstyled. Secondary windows are told the
// theme in their URL; the main window starts on the default until its
// settings arrive.
applyInitialTheme(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
