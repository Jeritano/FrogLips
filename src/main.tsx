// Perf review C8 (2026-06-09): apply the persisted theme SYNCHRONOUSLY,
// before the first render. The authoritative copy lives in settings.json
// behind an async IPC — light-theme users got a full dark first frame every
// launch while that round-trip resolved. App.tsx mirrors every theme change
// into localStorage; this read is best-effort (falls back to the dark
// default) and the settings value still wins once it arrives.
try {
  const t = localStorage.getItem("froglips-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  /* localStorage unavailable — keep the dark default */
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QuickPrompt } from "./components/QuickPrompt";
import { DetachedChatView } from "./components/DetachedChatView";
import { parseDetachedParams } from "./lib/detached-params";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Single bundle, three entrypoints. The Rust side opens auxiliary webviews
// with query-string flags; we branch here so each window only loads the
// shell it actually needs.
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
      {isQuick ? (
        <QuickPrompt />
      ) : detached ? (
        <DetachedChatView conversationId={detached.conversationId} />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
