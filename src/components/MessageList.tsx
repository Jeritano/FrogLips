import {
  useSyncExternalStore,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, RotateCw, GitBranch } from "lucide-react";
import type { Message, MemoryScope } from "../types";
import type { AgentStatus } from "../lib/agent-loop";
import { saveMemory } from "../lib/memory-client";
import { logDiag } from "../lib/diagnostics";
import { getReplyStat, subscribeReplyStats } from "../lib/reply-stats";
import {
  renderMarkdown,
  renderUserContent,
  containsUserCode,
  subscribeGrammarLoad,
  getGrammarVersion,
  setGrammarCacheInvalidator,
} from "../lib/markdown";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
// Syntax-highlight colors live in styles/syntax.css as theme-aware CSS
// vars (was a hardcoded github-dark.css import — its dark-only palette
// washed out on the light app theme). The chosen palette is applied via
// `documentElement.dataset.syntaxTheme`; see styles/syntax.css.
import "../styles/syntax.css";

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

// User-message code cache (item: render fenced/inline code in user bubbles).
// Same FIFO bound + content-keying as markdownCache. A user message rendered
// against a not-yet-loaded grammar (plaintext fallback) is invalidated by the
// grammar-load hook below, identically to the assistant cache.
const userCodeCache = new Map<string, string>();
function cachedUserContent(text: string): string {
  const hit = userCodeCache.get(text);
  if (hit !== undefined) return hit;
  const rendered = renderUserContent(text);
  if (userCodeCache.size >= MARKDOWN_CACHE_MAX) {
    const firstKey = userCodeCache.keys().next().value;
    if (firstKey !== undefined) userCodeCache.delete(firstKey);
  }
  userCodeCache.set(text, rendered);
  return rendered;
}

// When a lazily-loaded highlight.js grammar finishes registering, drop the HTML
// memos that were produced against the plaintext fallback so the next render
// re-highlights with the real grammar. markdown.ts owns the load lifecycle and
// calls this hook (set once at module load) immediately before notifying the
// React subscribers below. Clearing wholesale is fine — the caches refill
// lazily and a grammar load is rare.
setGrammarCacheInvalidator(() => {
  markdownCache.clear();
  userCodeCache.clear();
});

// Tool calls + results are NOT rendered inline. Agent runs stack many
// web_search / web_fetch / write_file steps; showing each as a bubble buries
// the answer. They're surfaced only via the Tool History panel (the toolbar
// "History" button → <ToolHistory>), leaving the stream to the prose + the
// live "Thinking…/Running tools…" status.

// ── Reasoning-model "thinking" disclosure ───────────────────────────────────
//
// Thinking models (R1 / Qwen3 / gpt-oss …) emit their chain-of-thought either
// inline as `<think>…</think>` or — for OpenAI-style streams — in a separate
// `reasoning` field that the backend clients (mlx-client / ollama-client) wrap
// in the same `<think>` sentinels. We split that span out of the answer here so
// it renders in a collapsed "Thought for a moment" disclosure ABOVE the prose
// instead of dumping the whole chain-of-thought inline.
const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>/i;
// An unterminated `<think>…` (model still mid-reasoning, or a stream that ended
// without closing the tag) — capture through end-of-string.
const THINK_OPEN_RE = /<think>([\s\S]*)$/i;

interface SplitThought {
  /** Reasoning text (sans tags), or "" when none present. */
  thought: string;
  /** The answer with the reasoning span removed. */
  answer: string;
  /** True while the `<think>` span is still open (no closing tag yet). */
  open: boolean;
}

function splitThought(content: string): SplitThought {
  if (!content || content.indexOf("<think>") < 0) {
    return { thought: "", answer: content, open: false };
  }
  const closed = THINK_BLOCK_RE.exec(content);
  if (closed) {
    const answer = content.slice(0, closed.index) + content.slice(closed.index + closed[0].length);
    return { thought: closed[1].trim(), answer: answer.replace(/^\n+/, ""), open: false };
  }
  const open = THINK_OPEN_RE.exec(content);
  if (open) {
    const answer = content.slice(0, open.index);
    return { thought: open[1].trim(), answer, open: true };
  }
  return { thought: "", answer: content, open: false };
}

