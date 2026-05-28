import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, MemoryScope, ToolCall } from "../types";
import type { AgentStatus } from "../lib/agent-loop";
import { saveMemory } from "../lib/memory-client";
import { logDiag } from "../lib/diagnostics";
import { renderMarkdown } from "../lib/markdown";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
import "highlight.js/styles/github-dark.css";

interface Props {
  messages: Message[];
  streaming?: string;
  conversationId?: number | null;
  /** Current workspace root (used when pinning at project scope). */
  workspaceRoot?: string | null;
  currentModel?: string | null;
  agentStatus?: AgentStatus;
  onRegenerate?: () => void;
  onEditUser?: (msg: Message) => void;
  /**
   * Invoked when the user confirms a fork from a specific message. The host
   * is expected to call `api.conversationFork`, refresh the conversation
   * list, and switch the active selection to the new fork.
   */
  onFork?: (msg: Message) => void;
}

interface Row {
  msg: Message;
  key: string;
  divider: { label: string; tone: "start" | "change" } | null;
}

// Conservative windowing cap. Message rows have wildly variable height
// (a one-liner vs. a long code block), which makes fixed-height
// virtualization unsound and measure-and-cache windowing risky to combine
// with live streaming + stick-to-bottom autoscroll. Instead of risking a
// scroll/streaming regression, we cap the initially-rendered rows to the
// most recent WINDOW_SIZE and gate the rest behind an explicit
// "Show earlier messages" control. The newest messages — the ones that
// stream and that autoscroll targets — are always fully rendered.
const WINDOW_SIZE = 150;

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

// Per-message markdown cache so streaming chunks don't re-parse + re-sanitize
// every prior message on every render. Keyed by content string — JS strings
// are immutable so content unchanged ⇒ cached HTML reused. FIFO eviction
// keeps the cache bounded across long sessions.
const MARKDOWN_CACHE_MAX = 500;
const markdownCache = new Map<string, string>();
function cachedMarkdown(text: string): string {
  const hit = markdownCache.get(text);
  if (hit !== undefined) return hit;
  const rendered = renderMarkdown(text);
  if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
    const firstKey = markdownCache.keys().next().value;
    if (firstKey !== undefined) markdownCache.delete(firstKey);
  }
  markdownCache.set(text, rendered);
  return rendered;
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
    <div className="tool-result-block" data-testid="tool-result">
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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const ToolCallBlockMemo = memo(ToolCallBlock);
const ToolResultBlockMemo = memo(ToolResultBlock);

function MessageActions({
  msg, isLast, isLastUser, onRegenerate, onEditUser,
}: {
  msg: Message; isLast: boolean; isLastUser: boolean;
  onRegenerate?: () => void;
  onEditUser?: (m: Message) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (msg.role !== "assistant" && msg.role !== "user") return null;
  return (
    <div className="msg-actions">
      <button
        className="msg-action"
        title="Copy message text"
        onClick={async () => {
          const ok = await copyText(msg.content);
          if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1200); }
        }}
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
      {msg.role === "assistant" && isLast && onRegenerate && (
        <button className="msg-action" title="Regenerate response" onClick={onRegenerate}>
          ↻ Regenerate
        </button>
      )}
      {msg.role === "user" && isLastUser && onEditUser && (
        <button className="msg-action" title="Edit and retry" onClick={() => onEditUser(msg)}>
          Edit
        </button>
      )}
    </div>
  );
}

interface RowProps {
  msg: Message;
  divider: Row["divider"];
  isLast: boolean;
  /** True iff this is the most recent user-role message in the list. */
  isLastUser: boolean;
  isPinned: boolean;
  isPinning: boolean;
  onPin: (m: Message, key: string, scope: MemoryScope) => void;
  rowKey: string;
  /** Whether the project scope option is selectable in the pin dropdown. */
  canPinProject: boolean;
  /** Whether the conversation scope option is selectable in the pin dropdown. */
  canPinConversation: boolean;
  onRegenerate?: () => void;
  onEditUser?: (m: Message) => void;
  /** Whether fork-from-here is currently offered (needs persisted msg + conv). */
  canFork: boolean;
  onFork?: (m: Message) => void;
}

