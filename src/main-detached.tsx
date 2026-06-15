// Dedicated entry for a detached single-conversation window (detached.html).
//
// Perf review (2026-06-14): split out of the shared index.html so this window
// boots from its own chunk graph instead of the full chat App shell (sidebar,
// settings panels, workflows, roundtable, etc.). It still pulls <ChatWindow>
// and the markdown renderer — a detached window renders real chat messages and
// must highlight/typeset them identically to the main window — but it no longer
// drags the rest of <App> that it never shows.
//
// The conversation id arrives in the query string (`?conversation_id=NN`); we
// parse it here exactly as the legacy main.tsx branch did.
try {
  const t = localStorage.getItem("froglips-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  /* localStorage unavailable — keep the dark default */
}

import React from "react";
import ReactDOM from "react-dom/client";
import { parseDetachedParams } from "./lib/detached-params";
import { DetachedChatView } from "./components/DetachedChatView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { recordBootTiming } from "./lib/diagnostics";
import "./App.css";

// The dedicated entry IS the detached window, so it implies `detached=1` even
// when the URL only carries `?conversation_id=NN`. Rather than re-implement the
// id parse here (which previously diverged from the shared parser on the
// detached flag), normalize the search to guarantee `detached=1` and delegate
// to parseDetachedParams as the single source of truth. This keeps the relaxed
// "bare conversation_id" acceptance while routing through the same validation
// the legacy main.tsx fallback uses, so the two entries can no longer disagree
// on what a valid detached URL is.
function resolveConversationId(): number | null {
  const params = new URLSearchParams(window.location.search);
  params.set("detached", "1");
  return parseDetachedParams(params.toString())?.conversationId ?? null;
}

const conversationId = resolveConversationId();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="DetachedChatView">
      {conversationId != null ? (
        <DetachedChatView conversationId={conversationId} />
      ) : (
        <div className="app detached" data-testid="detached-error">
          <div style={{ padding: 16, color: "var(--text-muted)" }}>
            Missing or invalid conversation id.
          </div>
        </div>
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);

// Per-window boot/TTI metric (cheap, local, no telemetry) so a regression on
// the detached conversation window is distinguishable from the main shell.
recordBootTiming("detached");
