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
// light-theme user doesn't get a dark first frame. Resolves the tri-state
// preference (light | dark | system); a System user resolves from the OS
// appearance. Inlined (no import) so it runs before any module body. Kept in
// sync with appearance.ts / main.tsx.
try {
  const pref = localStorage.getItem("froglips-theme-pref");
  const mirror = localStorage.getItem("froglips-theme");
  let resolved: "light" | "dark" | null = null;
  if (pref === "light" || pref === "dark") resolved = pref;
  else if (pref === "system" || (!pref && mirror == null))
    resolved =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
  else if (mirror === "light" || mirror === "dark") resolved = mirror;
  if (resolved) document.documentElement.dataset.theme = resolved;
  const s = localStorage.getItem("froglips.uiScale");
  if (s && s !== "100" && /^(90|110|125|150)$/.test(s))
    document.documentElement.style.setProperty("--ui-scale", String(Number(s) / 100));
} catch {
  /* localStorage unavailable — keep the dark default */
}

import React from "react";
import ReactDOM from "react-dom/client";
import { QuickPrompt } from "./components/QuickPrompt";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { recordBootTiming } from "./lib/diagnostics";
// Styles: a LEAN sheet (tokens + the ~8 `.quick-*` rules) instead of the full
// App.css aggregator (~173 KB of render-blocking CSS). The popover renders only
// `.quick-*` classes (the boot skeleton in quick.html is self-contained inline
// CSS), so loading the whole app stylesheet just delayed first paint with rules
// this window never uses. quick.css @imports tokens.css for the design tokens
// the rules reference. (2026-06-16, B2-lean-css.)
import "./styles/quick.css";

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