function MessageRowImpl({ msg, divider, isLast, isLastUser, isPinned, isPinning, onPin, rowKey, canPinProject, canPinConversation, onRegenerate, onEditUser, canFork, onFork }: RowProps) {
  if (msg.role === "tool") {
    return <ToolResultBlockMemo name={msg.tool_name} content={msg.content} />;
  }

  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const html = msg.content?.trim() ? cachedMarkdown(msg.content) : "";
    return (
      <>
        {html && (
          <div className="message assistant">
            <div className="content markdown" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )}
        <ToolCallBlockMemo calls={msg.tool_calls} />
      </>
    );
  }

  // User input is plain text — typed by a human, no markdown intent. Skipping
  // the marked + DOMPurify pipeline keeps the bubble height tight (no <p>
  // margin quirks) and avoids spending parser time on content that won't
  // benefit from rendering.
  const isUser = msg.role === "user";
  return (
    <>
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
      <div className={`message ${msg.role}`} data-testid={`message-${msg.role}`}>
        {isUser ? (
          <div className="content">{msg.content}</div>
        ) : (
          <div className="content markdown" dangerouslySetInnerHTML={{ __html: cachedMarkdown(msg.content) }} />
        )}
        <MessageActions msg={msg} isLast={isLast} isLastUser={isLastUser} onRegenerate={onRegenerate} onEditUser={onEditUser} />
        <PinControl
          msg={msg}
          rowKey={rowKey}
          isPinned={isPinned}
          isPinning={isPinning}
          onPin={onPin}
          canPinProject={canPinProject}
          canPinConversation={canPinConversation}
        />
        {isUser && canFork && onFork && (
          <ForkButton msg={msg} onFork={onFork} />
        )}
      </div>
    </>
  );
}

/**
 * Per-message "Fork from here" button. Renders only on user-role messages
 * (per spec). Uses the shared two-click inline confirm so accidental clicks
 * don't spawn stray forks — Tauri 2's webview disables `window.confirm()`,
 * which would otherwise silently no-op.
 */
function ForkButton({ msg, onFork }: { msg: Message; onFork: (m: Message) => void }) {
  const confirmer = useTwoClickConfirm();
  const id = String(msg.id);
  const armed = confirmer.armed === id;
  const handle = useCallback(() => {
    confirmer.request(id, () => onFork(msg));
  }, [confirmer, id, msg, onFork]);
  return (
    <button
      type="button"
      data-testid="fork-btn"
      className="fork-btn"
      onClick={handle}
      title={
        armed
          ? "Click again to confirm forking from this message"
          : "Fork from here — start a new conversation seeded with messages up to this point"
      }
      aria-label={armed ? "Click again to confirm fork" : "Fork from here"}
    >
      {armed ? "Click again to confirm" : "🌿 Fork from here"}
    </button>
  );
}

interface PinControlProps {
  msg: Message;
  rowKey: string;
  isPinned: boolean;
  isPinning: boolean;
  onPin: (m: Message, key: string, scope: MemoryScope) => void;
  canPinProject: boolean;
  canPinConversation: boolean;
}

/**
 * Pin button + scope selector. Default scope is `conversation` (per spec —
 * avoids polluting global memory with one-off pins). Falls back to the
 * highest-available scope if conversation isn't pinnable yet (rare —
 * happens before the first message is persisted).
 */
function PinControl({ msg, rowKey, isPinned, isPinning, onPin, canPinProject, canPinConversation }: PinControlProps) {
  const defaultScope: MemoryScope = canPinConversation
    ? "conversation"
    : canPinProject
      ? "project"
      : "global";
  const [scope, setScope] = useState<MemoryScope>(defaultScope);
  // Keep the dropdown in sync if the available scopes change (e.g. workspace
  // gets set later) and the user hasn't moved off the default yet.
  useEffect(() => {
    if (scope === "conversation" && !canPinConversation) setScope(defaultScope);
    if (scope === "project" && !canPinProject) setScope(defaultScope);
  }, [canPinConversation, canPinProject, defaultScope, scope]);

  return (
    <span className="pin-control">
      <select
        data-testid="pin-scope"
        className="pin-scope"
        value={scope}
        onChange={(e) => setScope(e.target.value as MemoryScope)}
        disabled={isPinning || isPinned}
        title="Pin scope"
      >
        <option value="global">G</option>
        <option value="project" disabled={!canPinProject}>P</option>
        <option value="conversation" disabled={!canPinConversation}>C</option>
      </select>
      <button
        data-testid="pin-btn"
        className={`pin-btn ${isPinned ? "pinned" : ""}`}
        onClick={() => onPin(msg, rowKey, scope)}
        disabled={isPinning || isPinned}
        title={isPinned ? "Saved to memory" : `Pin to ${scope} memory`}
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
    </span>
  );
}

// memo on shallow-equal props — handlers are stabilized via useCallback in
// the parent. Without this, a single streaming chunk re-renders every prior
// message (cached markdown helps but DOM diff still runs).
const MessageRow = memo(MessageRowImpl);

const StreamingMessage = memo(function StreamingMessage({ text }: { text: string }) {
  // Maturity dim 10 (a11y): announce streaming text to assistive
  // tech. `aria-live="polite"` instructs the screen reader to
  // queue updates rather than interrupting other speech;
  // `aria-atomic="false"` so only the delta is re-read, not the
  // entire growing bubble. Screen readers throttle naturally so
  // 100+ tok/s emit doesn't cause a torrent.
  return (
    <div className="message assistant" data-testid="streaming-bubble" aria-live="polite" aria-atomic="false">
      <div className="content markdown" dangerouslySetInnerHTML={{ __html: cachedMarkdown(text) + '<span class="cursor">▍</span>' }} />
    </div>
  );
});