function ThinkingDisclosure({
  thought,
  open,
}: {
  thought: string;
  /** Live-streaming reasoning → render expanded; completed → collapsed. */
  open: boolean;
}) {
  if (!thought) return null;
  return (
    <details className="thinking-disclosure" open={open} data-testid="thinking">
      <summary className="thinking-summary">
        {open ? "Thinking…" : "Thought for a moment"}
      </summary>
      <div className="thinking-body">{thought}</div>
    </details>
  );
}

// ── update_plan live checklist ───────────────────────────────────────────────
//
// The agent's `update_plan` tool maintains a pinned task checklist (see
// tool-registry.ts). The normalized plan lives in the tool-RESULT message
// (`role:"tool"`, `tool_name:"update_plan"`, content = JSON `{ok,plan}`); the
// assistant's tool_call also carries the plan in its arguments. We scan the
// message array (no extra IPC — the data is already here) for the LATEST plan of
// either form and render it as a sticky checklist, instead of leaving it buried
// as raw JSON in the Tool History panel.
type PlanStatus = "pending" | "in_progress" | "done";
interface PlanStep {
  step: string;
  status: PlanStatus;
}

function coercePlan(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PlanStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const rec = s as Record<string, unknown>;
    const step = typeof rec.step === "string" ? rec.step.trim() : "";
    if (!step) continue;
    const st = String(rec.status);
    const status: PlanStatus =
      st === "in_progress" || st === "done" ? st : "pending";
    out.push({ step, status });
  }
  return out.length ? out : null;
}

/** Latest `update_plan` checklist anywhere in the message list, or null. */
function latestPlan(messages: Message[]): PlanStep[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Tool-result form (canonical, normalized) — preferred.
    if (m.role === "tool" && m.tool_name === "update_plan" && m.content) {
      try {
        const parsed = JSON.parse(m.content) as { plan?: unknown };
        const plan = coercePlan(parsed?.plan);
        if (plan) return plan;
      } catch {
        // fall through — malformed result, keep scanning older turns
      }
    }
    // Assistant tool_call form — arguments may be an object or a JSON string.
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (let j = m.tool_calls.length - 1; j >= 0; j--) {
        const tc = m.tool_calls[j];
        if (tc.function?.name !== "update_plan") continue;
        const args = tc.function.arguments;
        let planRaw: unknown;
        if (typeof args === "string") {
          try {
            planRaw = (JSON.parse(args) as { plan?: unknown })?.plan;
          } catch {
            planRaw = undefined;
          }
        } else if (args && typeof args === "object") {
          planRaw = (args as { plan?: unknown }).plan;
        }
        const plan = coercePlan(planRaw);
        if (plan) return plan;
      }
    }
  }
  return null;
}

