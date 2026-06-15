// Dedicated entry for the menu-bar Quick Prompt popover (quick.html).
//
// Perf review (2026-06-14): the Quick Prompt window used to boot from the
// shared index.html and branch in main.tsx on `?quick=1`. Because the single
// entry chunk statically reaches the markdown renderer (marked + dompurify +
// highlight.js + katex ≈ 415 KB JS + 270 KB katex fonts), that whole payload
// was modulepreloaded onto this lightweight popover even though it renders the
// reply as plain <pre> text and imports none of the chat tree. Giving the
// window its own Vite entry that imports ONLY <QuickPrompt> drops the markdown
// graph entirely for this webview.
//
// Theme is applied synchronously before first paint, mirroring main.tsx, so a
// light-theme user doesn't get a dark first frame.
try {
  const t = localStorage.getItem("froglips-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  /* localStorage unavailable — keep the dark default */
}

import React from "react";
import ReactDOM from "react-dom/client";
import { QuickPrompt } from "./components/QuickPrompt";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { recordBootTiming } from "./lib/diagnostics";
// Styles: the same aggregator the main window uses. It is pure CSS (only
// @imports other stylesheets — no JS), so it carries no markdown payload; it
// just provides the design tokens + `.quick-*` rules this popover needs.
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="QuickPrompt">
      <QuickPrompt />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Per-window boot/TTI metric (cheap, local, no telemetry). The Quick Prompt
// popover boots from its own lean chunk; recording it separately makes a
// regression on this window distinguishable from the main shell's.
recordBootTiming("quick");