// ────────────────────────────────────────────────────────────────────────────
// MessageHistory — memoized subtree that owns the row-list rendering.
//
// Pulled out of MessageList so streaming-driven re-renders of the wrapper
// don't walk + diff every persisted row each frame. When the parent
// MessageList re-renders for a streaming-text update, MessageHistory's memo
// bails out on shallow-equal props (handlers are stabilized via useEvent in
// ChatWindow; `messages` only updates when a real persisted message lands).
// Result: history-row reconciliation cost is paid once per persisted change,
// not 60×/sec during streaming. Pin state lives here too because it's a
// row-list concern that the streaming bubble never touches.
// ────────────────────────────────────────────────────────────────────────────
interface MessageHistoryProps {
  messages: Message[];
  conversationId?: number | null;
  workspaceRoot?: string | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onRegenerate?: () => void;
  onEditUser?: (m: Message) => void;
  onFork?: (m: Message) => void;
}

const MessageHistory = memo(function MessageHistory({
  messages,
  conversationId,
  workspaceRoot,
  scrollContainerRef,
  onRegenerate,
  onEditUser,
  onFork,
}: MessageHistoryProps) {
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [pinning, setPinning] = useState<string | null>(null);
  // How many leading (oldest) rows are collapsed behind "Show earlier
  // messages". Reset to the cap whenever the conversation changes.
  const [hiddenCount, setHiddenCount] = useState(0);

  useEffect(() => {
    setHiddenCount(0);
  }, [conversationId]);

  const rows = useMemo<Row[]>(() => {
    let prev: string | null = null;
    return messages.map((m, i) => {
      let divider: Row["divider"] = null;
      if (m.role === "assistant" && m.model && !m.tool_calls?.length) {
        if (prev === null) divider = { label: m.model, tone: "start" };
        else if (prev !== m.model) divider = { label: m.model, tone: "change" };
        prev = m.model;
      }
      return { msg: m, key: keyFor(m, i), divider };
    });
  }, [messages]);

  // Conservative windowing: render at most the most-recent WINDOW_SIZE rows
  // unless the user has expanded earlier ones. `hiddenCount` is clamped so a
  // shrinking history (e.g. after a regenerate trims trailing turns) can't
  // leave a stale offset that hides the whole list.
  const maxHidden = Math.max(0, rows.length - WINDOW_SIZE);
  const effectiveHidden = Math.min(hiddenCount === 0 ? maxHidden : hiddenCount, maxHidden);
  const visibleRows = useMemo(
    () => (effectiveHidden > 0 ? rows.slice(effectiveHidden) : rows),
    [rows, effectiveHidden],
  );

  // Reveal the next batch of older messages while keeping the viewport
  // anchored on the message the user was reading (scrollHeight grows by the
  // prepended rows' height, so we shift scrollTop by the same delta).
  const showEarlier = useCallback(() => {
    const el = scrollContainerRef.current;
    const before = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setHiddenCount((h) => {
      const cur = h === 0 ? maxHidden : h;
      return Math.max(0, cur - WINDOW_SIZE);
    });
    requestAnimationFrame(() => {
      const node = scrollContainerRef.current;
      if (node) node.scrollTop = prevTop + (node.scrollHeight - before);
    });
  }, [maxHidden, scrollContainerRef]);

  const pin = useCallback(async (m: Message, key: string, scope: MemoryScope) => {
    if (!m.content.trim()) return;
    setPinning(key);
    try {
      await saveMemory({
        content: m.content,
        conversationId: conversationId ?? null,
        sourceMsgId: m.id ?? null,
        tags: m.role,
        scope,
        projectRoot: scope === "project" ? (workspaceRoot ?? null) : null,
      });
      setPinned((s) => new Set([...s, key]));
    } catch (err) {
      logDiag({
        level: "warn",
        source: "message-list",
        message: "pin-message: saveMemory failed",
        detail: err,
      });
    } finally {
      setPinning(null);
    }
  }, [conversationId, workspaceRoot]);

  const canPinProject = !!workspaceRoot;
  const canPinConversation = conversationId != null;
  const canForkBase = conversationId != null && !!onFork;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }

  return (
    <>
      {effectiveHidden > 0 && (
        <button
          type="button"
          className="show-earlier-btn"
          data-testid="show-earlier"
          onClick={showEarlier}
        >
          Show earlier messages ({effectiveHidden})
        </button>
      )}
      {visibleRows.map(({ msg: m, key: k, divider }, sliceIdx) => {
        const idx = effectiveHidden + sliceIdx;
        return (
          <div key={k}>
            <MessageRow
              msg={m}
              divider={divider}
              isLast={idx === rows.length - 1}
              isLastUser={idx === lastUserIdx}
              isPinned={pinned.has(k)}
              isPinning={pinning === k}
              onPin={pin}
              rowKey={k}
              canPinProject={canPinProject}
              canPinConversation={canPinConversation}
              onRegenerate={onRegenerate}
              onEditUser={onEditUser}
              canFork={canForkBase && m.id != null}
              onFork={onFork}
            />
          </div>
        );
      })}
    </>
  );
});