function PlanChecklist({ plan }: { plan: PlanStep[] }) {
  const done = plan.filter((s) => s.status === "done").length;
  return (
    <div className="plan-checklist" data-testid="plan-checklist">
      <div className="plan-checklist-head">
        <span className="plan-checklist-title">Plan</span>
        <span className="plan-checklist-count">
          {done}/{plan.length}
        </span>
      </div>
      <ul className="plan-steps">
        {plan.map((s, i) => (
          <li key={i} className={`plan-step ${s.status}`}>
            <span className="plan-step-mark" aria-hidden="true">
              {s.status === "done" ? "✓" : s.status === "in_progress" ? "◐" : "○"}
            </span>
            <span className="plan-step-text">{s.step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Re-render trigger for lazily-loaded highlight.js grammars. A code block first
// rendered before its grammar finished loading shows the plaintext fallback;
// when the grammar lands, markdown.ts clears the HTML caches and bumps a version
// counter. Subscribing here re-runs the (now cache-miss) render so the block
// highlights for real. useSyncExternalStore keeps it concurrent-safe.
function useGrammarVersion(): number {
  return useSyncExternalStore(subscribeGrammarLoad, getGrammarVersion);
}

/** Completed assistant prose: collapsed reasoning disclosure (if the reply
 *  carried a `<think>` span) above the markdown-rendered answer. */
function AssistantContent({ content }: { content: string }) {
  const { thought, answer } = splitThought(content);
  // Subscribe so a lazy grammar load re-highlights this reply's code blocks.
  useGrammarVersion();
  return (
    <div className="content markdown">
      <ThinkingDisclosure thought={thought} open={false} />
      <div dangerouslySetInnerHTML={{ __html: cachedMarkdown(answer) }} />
    </div>
  );
}

/** Assistant prose for a turn that ALSO made tool calls (tool chrome hidden).
 *  Renders only the prose + reasoning; returns null when there's nothing to
 *  show. Separate from AssistantContent so it can return null and still call
 *  the grammar-version hook unconditionally. */
function AssistantToolCallContent({ content }: { content: string }) {
  const { thought, answer } = splitThought(content);
  // Subscribe so a lazy grammar load re-highlights this turn's code blocks.
  useGrammarVersion();
  const html = answer.trim() ? cachedMarkdown(answer) : "";
  if (!html && !thought) return null;
  return (
    <div className="message assistant">
      <div className="content markdown">
        <ThinkingDisclosure thought={thought} open={false} />
        {html && <div dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  );
}

/** User message body. Plain prose stays literal text (no markdown surprises),
 *  but pasted fenced ``` blocks + inline `code` get the monospace + syntax-
 *  highlight + copy-button treatment. Falls back to the original plain-text
 *  node when the message contains no code, keeping the cheap path for the
 *  common case. */
function UserContent({ content }: { content: string }) {
  const hasCode = containsUserCode(content);
  // Subscribe so a lazy grammar load re-highlights pasted code (mirrors the
  // assistant path). Cheap no-op when the message has no code.
  useGrammarVersion();
  if (!hasCode) {
    // No code → preserve the prior behavior exactly: a plain text node, with
    // the bubble's `white-space: pre-wrap` handling newlines. No marked, no
    // sanitizer, no surprise formatting.
    return <div className="content">{content}</div>;
  }
  return (
    <div
      className="content markdown user-code"
      dangerouslySetInnerHTML={{ __html: cachedUserContent(content) }}
    />
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

function MessageActions({
  msg,
  isLast,
  isLastUser,
  onRegenerate,
  onEditUser,
}: {
  msg: Message;
  isLast: boolean;
  isLastUser: boolean;
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
          if (ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }
        }}
      >
        {copied ? (
          <>
            <Check size={16} /> Copied
          </>
        ) : (
          "Copy"
        )}
      </button>
      {msg.role === "assistant" && isLast && onRegenerate && (
        <button
          className="msg-action"
          title="Regenerate response"
          onClick={onRegenerate}
        >
          <RotateCw size={16} /> Regenerate
        </button>
      )}
      {msg.role === "user" && isLastUser && onEditUser && (
        <button
          className="msg-action"
          title="Edit and retry"
          onClick={() => onEditUser(msg)}
        >
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

function MessageRowImpl({
  msg,
  divider,
  isLast,
  isLastUser,
  isPinned,
  isPinning,
  onPin,
  rowKey,
  canPinProject,
  canPinConversation,
  onRegenerate,
  onEditUser,
  canFork,
  onFork,
}: RowProps) {
  // Tool results are hidden from the stream (see the Tool History panel); rows
  // are pre-filtered, so this guard is belt-and-suspenders.
  if (msg.role === "tool") return null;

  if (msg.role === "assistant" && msg.tool_calls?.length) {
    // Tool-call chrome is hidden — render only the assistant's prose, if any.
    // Pure tool-call turns are already filtered out of `rows` upstream.
    // Delegated to a component so it can subscribe to lazy-grammar reloads via
    // useGrammarVersion (hooks can't run after MessageRowImpl's early returns).
    return <AssistantToolCallContent content={msg.content ?? ""} />;
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
      <div
        className={`message ${msg.role}`}
        data-testid={`message-${msg.role}`}
      >
        {isUser ? (
          <UserContent content={msg.content} />
        ) : (
          <AssistantContent content={msg.content} />
        )}
        {!isUser && <ReplyStatFooter msg={msg} />}
        <MessageActions
          msg={msg}
          isLast={isLast}
          isLastUser={isLastUser}
          onRegenerate={onRegenerate}
          onEditUser={onEditUser}
        />
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
function ForkButton({
  msg,
  onFork,
}: {
  msg: Message;
  onFork: (m: Message) => void;
}) {
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
      {armed ? (
        "Click again to confirm"
      ) : (
        <>
          <GitBranch size={16} /> Fork from here
        </>
      )}
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
function PinControl({
  msg,
  rowKey,
  isPinned,
  isPinning,
  onPin,
  canPinProject,
  canPinConversation,
}: PinControlProps) {
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
        <option value="project" disabled={!canPinProject}>
          P
        </option>
        <option value="conversation" disabled={!canPinConversation}>
          C
        </option>
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
          <span
            className="mb-spinner"
            style={{ width: 10, height: 10, borderWidth: 1.5 }}
          />
        ) : isPinned ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
          </svg>
        ) : (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          >
            <polygon points="12 2 15.09 8.63 22 9.24 16.54 13.97 18.18 21 12 17.27 5.82 21 7.46 13.97 2 9.24 8.91 8.63 12 2" />
          </svg>
        )}
      </button>
    </span>
  );
}

// memo on shallow-equal props — handlers are stabilized via useCallback in
// the parent. Without this, a single streaming chunk re-renders every prior
// message (cached markdown helps but DOM diff still runs).
/** Per-reply perf footer (wave D): "42.3 tok/s · TTFT 180ms · 512 tok" with
 *  a cold-load badge when the server reported a >1s model load. Subscribes
 *  to the volatile stat store so the footer appears the moment the stat
 *  lands (stats key on persisted message id, which arrives post-stream). */
function ReplyStatFooter({ msg }: { msg: Message }) {
  const stat = useSyncExternalStore(subscribeReplyStats, () =>
    getReplyStat(msg.id),
  );
  if (!stat || msg.role !== "assistant") return null;
  return (
    <div className="reply-stat" data-testid="reply-stat">
      {stat.tokPerSec != null && <span>{stat.tokPerSec} tok/s</span>}
      <span>
        TTFT{" "}
        {stat.ttftMs >= 1000
          ? `${(stat.ttftMs / 1000).toFixed(1)}s`
          : `${stat.ttftMs}ms`}
      </span>
      {stat.completionTokens != null && (
        <span>{stat.completionTokens} tok</span>
      )}
      {stat.coldLoad && (
        <span
          className="reply-stat-cold"
          title="The model was loaded from disk for this reply — TTFT reflects the reload, not the model's speed."
        >
          cold load
        </span>
      )}
    </div>
  );
}

const MessageRow = memo(MessageRowImpl);

// Progressive-markdown split point. During streaming we render the already-
// COMPLETE prefix as cached markdown (so finished paragraphs + closed code
// fences highlight live) and keep only the trailing in-flight tail as plain
// text. The boundary is the last blank line (`\n\n`) that is NOT inside an open
// (unterminated) code fence — markdown blocks are paragraph-delimited, so a
// blank line outside a fence is always a safe block boundary. If a fence is
// currently open, the split is pulled back to just before that fence's opening
// line so the half-streamed fence stays in the plain tail (rendering it as
// markdown would syntax-highlight an incomplete block and re-highlight every
// frame). Keying the prefix on the stable `\n\n` boundary keeps cachedMarkdown
// hits bounded — the key only advances when a new block completes, not per token.
function splitStreamingPrefix(text: string): { prefix: string; tail: string } {
  // Track fence state line-by-line. A fence opens/closes on a line that begins
  // (after ≤3 spaces) with ≥3 backticks or tildes.
  let fenceOpen = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLineStart = -1; // byte offset of the currently-open fence's opening line
  let lastSafeBoundary = 0; // byte offset just past the last blank line outside a fence
  let pos = 0;
  let prevBlank = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const run = fence[1];
      if (!fenceOpen) {
        fenceOpen = true;
        fenceChar = run[0];
        fenceLen = run.length;
        fenceLineStart = pos;
      } else if (run[0] === fenceChar && run.length >= fenceLen) {
        fenceOpen = false;
        fenceLineStart = -1;
      }
    }
    // A blank line outside any open fence is a block boundary — record the
    // offset just past it (start of the next line).
    const isBlank = line.trim() === "";
    if (isBlank && !fenceOpen && !prevBlank) {
      lastSafeBoundary = pos + line.length + 1;
    }
    prevBlank = isBlank;
    pos += line.length + 1; // +1 for the consumed "\n"
  }
  // An open fence caps the prefix at the fence's opening line, never past it.
  let cut = lastSafeBoundary;
  if (fenceOpen && fenceLineStart >= 0 && fenceLineStart < cut) {
    cut = fenceLineStart;
  }
  if (cut <= 0) return { prefix: "", tail: text };
  return { prefix: text.slice(0, cut), tail: text.slice(cut) };
}

const StreamingMessage = memo(function StreamingMessage({
  text,
}: {
  text: string;
}) {
  // Maturity dim 10 (a11y): announce streaming text to assistive
  // tech. `aria-live="polite"` instructs the screen reader to
  // queue updates rather than interrupting other speech;
  // `aria-atomic="false"` so only the delta is re-read, not the
  // entire growing bubble. Screen readers throttle naturally so
  // 100+ tok/s emit doesn't cause a torrent.
  //
  // Reasoning models stream `<think>…</think>` (inline or wrapped by the backend
  // clients). Split it out so the live bubble shows a "Thinking…" disclosure
  // instead of dumping the raw chain-of-thought (and never the literal tags).
  const { thought, answer, open } = splitThought(text);
  // Re-highlight the streamed prefix's code blocks when a lazy grammar lands.
  useGrammarVersion();
  // PROGRESSIVE MARKDOWN: render the completed prefix as cached markdown (closed
  // code fences highlight live, finished paragraphs format) and keep only the
  // in-flight tail as plain escaped text. `cachedMarkdown` is keyed on the stable
  // `\n\n` prefix so the marked → DOMPurify round-trip only re-runs when a new
  // block completes — not per token — keeping the old O(n²)-per-frame regression
  // from coming back. The trailing `{tail}` is a JSX text child → React escapes
  // it, so the unfinished tail is never parsed/sanitized.
  const { prefix, tail } = splitStreamingPrefix(answer);
  const prefixHtml = prefix ? cachedMarkdown(prefix) : "";
  return (
    <div
      className="message assistant"
      data-testid="streaming-bubble"
      aria-live="polite"
      aria-atomic="false"
    >
      <div className="content markdown streaming-plain">
        <ThinkingDisclosure thought={thought} open={open} />
        {prefixHtml && (
          <div
            className="streaming-prefix"
            dangerouslySetInnerHTML={{ __html: prefixHtml }}
          />
        )}
        {tail}
        <span className="cursor">▍</span>
      </div>
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
  /** When true (in-conversation Find is open) ALL rows render — even the
   *  windowed/'show earlier' ones — so every match is in the DOM to scroll
   *  to + highlight. */
  forceExpand?: boolean;
  onRegenerate?: () => void;
  onEditUser?: (m: Message) => void;
  onFork?: (m: Message) => void;
}

const MessageHistory = memo(function MessageHistory({
  messages,
  conversationId,
  workspaceRoot,
  scrollContainerRef,
  forceExpand,
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
    const out: Row[] = [];
    messages.forEach((m, i) => {
      // Tool noise is hidden from the stream — the calls are surfaced only via
      // the Tool History panel (the single "History" button in the toolbar).
      // Drop tool results and assistant turns that ONLY made tool calls (no
      // prose to render). Mixed turns (text + tool_calls) keep their text.
      if (m.role === "tool") return;
      if (m.role === "assistant" && m.tool_calls?.length && !m.content?.trim())
        return;
      let divider: Row["divider"] = null;
      if (m.role === "assistant" && m.model && !m.tool_calls?.length) {
        if (prev === null) divider = { label: m.model, tone: "start" };
        else if (prev !== m.model) divider = { label: m.model, tone: "change" };
        prev = m.model;
      }
      out.push({ msg: m, key: keyFor(m, i), divider });
    });
    return out;
  }, [messages]);

  // Conservative windowing: render at most the most-recent WINDOW_SIZE rows
  // unless the user has expanded earlier ones. `hiddenCount` is clamped so a
  // shrinking history (e.g. after a regenerate trims trailing turns) can't
  // leave a stale offset that hides the whole list.
  const maxHidden = Math.max(0, rows.length - WINDOW_SIZE);
  const effectiveHidden = forceExpand
    ? 0
    : Math.min(hiddenCount === 0 ? maxHidden : hiddenCount, maxHidden);
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

  const pin = useCallback(
    async (m: Message, key: string, scope: MemoryScope) => {
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
    },
    [conversationId, workspaceRoot],
  );

  const canPinProject = !!workspaceRoot;
  const canPinConversation = conversationId != null;
  const canForkBase = conversationId != null && !!onFork;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
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

// ── In-conversation Find (Cmd+F) ─────────────────────────────────────────────
//
// A lightweight find bar SCOPED to the open conversation. The native webview
// Cmd+F is unreliable against the 150-row window (it can't see collapsed rows,
// and Tauri's webview intercepts inconsistently), so we roll our own: search
// the rendered message DOM, wrap every hit in <mark class="find-hit">, and
// step through them with next/prev. When find is open the row window is force-
// expanded (see MessageHistory.forceExpand) so hits inside 'show earlier' rows
// are in the DOM to scroll to.
//
// Highlighting is DOM-based (a TreeWalker over text nodes) rather than text-
// offset-based so it works regardless of how each message rendered (plain
// user prose, markdown HTML, syntax-highlighted code) — we highlight what the
// user actually SEES.

const FIND_HIT_CLASS = "find-hit";
const FIND_CURRENT_CLASS = "find-current";

// Remove all our <mark> wrappers under `root`, restoring the original text.
function clearFindMarks(root: HTMLElement): void {
  const marks = root.querySelectorAll(`mark.${FIND_HIT_CLASS}`);
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    // Replace the <mark> with its text content, then merge adjacent text nodes.
    parent.replaceChild(
      mark.ownerDocument.createTextNode(mark.textContent ?? ""),
      mark,
    );
    parent.normalize();
  }
}

// Wrap every case-insensitive occurrence of `query` in a text node under
// `root` with <mark class="find-hit">. Returns the marks in document order.
// Skips the find bar itself and non-content nodes (script/style).
function applyFindMarks(root: HTMLElement, query: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  if (!query) return marks;
  const needle = query.toLowerCase();
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const text = node.nodeValue;
      if (!text || !text.toLowerCase().includes(needle)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip text inside the find bar, scripts/styles, and existing marks.
      let p = node.parentElement;
      while (p && p !== root) {
        const tag = p.tagName;
        if (
          tag === "SCRIPT" ||
          tag === "STYLE" ||
          tag === "MARK" ||
          p.classList.contains("find-bar")
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  // Collect first (mutating during walk invalidates the walker).
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  for (const node of targets) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    const frag = doc.createDocumentFragment();
    let last = 0;
    let idx = lower.indexOf(needle, last);
    while (idx !== -1) {
      if (idx > last) frag.appendChild(doc.createTextNode(text.slice(last, idx)));
      const mark = doc.createElement("mark");
      mark.className = FIND_HIT_CLASS;
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      marks.push(mark);
      last = idx + needle.length;
      idx = lower.indexOf(needle, last);
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
  return marks;
}

interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  current: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function FindBar({
  query,
  onQueryChange,
  current,
  total,
  onNext,
  onPrev,
  onClose,
  inputRef,
}: FindBarProps) {
  return (
    <div className="find-bar" data-testid="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        data-testid="find-input"
        type="text"
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="find-count" data-testid="find-count" aria-live="polite">
        {total > 0 ? `${current + 1}/${total}` : query ? "0/0" : ""}
      </span>
      <button
        type="button"
        className="find-nav"
        data-testid="find-prev"
        onClick={onPrev}
        disabled={total === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        type="button"
        className="find-nav"
        data-testid="find-next"
        onClick={onNext}
        disabled={total === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        ↓
      </button>
      <button
        type="button"
        className="find-close"
        data-testid="find-close"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
      >
        ✕
      </button>
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  conversationId,
  workspaceRoot,
  currentModel,
  agentStatus,
  onRegenerate,
  onEditUser,
  onFork,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  // Delegated handler for the post-sanitize code-block copy buttons (see
  // wrapCodeBlocks in lib/markdown.ts). The buttons live inside
  // dangerouslySetInnerHTML markup so they can't carry React handlers — one
  // listener on the list container covers every rendered block. The
  // "Copied" flash is plain classList/textContent (no state) for the same
  // reason.
  const onListClick = useCallback(
    async (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      // Soft-wrap toggle — flips a class on the .code-block (CSS does the rest).
      const wrapBtn = target.closest?.(".code-wrap-btn");
      if (wrapBtn instanceof HTMLElement) {
        const block = wrapBtn.closest(".code-block");
        if (block) {
          const wrapped = block.classList.toggle("wrap");
          wrapBtn.classList.toggle("active", wrapped);
        }
        return;
      }
      // Download — build a blob from the block's text, filename inferred from
      // the language label (set as data-filename by wrapCodeBlocks).
      const dlBtn = target.closest?.(".code-download-btn");
      if (dlBtn instanceof HTMLElement) {
        const code = dlBtn.closest(".code-block")?.querySelector("pre code");
        if (!code) return;
        const name = dlBtn.getAttribute("data-filename") || "snippet.txt";
        const blob = new Blob([code.textContent ?? ""], {
          type: "text/plain;charset=utf-8",
        });
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke after the click is dispatched so the download isn't cancelled.
        setTimeout(() => URL.revokeObjectURL(href), 0);
        return;
      }
      // Copy — original behavior.
      const btn = target.closest?.(".code-copy-btn");
      if (!(btn instanceof HTMLElement)) return;
      const code = btn.closest(".code-block")?.querySelector("pre code");
      if (!code) return;
      const ok = await copyText(code.textContent ?? "");
      if (!ok) return;
      btn.classList.add("copied");
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = "Copy";
      }, 1200);
    },
    [],
  );
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
  // Mutable mirror of whether content is actively arriving — read inside the
  // rAF-coalesced scroll handler (which is created once) without re-binding it.
  const activeRef = useRef(false);
  const setShowJumpRef = useRef<(v: boolean) => void>(() => {});
  const recomputeStick = useCallback(() => {
    if (stickRafRef.current != null) return;
    stickRafRef.current = requestAnimationFrame(() => {
      stickRafRef.current = null;
      const el = listRef.current;
      if (!el) return;
      const stuck =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
      stickRef.current = stuck;
      // Pill shows only when scrolled away AND content is streaming/arriving.
      setShowJumpRef.current(!stuck && activeRef.current);
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
  useEffect(() => {
    if (!stickRef.current) return;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    const isStreamingTick = streaming !== undefined;
    if (isStreamingTick) {
      scrollTickRef.current =
        (scrollTickRef.current + 1) % SCROLL_THROTTLE_FRAMES;
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
  }, [messages.length, streaming, agentStatus]);

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
    messages.length > 0 &&
    streaming === undefined &&
    agentStatus === "idle" &&
    lastAsstModel;
  const modelMatches =
    currentModel && lastAsstModel && currentModel === lastAsstModel;

  // update_plan live checklist — latest plan parsed from the messages we already
  // have (no extra IPC). Recomputed only when the message list changes.
  const plan = useMemo(() => latestPlan(messages), [messages]);

  // Jump-to-latest pill: shown only when autoscroll is NOT stuck to the bottom
  // (user scrolled up) AND content is actively arriving (streaming / agent
  // running). Clicking scrolls to bottom and re-arms stick. State is driven off
  // the same rAF-coalesced geometry as `recomputeStick`.
  const [showJump, setShowJump] = useState(false);
  const isActive =
    streaming !== undefined ||
    agentStatus === "thinking" ||
    agentStatus === "tool";
  // Expose the latest `isActive` + setter to the once-created scroll handler.
  activeRef.current = isActive;
  setShowJumpRef.current = setShowJump;
  // While content is arriving, re-check stick geometry each streaming tick so the
  // pill appears even when content grew under a scrolled-up viewport (no scroll
  // event fires in that case, so recomputeStick alone wouldn't catch it).
  useEffect(() => {
    if (!isActive) {
      setShowJump(false);
      return;
    }
    setShowJump(!stickRef.current);
  }, [isActive, streaming, messages.length]);

  const jumpToLatest = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // ── In-conversation Find (Cmd+F) ───────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findActive, setFindActive] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Marks in document order — refreshed by the highlight effect, read by nav.
  const findMarksRef = useRef<HTMLElement[]>([]);
  // Re-highlight when a lazily-loaded grammar swaps a code block's DOM out from
  // under us (the marks were in the old nodes).
  const grammarVersion = useGrammarVersion();

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
  }, []);

  // Open on Cmd/Ctrl+F. Bound at the document level (gated on the chat list
  // being mounted) because the message-list div isn't focusable, so a keydown
  // on it alone wouldn't fire reliably. Scoped to THIS conversation's list —
  // see note below for the ChatWindow-level alternative.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        // Only hijack when a message list is present (chat view active).
        if (!listRef.current) return;
        e.preventDefault();
        setFindOpen(true);
        // Focus + select on the next frame so re-opening over an existing query
        // selects it for quick replacement.
        requestAnimationFrame(() => {
          findInputRef.current?.focus();
          findInputRef.current?.select();
        });
      } else if (e.key === "Escape" && findOpen) {
        closeFind();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [findOpen, closeFind]);

  // Move the "current" highlight to index i and scroll it into view.
  const focusMatch = useCallback((i: number) => {
    const marks = findMarksRef.current;
    if (marks.length === 0) return;
    const clamped = ((i % marks.length) + marks.length) % marks.length;
    marks.forEach((m, j) => m.classList.toggle(FIND_CURRENT_CLASS, j === clamped));
    marks[clamped]?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFindActive(clamped);
  }, []);

  const findNext = useCallback(() => focusMatch(findActive + 1), [focusMatch, findActive]);
  const findPrev = useCallback(() => focusMatch(findActive - 1), [focusMatch, findActive]);

  // (Re)apply highlights whenever the query, the rendered content, or a lazy
  // grammar load changes. Runs post-commit so force-expanded rows are present
  // in the DOM. The cleanup clears marks so a closed/edited query never leaves
  // stale <mark> wrappers behind. Autoscroll-stick is disabled while finding so
  // jumping to an older match isn't yanked back to the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    clearFindMarks(el);
    if (!findOpen || !findQuery) {
      findMarksRef.current = [];
      setFindCount(0);
      return;
    }
    const marks = applyFindMarks(el, findQuery);
    findMarksRef.current = marks;
    setFindCount(marks.length);
    if (marks.length > 0) {
      // Reading a match → pause stick-to-bottom so the jump survives.
      stickRef.current = false;
      const start = Math.min(findActive, marks.length - 1);
      const clamped = start < 0 ? 0 : start;
      marks.forEach((m, j) =>
        m.classList.toggle(FIND_CURRENT_CLASS, j === clamped),
      );
      marks[clamped]?.scrollIntoView({ block: "center", behavior: "auto" });
      setFindActive(clamped);
    } else {
      setFindActive(0);
    }
    return () => clearFindMarks(el);
    // `findActive` is intentionally excluded — nav updates it + scrolls directly
    // via focusMatch without needing a full re-highlight pass. `streaming` is
    // also excluded on purpose: re-marking the whole conversation DOM on every
    // streamed token would thrash; matches in a just-finished reply are picked
    // up when it persists into `messages`. Stale marks inside the live bubble
    // self-heal on the next messages/query change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, messages, grammarVersion]);

  return (
    <div className="message-list" ref={listRef} onClick={onListClick}>
      {findOpen && (
        <FindBar
          query={findQuery}
          onQueryChange={(q) => {
            setFindQuery(q);
            setFindActive(0);
          }}
          current={findActive}
          total={findCount}
          onNext={findNext}
          onPrev={findPrev}
          onClose={closeFind}
          inputRef={findInputRef}
        />
      )}
      {plan && <PlanChecklist plan={plan} />}
      <MessageHistory
        messages={messages}
        conversationId={conversationId}
        workspaceRoot={workspaceRoot}
        scrollContainerRef={listRef}
        forceExpand={findOpen}
        onRegenerate={onRegenerate}
        onEditUser={onEditUser}
        onFork={onFork}
      />

      {streaming !== undefined && (
        <>
          {currentModel && lastAsstModel !== currentModel && (
            <div
              className={`model-divider ${lastAsstModel === null ? "start" : "change"}`}
            >
              <span className="model-divider-line" />
              <span className="model-divider-label">
                {lastAsstModel === null ? "Started with" : "Switched to"}{" "}
                <code>{currentModel}</code>
              </span>
              <span className="model-divider-line" />
            </div>
          )}
          <StreamingMessage text={streaming} />
        </>
      )}

      {(agentStatus === "thinking" || agentStatus === "tool") && (
        <div className="agent-thinking-row">
          <span
            className="mb-spinner"
            style={{ width: 12, height: 12, borderWidth: 1.5 }}
          />
          <span>{agentStatus === "tool" ? "Running tools…" : "Thinking…"}</span>
        </div>
      )}

      {showEndFooter && (
        <div className="model-end-footer">
          {modelMatches ? (
            <>
              Still on <code>{lastAsstModel}</code>
            </>
          ) : currentModel ? (
            <>
              Last response from <code>{lastAsstModel}</code> · now on{" "}
              <code>{currentModel}</code>
            </>
          ) : (
            <>
              Last response from <code>{lastAsstModel}</code>
            </>
          )}
        </div>
      )}

      {showJump && (
        <button
          type="button"
          className="jump-latest-pill"
          data-testid="jump-latest"
          onClick={jumpToLatest}
          title="Jump to latest"
          aria-label="Jump to latest"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}
