// Perf review C8 (2026-06-09): apply the persisted theme SYNCHRONOUSLY,
// before the first render. The authoritative copy lives in settings.json
// behind an async IPC — light-theme users got a full dark first frame every
// launch while that round-trip resolved. App.tsx mirrors every theme change
// into localStorage; this read is best-effort (falls back to the dark
// default) and the settings value still wins once it arrives.
//
// Theme is now a tri-state PREFERENCE (light | dark | system). For a System
// user we resolve from the OS appearance here so the first frame already
// matches it; the resolved concrete value is also kept mirrored in
// `froglips-theme` by useAppearance. Inlined (no import) so it runs before any
// module body and adds zero round-trips. Kept in sync with appearance.ts.
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
} catch {
  /* localStorage unavailable — keep the dark default */
}

import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { parseDetachedParams } from "./lib/detached-params";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { recordBootTiming } from "./lib/diagnostics";

// Perf review (2026-06-13, medium): lazy-load the three window roots so each
// auxiliary webview boots from its own chunk instead of the full chat bundle.
// Static imports forced a single shared entry chunk (~878 KB incl.
// ChatWindow/markdown/katex) onto the lightweight QuickPrompt window. With
// React.lazy + Suspense the bundler can split App/DetachedChatView (which need
// ChatWindow) away from QuickPrompt, which imports none of that tree.
// QuickPrompt/DetachedChatView are named exports, so map them to `default`.
const App = lazy(() => import("./App"));
const QuickPrompt = lazy(() =>
  import("./components/QuickPrompt").then((m) => ({ default: m.QuickPrompt })),
);
const DetachedChatView = lazy(() =>
  import("./components/DetachedChatView").then((m) => ({
    default: m.DetachedChatView,
  })),
);

// index.html is the MAIN App entry. As of 2026-06-14 the auxiliary webviews
// have their own dedicated HTML entries (quick.html / main-quick.tsx and
// detached.html / main-detached.tsx) that the Rust side opens directly, so the
// lightweight Quick Prompt popover no longer boots from this (App-bearing)
// bundle. The query-string branch below is retained as a FALLBACK only: if any
// URL still loads index.html with `?quick=1` / `?detached=1`, it resolves the
// right view here. (The lazy QuickPrompt/DetachedChatView chunks referenced by
// this fallback stay split out, so keeping it costs the main entry nothing.)
//   * quick-prompt window  → `?quick=1` (or `/quick` path)
//   * detached conv window → `?detached=1&conversation_id=NN`
//   * everything else      → full `App`
const url = new URL(window.location.href);
const isQuick =
  url.pathname.replace(/\/+$/, "").endsWith("/quick") ||
  url.searchParams.get("quick") === "1";

const detached = parseDetachedParams(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="App">
      <Suspense fallback={null}>
        {isQuick ? (
          <QuickPrompt />
        ) : detached ? (
          <DetachedChatView conversationId={detached.conversationId} />
        ) : (
          <App />
        )}
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);

// Per-window boot/TTI metric (cheap, local, no telemetry) so a startup
// regression on the primary window is visible beyond the static byte budgets.
recordBootTiming("main");