export function MessageList({ messages, streaming, conversationId, workspaceRoot, currentModel, agentStatus, onRegenerate, onEditUser, onFork }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  // Autoscroll "sticks" to the bottom only while the user is already there.
  // Scrolling up to read pauses it; scrolling back near the bottom resumes.
  const stickRef = useRef(true);
  // Frame counter for autoscroll throttling. During streaming we only re-
  // dispatch a scrollTo every Nth requestAnimationFrame tick (≈20Hz instead
  // of 60Hz) — the bubble grows by a few px between ticks so visual catch-up
  // is imperceptible, but main-thread cost drops ~3×.
  const scrollTickRef = useRef(0);
  const SCROLL_THROTTLE_FRAMES = 3;

  // Distance from the bottom under which autoscroll stays engaged.
  const STICK_THRESHOLD_PX = 64;

  // rAF-coalesce the stick check so a finger-flick scroll (which fires
  // dozens of `scroll` events) doesn't recompute geometry per event. The
  // listener itself is passive (registered via useEffect below) so it
  // never blocks the compositor.
  const stickRafRef = useRef<number | null>(null);
  const recomputeStick = useCallback(() => {
    if (stickRafRef.current != null) return;
    stickRafRef.current = requestAnimationFrame(() => {
      stickRafRef.current = null;
      const el = listRef.current;
      if (!el) return;
      stickRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    });
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.addEventListener("scroll", recomputeStick, { passive: true });
    return () => {
      el.removeEventListener("scroll", recomputeStick);
      if (stickRafRef.current != null) {
        cancelAnimationFrame(stickRafRef.current);
        stickRafRef.current = null;
      }
    };
  }, [recomputeStick]);

  // New conversation → always start pinned to the bottom.
  useEffect(() => {
    stickRef.current = true;
  }, [conversationId]);

  // Autoscroll on streaming/message/agent-status changes. Throttled to every
  // Nth frame while streaming so the scroll-thread has headroom; un-throttled
  // for one-shot events (new message lands, agent status flips).
  const streamingKey = streaming !== undefined ? "s" : "n";
  useEffect(() => {
    if (!stickRef.current) return;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    const isStreamingTick = streaming !== undefined;
    if (isStreamingTick) {
      scrollTickRef.current = (scrollTickRef.current + 1) % SCROLL_THROTTLE_FRAMES;
      if (scrollTickRef.current !== 0) return;
    }
    const behavior: ScrollBehavior =
      isStreamingTick || agentStatus === "thinking" || agentStatus === "tool"
        ? "auto"
        : "smooth";
    scrollRafRef.current = requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    });
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [messages.length, streaming, agentStatus, streamingKey]);

  // Last assistant model anywhere in history (incl. tool turns) — the
  // streaming-bubble divider keys off this so a history ending on a tool
  // turn doesn't flash a stale "Switched to" banner.
  const lastAsstModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      // Audit M-F3: bind the indexed message once so TS narrows
      // `m.model` through the truthiness check instead of relying on
      // a `messages[i].model!` non-null assertion the next refactor
      // could outlive.
      const m = messages[i];
      if (m.role === "assistant" && m.model) {
        return m.model;
      }
    }
    return null;
  }, [messages]);

  const showEndFooter =
    messages.length > 0 && streaming === undefined && agentStatus === "idle" && lastAsstModel;
  const modelMatches = currentModel && lastAsstModel && currentModel === lastAsstModel;

  return (
    <div className="message-list" ref={listRef}>
      <MessageHistory
        messages={messages}
        conversationId={conversationId}
        workspaceRoot={workspaceRoot}
        scrollContainerRef={listRef}
        onRegenerate={onRegenerate}
        onEditUser={onEditUser}
        onFork={onFork}
      />

      {streaming !== undefined && (
        <>
          {currentModel && lastAsstModel !== currentModel && (
            <div className={`model-divider ${lastAsstModel === null ? "start" : "change"}`}>
              <span className="model-divider-line" />
              <span className="model-divider-label">
                {lastAsstModel === null ? "Started with" : "Switched to"} <code>{currentModel}</code>
              </span>
              <span className="model-divider-line" />
            </div>
          )}
          <StreamingMessage text={streaming} />
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
    </div>
  );
}
