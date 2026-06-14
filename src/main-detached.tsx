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
import "./App.css";

// The dedicated entry implies `detached=1`; only the conversation_id is read
// from the query string. Fall back to parsing the full search (which also
// requires `detached=1`) so an old-style `?detached=1&conversation_id=NN` URL
// still resolves if it ever reaches this entry.
function resolveConversationId(): number | null {
  const direct = new URLSearchParams(window.location.search).get(
    "conversation_id",
  );
  if (direct != null && /^-?\d+$/.test(direct)) {
    const n = Number(direct);
    if (Number.isSafeInteger(n)) return n;
  }
  return parseDetachedParams(window.location.search)?.conversationId ?? null;
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
