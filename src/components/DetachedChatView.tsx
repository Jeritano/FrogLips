import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import { configureMemory } from "../lib/memory-client";
import { useTauriEvent } from "../hooks/useTauriEvent";
import type { Conversation, ServerStatus } from "../types";
import { ModelPicker } from "./ModelPicker";
import { ChatWindow } from "./ChatWindow";

/**
 * Single-conversation view for detached windows.
 *
 * Renders the same `ChatWindow` the main window uses, minus the sidebar and
 * side panels. Conversation state lives in SQLite — this window fetches its
 * conversation by id on mount and listens for `conversation-updated` events
 * so edits made in any window propagate via cheap re-fetches. Streaming
 * deltas remain window-local on purpose (see lib.rs).
 */
interface Props {
  conversationId: number;
}

export function DetachedChatView({ conversationId }: Props) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Initial fetch: pull the conversation row + memory client config + status.
  // Failure here is fatal for this window (we can't show a chat we can't load).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [convs, s, settings] = await Promise.all([
          api.listConversations(),
          api.serverStatus(),
          api.settingsGet(),
        ]);
        if (cancelled) return;
        const conv = convs.find((c) => c.id === conversationId) ?? null;
        if (!conv) {
          setLoadError(`Conversation ${conversationId} not found.`);
          return;
        }
        setConversation(conv);
        setStatus(s);
        configureMemory({
          embeddingModel: settings.embedding_model,
          recallThreshold: settings.recall_threshold,
        });
        if (settings.theme === "light" || settings.theme === "dark") {
          document.documentElement.dataset.theme = settings.theme;
        }
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  // Cross-window sync: any window that mutates this conversation fires
  // `conversation-updated`. We don't track messages locally — ChatWindow
  // refetches via list_messages on `conversation?.id` changes. To force a
  // refresh without leaving the same id, we bump a token that callers below
  // ignore (ChatWindow already re-fetches on mount + id change). The simpler
  // strategy: re-fetch the Conversation row (cheap, picks up renames) and let
  // ChatWindow refetch its messages on the next id transition. For full
  // message sync we expose a re-listing via a key bump.
  const [refreshTick, setRefreshTick] = useState(0);
  useTauriEvent<number>(
    "conversation-updated",
    useCallback((e) => {
      // Payload is the conversation id (or -1 = unknown / wildcard).
      const cid = e.payload;
      if (cid === conversationId || cid === -1) {
        setRefreshTick((t) => t + 1);
      }
    }, [conversationId]),
  );

  // Server-status follow: same flow as the main window.
  useTauriEvent<ServerStatus>(
    "server-status",
    useCallback((e) => setStatus(e.payload), []),
  );

  if (loadError) {
    return (
      <div className="app detached" data-testid="detached-error">
        <div className="error-bar" style={{ padding: 16 }}>{loadError}</div>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="app detached" data-testid="detached-loading">
        <div style={{ padding: 16, color: "var(--text-muted)" }}>Loading…</div>
      </div>
    );
  }

  return (
    <div className="app detached" data-testid="detached-ready" data-conv-id={conversation.id}>
      <main className="main detached-main">
        <header>
          <ModelPicker status={status} onStatusChange={setStatus} />
          <span
            className="detached-title"
            title={conversation.title}
            style={{
              marginLeft: 12,
              color: "var(--text-2)",
              fontSize: 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {conversation.title}
          </span>
        </header>
        {/*
          `key={refreshTick}` is the rebuild trigger — when another window
          persists a message, ChatWindow remounts and re-fetches the message
          list cleanly. We keep this scoped to the detached view to avoid
          re-mounting the main window's ChatWindow on every event.
        */}
        <ChatWindow
          key={refreshTick}
          status={status}
          conversation={conversation}
          onConversationCreated={(c) => setConversation(c)}
        />
      </main>
    </div>
  );
}
