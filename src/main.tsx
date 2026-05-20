import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QuickPrompt } from "./components/QuickPrompt";
import { DetachedChatView } from "./components/DetachedChatView";
import { parseDetachedParams } from "./lib/detached-params";

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
    {isQuick
      ? <QuickPrompt />
      : detached
        ? <DetachedChatView conversationId={detached.conversationId} />
        : <App />}
  </React.StrictMode>,
);
