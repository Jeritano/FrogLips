import { useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import { streamChat } from "../lib/mlx-client";
import { runAgentLoop } from "../lib/agent-loop";
import type { AgentStatus } from "../lib/agent-loop";
import type { Conversation, Memory, Message, ServerStatus } from "../types";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import {
  getMemoryMode,
  recall,
  formatRecallBlock,
  extractFacts,
  saveMemory,
} from "../lib/memory-client";

interface Props {
  status: ServerStatus | null;
  conversation: Conversation | null;
  onConversationCreated: (c: Conversation) => void;
  onMemoriesChanged?: () => void;
}

interface ConfirmState {
  toolName: string;
  args: Record<string, unknown>;
}

function tmpKey(): string {
  return `tmp:${crypto.randomUUID()}`;
}

export function ChatWindow({ status, conversation, onConversationCreated, onMemoriesChanged }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const [recalled, setRecalled] = useState<Memory[]>([]);
  const [agentMode, setAgentMode] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const creatingConvRef = useRef<Promise<Conversation> | null>(null);
  const convRef = useRef<Conversation | null>(null);
  const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);

  useEffect(() => {
    convRef.current = conversation;
    if (conversation) {
      api.listMessages(conversation.id).then(setMessages).catch((e) => setErr(String(e)));
    } else {
      setMessages([]);
    }
    setRecalled([]);
  }, [conversation?.id]);

  async function ensureConversation(): Promise<Conversation> {
    if (convRef.current) return convRef.current;
    if (creatingConvRef.current) return creatingConvRef.current;
    const promise = (async () => {
      const title = "New chat";
      const id = await api.createConversation(title, status?.model ?? null);
      const c: Conversation = {
        id,
        title,
        model: status?.model ?? null,
        created_at: Math.floor(Date.now() / 1000),
      };
      convRef.current = c;
      onConversationCreated(c);
      return c;
    })();
    creatingConvRef.current = promise;
    try { return await promise; } finally { creatingConvRef.current = null; }
  }

  /* ── Confirmation gate for dangerous agent tools ── */

  function requestConfirmation(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmState({ toolName, args });
    });
  }

  function handleConfirm(approved: boolean) {
    setConfirmState(null);
    confirmResolveRef.current?.(approved);
    confirmResolveRef.current = null;
  }

  /* ── Send ── */

  async function send(text: string) {
    if (!status?.running || !status.model) {
      setErr("Start a model first");
      return;
    }
    setErr(null);

    let conv: Conversation;
    try {
      conv = await ensureConversation();
    } catch (e) {
      setErr(`Failed to create conversation: ${e}`);
      return;
    }
    const mode = getMemoryMode();

    const userMsg: Message = {
      _tmpKey: tmpKey(),
      conversation_id: conv.id,
      role: "user",
      content: text,
    };
    let userId: number;
    try {
      userId = await api.addMessage(conv.id, "user", text);
    } catch (e) {
      setErr(`Failed to save message: ${e}`);
      return;
    }
    userMsg.id = userId;
    const baseHistory = [...messages, userMsg];
    const streamConvId = conv.id;
    const isStreamConvActive = () => convRef.current?.id === streamConvId;
    if (isStreamConvActive()) setMessages(baseHistory);

    // Recall memories
    let recallBlock: string | null = null;
    let recallHits: Memory[] = [];
    if (mode !== "off") {
      try {
        recallHits = await recall(text, 5);
        recallBlock = formatRecallBlock(recallHits);
        if (isStreamConvActive()) setRecalled(recallHits);
        if (recallHits.length > 0) {
          api.touchMemories(recallHits.map((m) => m.id)).catch(() => {});
        }
      } catch {/* recall is best-effort */}
    } else {
      if (isStreamConvActive()) setRecalled([]);
    }

    const historyForApi: Message[] = recallBlock
      ? [{ conversation_id: conv.id, role: "system", content: recallBlock }, ...baseHistory]
      : baseHistory;

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    /* ── Agent mode ── */
    if (agentMode && status.backend === "ollama") {
      if (isStreamConvActive()) setAgentStatus("thinking");
      try {
        const finalText = await runAgentLoop({
          model: status.model,
          messages: historyForApi,
          conversationId: conv.id,
          onUpdate: (msgs) => {
            if (isStreamConvActive()) {
              // Strip ephemeral system recall message from display
              setMessages(msgs.filter((m) => m.role !== "system"));
            }
          },
          onStatusChange: (s) => {
            if (isStreamConvActive()) setAgentStatus(s);
          },
          requestConfirmation,
          signal: ctrl.signal,
        });

        if (finalText != null) {
          // Persist final assistant response to DB and assign id to message in state
          try {
            const id = await api.addMessage(conv.id, "assistant", finalText, status.model);
            if (isStreamConvActive()) {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && !last.id && last._tmpKey) {
                  return [...prev.slice(0, -1), { ...last, id }];
                }
                return prev;
              });
            }
          } catch (e) {
            if (isStreamConvActive()) setErr(`Failed to save response: ${e}`);
          }

          if (mode === "queue" || mode === "direct") {
            extractFacts(text, finalText, conv.id).then(async (facts) => {
              if (!facts.length) return;
              let added = 0;
              for (const f of facts) {
                try {
                  const r = await saveMemory({
                    content: f.fact,
                    conversationId: conv.id,
                    tags: mode === "queue" ? "auto,pending" : "auto",
                    status: mode === "queue" ? "pending" : "active",
                  });
                  if (!r.deduped) added++;
                } catch {/* ignore */}
              }
              if (added > 0) onMemoriesChanged?.();
            }).catch(() => {});
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted && isStreamConvActive()) {
          setErr(String(e));
        }
      } finally {
        abortRef.current = null;
        if (isStreamConvActive()) setAgentStatus("idle");
      }
      return;
    }

    /* ── Regular streaming mode ── */
    if (isStreamConvActive()) setStreaming("");
    let acc = "";
    let aborted = false;
    const ACC_MAX = 262_144;
    try {
      for await (const chunk of streamChat(status, historyForApi, { signal: ctrl.signal })) {
        if (chunk.done) break;
        acc += chunk.delta;
        if (acc.length > ACC_MAX) {
          ctrl.abort();
          break;
        }
        if (isStreamConvActive()) setStreaming(acc);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        aborted = true;
      } else if (isStreamConvActive()) {
        setErr(String(e));
      }
    } finally {
      abortRef.current = null;
      if (isStreamConvActive()) setStreaming(undefined);
    }

    const sameConv = isStreamConvActive;

    if (acc) {
      const asst: Message = {
        _tmpKey: tmpKey(),
        conversation_id: conv.id,
        role: "assistant",
        content: aborted ? acc + "\n\n[stopped]" : acc,
        model: status.model,
      };
      try {
        const id = await api.addMessage(conv.id, "assistant", asst.content, status.model);
        asst.id = id;
      } catch (e) {
        if (sameConv()) setErr(`Failed to save response: ${e}`);
      }
      if (sameConv()) setMessages((m) => [...m, asst]);

      if (mode === "queue" || mode === "direct") {
        extractFacts(text, acc, conv.id).then(async (facts) => {
          if (!facts.length) return;
          let added = 0;
          for (const f of facts) {
            try {
              const r = await saveMemory({
                content: f.fact,
                conversationId: conv.id,
                tags: mode === "queue" ? "auto,pending" : "auto",
                status: mode === "queue" ? "pending" : "active",
              });
              if (!r.deduped) added++;
            } catch {/* ignore individual failures */}
          }
          if (added > 0) onMemoriesChanged?.();
        }).catch(() => {});
      }
    } else if (aborted) {
      const tombstone: Message = {
        _tmpKey: tmpKey(),
        conversation_id: conv.id,
        role: "assistant",
        content: "[stopped before response]",
        model: status.model,
      };
      try {
        const id = await api.addMessage(conv.id, "assistant", tombstone.content, status.model);
        tombstone.id = id;
      } catch {/* best effort */}
      if (sameConv()) setMessages((m) => [...m, tombstone]);
    }
  }

  function abort() { abortRef.current?.abort(); }

  const isWorking = streaming !== undefined || agentStatus === "thinking" || agentStatus === "tool";
  const agentAvailable = status?.backend === "ollama";

  return (
    <div className="chat-window">
      <MessageList
        messages={messages}
        streaming={streaming}
        conversationId={conversation?.id ?? null}
        currentModel={status?.running ? status.model : null}
        agentStatus={agentStatus}
      />
      <div className="chat-input-wrap">
        {recalled.length > 0 && (
          <div className="recall-pill">
            <span className="recall-icon">⚡</span>
            Recalled {recalled.length} memor{recalled.length === 1 ? "y" : "ies"} for this turn
          </div>
        )}
        {err && <div className="error-bar">{err}</div>}

        {/* Agent mode toggle */}
        <div className="agent-toolbar">
          <button
            className={`agent-toggle ${agentMode ? "active" : ""}`}
            onClick={() => setAgentMode((v) => !v)}
            disabled={isWorking || !agentAvailable}
            title={agentAvailable ? "Toggle agent mode (tool calling)" : "Agent mode requires Ollama backend"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
            Agent
          </button>
          {agentMode && agentStatus !== "idle" && (
            <span className={`agent-status-pill status-${agentStatus}`}>
              {agentStatus === "thinking" && "Thinking…"}
              {agentStatus === "tool" && "Running tool…"}
            </span>
          )}
        </div>

        <ChatInput
          disabled={!status?.running}
          onSend={send}
          onAbort={abort}
          streaming={isWorking}
        />
      </div>

      {/* Tool confirmation modal */}
      {confirmState && (
        <div className="agent-confirm-overlay" onClick={(e) => e.target === e.currentTarget && handleConfirm(false)}>
          <div className="agent-confirm-box">
            <div className="agent-confirm-title">
              Allow <code>{confirmState.toolName}</code>?
            </div>
            <pre className="agent-confirm-args">
              {JSON.stringify(confirmState.args, null, 2)}
            </pre>
            <div className="agent-confirm-actions">
              <button className="agent-confirm-deny" onClick={() => handleConfirm(false)}>Deny</button>
              <button className="agent-confirm-allow" onClick={() => handleConfirm(true)}>Allow</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
