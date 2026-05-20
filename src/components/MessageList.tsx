import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, ToolCall } from "../types";
import type { AgentStatus } from "../lib/agent-loop";
import { saveMemory } from "../lib/memory-client";

interface Props {
  messages: Message[];
  streaming?: string;
  conversationId?: number | null;
  currentModel?: string | null;
  agentStatus?: AgentStatus;
}

interface Row {
  msg: Message;
  key: string;
  divider: { label: string; tone: "start" | "change" } | null;
}

function keyFor(m: Message, idx: number): string {
  if (m._tmpKey) return m._tmpKey;
  if (m.id != null) return `id:${m.id}`;
  return `idx:${idx}`;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (raw != null && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function ToolCallBlock({ calls }: { calls: ToolCall[] }) {
  return (
    <div className="tool-calls-block">
      {calls.map((tc, i) => {
        const args = parseArgs(tc.function?.arguments);
        return (
          <div key={tc.id ?? i} className="tool-call-item">
            <span className="tool-call-name">{tc.function?.name ?? "unknown"}</span>
            <pre className="tool-call-args">{JSON.stringify(args, null, 2)}</pre>
          </div>
        );
      })}
    </div>
  );
}

function ToolResultBlock({ name, content }: { name?: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 400;
  const displayed = !isLong || expanded ? content : content.slice(0, 400) + "…";
  return (
    <div className="tool-result-block">
      {name && <span className="tool-result-name">{name} result</span>}
      <pre className="tool-result-content">{displayed}</pre>
      {isLong && (
        <button className="tool-result-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function MessageList({ messages, streaming, conversationId, currentModel, agentStatus }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [pinning, setPinning] = useState<string | null>(null);

  useEffect(() => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    const behavior: ScrollBehavior = streaming !== undefined || agentStatus === "thinking" || agentStatus === "tool" ? "auto" : "smooth";
    scrollRafRef.current = requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior });
    });
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [messages.length, streaming, agentStatus]);

  const { rows, lastAsstModel, finalPrevAsst } = useMemo(() => {
    let prev: string | null = null;
    const out: Row[] = messages.map((m, i) => {
      let divider: Row["divider"] = null;
      // Only show model dividers on regular assistant messages, not tool turns
      if (m.role === "assistant" && m.model && !m.tool_calls?.length) {
        if (prev === null) divider = { label: m.model, tone: "start" };
        else if (prev !== m.model) divider = { label: m.model, tone: "change" };
        prev = m.model;
      }
      return { msg: m, key: keyFor(m, i), divider };
    });
    let last: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) {
        last = messages[i].model!;
        break;
      }
    }
    return { rows: out, lastAsstModel: last, finalPrevAsst: prev };
  }, [messages]);

  async function pin(m: Message, key: string) {
    if (!m.content.trim()) return;
    setPinning(key);
    try {
      await saveMemory({
        content: m.content,
        conversationId: conversationId ?? null,
        sourceMsgId: m.id ?? null,
        tags: m.role,
      });
      setPinned((s) => new Set([...s, key]));
    } catch {/* ignore */}
    finally { setPinning(null); }
  }

  const showEndFooter =
    messages.length > 0 && streaming === undefined && agentStatus === "idle" && lastAsstModel;
  const modelMatches = currentModel && lastAsstModel && currentModel === lastAsstModel;

  return (
    <div className="message-list">
      {rows.map(({ msg: m, key: k, divider }) => {
        const isPinned = pinned.has(k);
        const isPinning = pinning === k;

        // Tool result message
        if (m.role === "tool") {
          return (
            <div key={k}>
              <ToolResultBlock name={m.tool_name} content={m.content} />
            </div>
          );
        }

        // Assistant turn with tool calls (no text content to show)
        if (m.role === "assistant" && m.tool_calls?.length) {
          return (
            <div key={k}>
              {m.content?.trim() && (
                <div className="message assistant">
                  <div className="content">{m.content}</div>
                </div>
              )}
              <ToolCallBlock calls={m.tool_calls} />
            </div>
          );
        }

        // Regular message
        return (
          <div key={k}>
            {divider && (
              <div className={`model-divider ${divider.tone}`}>
                <span className="model-divider-line" />
                <span className="model-divider-label">
                  {divider.tone === "start" ? "Started with" : "Switched to"}{" "}
                  <code>{divider.label}</code>
                </span>
                <span className="model-divider-line" />
              </div>
            )}
            <div className={`message ${m.role}`}>
              <div className="content">{m.content}</div>
              <button
                className={`pin-btn ${isPinned ? "pinned" : ""}`}
                onClick={() => pin(m, k)}
                disabled={isPinning || isPinned}
                title={isPinned ? "Saved to memory" : "Pin to memory"}
                aria-label="Pin to memory"
              >
                {isPinning ? (
                  <span className="mb-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                ) : isPinned ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><polygon points="12 2 15.09 8.63 22 9.24 16.54 13.97 18.18 21 12 17.27 5.82 21 7.46 13.97 2 9.24 8.91 8.63 12 2"/></svg>
                )}
              </button>
            </div>
          </div>
        );
      })}

      {streaming !== undefined && (
        <>
          {currentModel && finalPrevAsst !== currentModel && (
            <div className={`model-divider ${finalPrevAsst === null ? "start" : "change"}`}>
              <span className="model-divider-line" />
              <span className="model-divider-label">
                {finalPrevAsst === null ? "Started with" : "Switched to"} <code>{currentModel}</code>
              </span>
              <span className="model-divider-line" />
            </div>
          )}
          <div className="message assistant">
            <div className="content">{streaming}<span className="cursor">▍</span></div>
          </div>
        </>
      )}

      {agentStatus === "thinking" && (
        <div className="agent-thinking-row">
          <span className="mb-spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
          <span>Thinking…</span>
        </div>
      )}

      {showEndFooter && (
        <div className="model-end-footer">
          {modelMatches
            ? <>Still on <code>{lastAsstModel}</code></>
            : currentModel
              ? <>Last response from <code>{lastAsstModel}</code> · now on <code>{currentModel}</code></>
              : <>Last response from <code>{lastAsstModel}</code></>}
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
