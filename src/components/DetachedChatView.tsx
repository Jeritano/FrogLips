import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import { configureMemory } from "../lib/memory-client";
import { useTauriEvent } from "../hooks/useTauriEvent";
import type { Conversation, ServerStatus } from "../types";
import { ModelPicker } from "./ModelPicker";
import { ChatWindow } from "./ChatWindow";
import { ErrorBar } from "./ErrorBar";

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
  // Audit H-F3: `refreshTick` state previously drove `key={refreshTick}`
  // on <ChatWindow>, remounting it on every conversation-updated event
  // and killing any in-flight stream. The remount strategy is gone; the
  // listener stays so we can re-fetch the Conversation header row (title
  // / model rename pickup) without nuking the message-list state. A
  // proper messages-refresh path (refresh-token prop on ChatWindow) is
  // deferred.
  useTauriEvent<number>(
    "conversation-updated",
    useCallback((e) => {
      const cid = e.payload;
      if (cid === conversationId || cid === -1) {
        // Re-fetch the bare conversation row so the header reflects
        // remote renames. Message list refresh deferred.
        void api.listConversations().then((rows) => {
          const fresh = rows.find((r) => r.id === conversationId);
          if (fresh) setConversation(fresh);
        }).catch(() => { /* best-effort */ });
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
        <ErrorBar message={loadError} onDismiss={() => setLoadError(null)} />
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
          Audit H-F3 (2026-05-27): previously `key={refreshTick}` triggered
          a full unmount/remount of ChatWindow on every `conversation-
          updated` event from another window — which also tore down any
          in-flight stream and AbortController on the detached window
          (a user mid-generation in this window would lose the response
          when the main window persisted an unrelated edit). Key now
          tied to `conversation.id` only: ChatWindow remounts when the
          user switches conversations, not when a sibling window pings.
          Pulling fresh state on remote updates without unmount is
          deferred — needs a refresh-token prop on ChatWindow/MessageList,
          which is a follow-up. Stale state in the detached window
          between switches is acceptable for v1 (rare-enough flow).
        */}
        <ChatWindow
          key={conversation.id}
          status={status}
          conversation={conversation}
          onConversationCreated={(c) => setConversation(c)}
        />
      </main>
    </div>
  );
}
