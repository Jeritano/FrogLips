import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Zap,
  Clock,
  ShieldCheck,
  Shuffle,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  X,
  BookOpen,
  Play,
  Columns,
} from "lucide-react";
import { api, type RunCheckpoint } from "../lib/tauri-api";
import { demoteMemory, getRagContextEnabled, setRagContextEnabled } from "../lib/memory-client";
import type { ConfirmDecision } from "../lib/agent-loop";
import { summarizeToolCall } from "../lib/agent-loop/dispatch";
import { buildConfirmDiff } from "../lib/agent-loop/diff";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AgentMetrics, AgentStatus } from "../lib/agent-loop";
import type {
  Conversation,
  ConversationParams,
  Memory,
  Message,
  ProjectPolicy,
  ServerStatus,
} from "../types";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { ContextRolloverBanner } from "./ContextRolloverBanner";
import { ToolHistory } from "./ToolHistory";
import { ParamsPanel } from "./ParamsPanel";
import { ContextMeter } from "./ContextMeter";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorBar } from "./ErrorBar";
import { AgentToolbar } from "./AgentToolbar";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import { EmptyChatLanding } from "./EmptyChatLanding";
import {
  emptyParams,
  parseConversationParams,
  serializeConversationParams,
} from "../lib/conversation-params";
import { logDiag } from "../lib/diagnostics";
import { useAgentSettings } from "../hooks/useAgentSettings";
import { useCitationOpener } from "../hooks/useCitationOpener";
import { useAskUserModal } from "../hooks/useAskUserModal";
import { useQuickPromptToast } from "../hooks/useQuickPromptToast";
import { useChatSend } from "../hooks/useChatSend";
import { useMessageActions } from "../hooks/useMessageActions";
import type { RouteDecision } from "../lib/chat-router";
import { RoutesSettings } from "./RoutesSettings";
import { useEvent } from "../hooks/useEvent";

// Side-by-side multi-model compare (W5B-COMPARE). Lazy-loaded so its selector +
// concurrent-stream engine stay out of the first-paint chunk; it only downloads
// when the user actually opens compare mode.
const CompareView = lazy(() =>
  import("./CompareView").then((m) => ({ default: m.CompareView })),
);

interface Props {
  status: ServerStatus | null;
  conversation: Conversation | null;
  onConversationCreated: (c: Conversation) => void;
  onMemoriesChanged?: () => void;
  /**
   * Invoked after a fork is created. Receives the new conversation id so the
   * host can refresh the sidebar and switch the active selection to it.
   */
  onForked?: (newConvId: number) => void;
  /**
   * Self-healing send (2026-06-11): starts the model currently selected in
   * the ModelPicker. Called when the user sends with no backend running so
   * the composer never has to sit disabled. Resolves true once running.
   */
  ensureModel?: () => Promise<boolean>;
}

interface ConfirmState {
  toolName: string;
  args: Record<string, unknown>;
  risk: string;
}

/**
 * Owns the per-frame streaming TEXT so ChatWindow doesn't have to (perf
 * 2026-06-12). It registers its own `setStreaming` into the parent's ref on
 * mount, then re-renders 60×/sec on its OWN state during a stream — the parent
 * ChatWindow (and its toolbar/composer/meter siblings) stay put. Memoized so a
 * parent re-render with unchanged list props doesn't touch it; the list props
 * are all stable during a stream, so MessageList's internal history memo bails
 * and only the streaming bubble repaints.
 */
type StreamingMessageListProps = Omit<
  Parameters<typeof MessageList>[0],
  "streaming"
> & {
  registerStreamSetter: (fn: ((v: string | undefined) => void) | null) => void;
};
const StreamingMessageList = memo(function StreamingMessageList({
  registerStreamSetter,
  ...listProps
}: StreamingMessageListProps) {
  const [streaming, setStreaming] = useState<string | undefined>();
  useEffect(() => {
    registerStreamSetter(setStreaming);
    return () => registerStreamSetter(null);
  }, [registerStreamSetter]);
  return <MessageList {...listProps} streaming={streaming} />;
});

/**
 * Render a unified-diff string with minimal +/− line coloring so the user can
 * scan a write/edit at a glance instead of reading raw JSON (item 1). Plain
 * presentational; the colors are inline so no CSS ownership is needed.
 */
const ConfirmDiff = memo(function ConfirmDiff({ diff }: { diff: string }) {
  return (
    <pre
      className="agent-confirm-args"
      data-testid="agent-confirm-diff"
      style={{ whiteSpace: "pre", overflowX: "auto", wordBreak: "normal" }}
    >
      {diff.split("\n").map((line, i) => {
        const color =
          line.startsWith("+") && !line.startsWith("+++")
            ? "var(--success-fg, #4ade80)"
            : line.startsWith("-") && !line.startsWith("---")
              ? "var(--danger-fg, #fca5a5)"
              : line.startsWith("@@")
                ? "var(--text-muted)"
                : undefined;
        return (
          <div key={i} style={color ? { color } : undefined}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
});

/**
 * Body of the tool-confirmation modal: a one-line plain-English action summary
 * (item 2), a readable unified DIFF for write/edit tools (item 1), and the raw
 * JSON args tucked into a collapsible `<details>` so the full payload is still
 * available without dominating the modal.
 */
const ConfirmBody = memo(function ConfirmBody({
  toolName,
  args,
}: {
  toolName: string;
  args: Record<string, unknown>;
}) {
  const summary = summarizeToolCall(toolName, args);
  const diff = buildConfirmDiff(toolName, args);
  return (
    <>
      <div className="agent-confirm-summary" data-testid="agent-confirm-summary">
        {summary}
      </div>
      {diff != null && <ConfirmDiff diff={diff} />}
      <details className="agent-confirm-raw">
        <summary
          data-testid="agent-confirm-raw-toggle"
          style={{
            cursor: "pointer",
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 6,
          }}
        >
          Raw arguments
        </summary>
        <pre className="agent-confirm-args" data-testid="agent-confirm-args">
          {JSON.stringify(args, null, 2)}
        </pre>
      </details>
    </>
  );
});

/**
 * RESUME: review-before-continue affordance for an interrupted agent run found
 * on this conversation's durable checkpoint. Collapsed by default — the user
 * expands it to see WHAT was already done (turn count + tools used + the last
 * action), then explicitly clicks Resume. We NEVER auto-resume: a buggy resume
 * on a cloud route could re-bill turns, so resume is also gated to local
 * backends (the button is disabled with an explanation when the active backend
 * is a cloud route). Plain presentational; inline styles + CSS variables so no
 * stylesheet ownership is needed.
 */
const ResumeBanner = memo(function ResumeBanner({
  ckpt,
  open,
  busy,
  canResume,
  localBackend,
  onToggleReview,
  onResume,
  onDismiss,
}: {
  ckpt: RunCheckpoint;
  open: boolean;
  busy: boolean;
  canResume: boolean;
  localBackend: boolean;
  onToggleReview: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  // Summarize what the run already did. Tool turns are `role:"tool"`; collect
  // the distinct tool names (in first-seen order) for an at-a-glance recap.
  const toolTurns = ckpt.turns.filter((t) => t.role === "tool");
  const toolNames: string[] = [];
  for (const t of toolTurns) {
    const n = t.tool_name ?? "tool";
    if (!toolNames.includes(n)) toolNames.push(n);
  }
  const when = ckpt.updated_at
    ? new Date(ckpt.updated_at * 1000).toLocaleString()
    : "an earlier session";
  return (
    <div
      data-testid="resume-banner"
      style={{
        margin: "8px 12px",
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--border, #333)",
        background: "var(--surface-2, rgba(255,255,255,0.04))",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "inline-flex", color: "var(--text-muted)" }}>
          <Play size={16} />
        </span>
        <strong>Unfinished agent run</strong>
        <span style={{ color: "var(--text-muted)" }}>
          {ckpt.turns.length} turn{ckpt.turns.length === 1 ? "" : "s"}
          {toolTurns.length > 0
            ? ` · ${toolTurns.length} tool call${toolTurns.length === 1 ? "" : "s"}`
            : ""}{" "}
          · last active {when}
        </span>
        <button
          type="button"
          data-testid="resume-review-toggle"
          onClick={onToggleReview}
          aria-expanded={open}
          style={{
            marginLeft: "auto",
            font: "inherit",
            cursor: "pointer",
            background: "none",
            border: "none",
            color: "var(--accent, #7aa2f7)",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {open ? "Hide details" : "Review"}
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>

      {open && (
        <div
          data-testid="resume-review-body"
          style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div style={{ color: "var(--text-muted)" }}>
            This run was interrupted before it finished. Resuming continues from
            where it left off — the work below is treated as already-done history
            and is <strong>not</strong> repeated. The model is asked to re-check
            any file it touched before editing again, in case it changed since.
          </div>
          {toolNames.length > 0 && (
            <div>
              <span style={{ color: "var(--text-muted)" }}>Tools used: </span>
              {toolNames.map((n) => (
                <code
                  key={n}
                  style={{
                    marginRight: 6,
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: "var(--surface-3, rgba(255,255,255,0.06))",
                  }}
                >
                  {n}
                </code>
              ))}
            </div>
          )}
          <ol
            data-testid="resume-turn-list"
            style={{
              listStyle: "decimal",
              margin: "2px 0 0 18px",
              padding: 0,
              maxHeight: 180,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {ckpt.turns.map((t) => (
              <li key={t.turn_index} style={{ color: "var(--text)" }}>
                <span style={{ color: "var(--text-muted)" }}>
                  {t.role === "tool"
                    ? `tool result${t.tool_name ? ` (${t.tool_name})` : ""}`
                    : "assistant"}
                  :{" "}
                </span>
                {summarizeResumeTurn(t.content)}
              </li>
            ))}
          </ol>
        </div>
      )}

      {!localBackend && (
        <div
          data-testid="resume-cloud-note"
          style={{ marginTop: 8, color: "var(--warning-fg, #e0af68)" }}
        >
          Resume is available on local backends only (Ollama or MLX). Cloud
          routes bill per turn, so resuming one could silently re-bill — switch
          to a local model to resume this run.
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button
          type="button"
          data-testid="resume-confirm"
          onClick={onResume}
          disabled={busy || !canResume}
          title={
            canResume
              ? "Continue this run from its checkpoint"
              : localBackend
                ? "Turn on Agent mode to resume"
                : "Switch to a local backend to resume"
          }
          style={{
            font: "inherit",
            cursor: busy || !canResume ? "not-allowed" : "pointer",
            opacity: busy || !canResume ? 0.5 : 1,
            padding: "5px 12px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent, #7aa2f7)",
            color: "var(--accent-fg, #0b0f1a)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <Play size={14} /> Resume run
        </button>
        <button
          type="button"
          data-testid="resume-dismiss"
          onClick={onDismiss}
          disabled={busy}
          title="Discard this checkpoint — it won't be offered again"
          style={{
            font: "inherit",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.5 : 1,
            padding: "5px 12px",
            borderRadius: 6,
            border: "1px solid var(--border, #333)",
            background: "none",
            color: "var(--text)",
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
});

/**
 * RESUME: one-line preview of a checkpoint turn's content for the review panel.
 * An assistant-with-tool-calls turn is stored as a JSON `{ content, tool_calls }`
 * envelope — decode it to show the prelude + the called tool names. Everything
 * else is shown as trimmed single-line text. Defensive against malformed JSON.
 */
function summarizeResumeTurn(content: string): string {
  const collapse = (s: string) =>
    s.replace(/\s+/g, " ").trim().slice(0, 140) || "(no text)";
  if (content.startsWith("{")) {
    try {
      const env = JSON.parse(content) as {
        content?: unknown;
        tool_calls?: Array<{ function?: { name?: string } }>;
      };
      if (Array.isArray(env.tool_calls) && env.tool_calls.length > 0) {
        const names = env.tool_calls
          .map((c) => c.function?.name)
          .filter((n): n is string => typeof n === "string")
          .join(", ");
        const prelude =
          typeof env.content === "string" && env.content.trim()
            ? `${collapse(env.content)} → `
            : "";
        return `${prelude}called ${names || "tool"}`;
      }
    } catch {
      // Fall through to plain text.
    }
  }
  return collapse(content);
}

export function ChatWindow({
  status,
  conversation,
  onConversationCreated,
  onMemoriesChanged,
  onForked,
  ensureModel,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  // Streaming text isolation (perf 2026-06-12). The per-token reply text used
  // to live in ChatWindow state, so every rAF flush (~60×/sec) re-rendered the
  // WHOLE window — toolbar, composer, context meter, rollover banner — even
  // though only the streaming bubble changes. Now the per-frame TEXT lives in
  // a memoized <StreamingMessageList> child that registers its setter here;
  // ChatWindow only holds an `isStreaming` BOOLEAN (flips twice per reply, not
  // per frame), so the heavy siblings re-render on start/stop, never per token.
  const streamTextRef = useRef<((v: string | undefined) => void) | null>(null);
  const registerStreamSetter = useCallback(
    (fn: ((v: string | undefined) => void) | null) => {
      streamTextRef.current = fn;
    },
    [],
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const setStreaming = useCallback((v: string | undefined) => {
    streamTextRef.current?.(v);
    // setIsStreaming(true) every frame is a no-op after the first (React bails
    // on an unchanged primitive), so this does NOT re-render ChatWindow per
    // token — only on the start→stop transition.
    setIsStreaming(v !== undefined);
  }, []);
  const [err, setErr] = useState<string | null>(null);
  const [recalled, setRecalled] = useState<Memory[]>([]);
  // Item 1: expand the recall pill to inspect + correct the memories pulled for
  // this turn. `recallBusy` disables a row's buttons while its mutation runs.
  const [recallOpen, setRecallOpen] = useState(false);
  const [recallBusy, setRecallBusy] = useState<number | null>(null);
  // Item 2: auto-retrieve indexed RAG corpora in plain chat. Persisted per
  // machine in localStorage (read once on mount).
  const [ragContext, setRagContext] = useState<boolean>(() =>
    getRagContextEnabled(),
  );
  // Item 3: mid-run steering composer. `steerText` is the draft; `steerSent`
  // briefly confirms a queued message so the user sees it landed.
  const [steerText, setSteerText] = useState("");
  const [steerSent, setSteerSent] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  // Side-by-side compare mode (W5B-COMPARE). Exploratory: a separate surface
  // that runs ONE prompt across 2–3 models concurrently and shows each reply in
  // its own column. Default OFF (today's behavior). Nothing it streams is
  // persisted, so the normal single-model history is never touched.
  const [compareMode, setCompareMode] = useState(false);
  // Multi-model auto-routing (plain chat). Persisted across sessions.
  const [autoRoute, setAutoRoute] = useState<boolean>(
    () => localStorage.getItem("chat.autoRoute") === "1",
  );
  const [routedNotice, setRoutedNotice] = useState<RouteDecision | null>(null);
  const [showRoutes, setShowRoutes] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [workspaceErr, setWorkspaceErr] = useState<string | null>(null);
  const [agentMetrics, setAgentMetrics] = useState<AgentMetrics | null>(null);
  const [rememberPrefix, setRememberPrefix] = useState(false);
  const [destructiveAck, setDestructiveAck] = useState(false);
  // Item 5: "Allow all remaining actions for this task" — per-run trust ticked
  // at a confirmation modal. Reset at each new confirmation request; the runner
  // keeps the armed state for the rest of the run once it's sent.
  const [trustRun, setTrustRun] = useState(false);
  const [showToolHistory, setShowToolHistory] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [projectPolicy, setProjectPolicy] = useState<ProjectPolicy | null>(
    null,
  );
  // Per-conversation model parameters (temperature / top-p / max tokens /
  // system prompt). Decoded from `conversation.params`; all-null = defaults.
  const [convParams, setConvParams] = useState<ConversationParams>(emptyParams);
  const [showParamsPanel, setShowParamsPanel] = useState(false);
  // RESUME: an unfinished agent run detected on this conversation's durable
  // checkpoint, surfaced as a "Resume run" affordance. `null` = nothing to
  // resume. `resumeReviewOpen` expands the review-before-continue panel; the
  // user MUST click Resume — we NEVER auto-resume (a buggy resume on a cloud
  // route could re-bill turns). `resumeBusy` guards the buttons while the
  // resume/dismiss IPC settles.
  const [pendingResume, setPendingResume] = useState<RunCheckpoint | null>(null);
  const [resumeReviewOpen, setResumeReviewOpen] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);

  const agent = useAgentSettings();
  const askUser = useAskUserModal(setErr);
  const { quickToast, dismissToast } = useQuickPromptToast();

  const onCitationOpened = useCallback((label: string) => {
    setUpdateMsg(`Opened in ${label}`);
    setTimeout(
      () => setUpdateMsg((m) => (m && m.startsWith("Opened") ? null : m)),
      2200,
    );
  }, []);
  const citation = useCitationOpener(workspaceRoot, setErr, onCitationOpened);

  const creatingConvRef = useRef<Promise<Conversation> | null>(null);
  const convRef = useRef<Conversation | null>(null);
  const confirmResolveRef = useRef<((v: ConfirmDecision) => void) | null>(null);

  useEffect(() => {
    api
      .agentGetWorkspace()
      .then(setWorkspaceRoot)
      .catch((err) =>
        logDiag({
          level: "warn",
          source: "chat-window",
          message: "agentGetWorkspace failed on mount",
          detail: err,
        }),
      );
  }, []);

  // Refresh the active project policy whenever the workspace changes.
  // Missing / malformed `.froglips/policy.json` → null (silent).
  useEffect(() => {
    if (!workspaceRoot) {
      setProjectPolicy(null);
      return;
    }
    let cancelled = false;
    api
      .policyLoad(workspaceRoot)
      .then((p) => {
        if (!cancelled) setProjectPolicy(p ?? null);
      })
      .catch((err) => {
        if (!cancelled) setProjectPolicy(null);
        // A malformed .froglips/policy.json or unreadable file used to vanish
        // silently — log it so the user can debug why their policy isn't
        // taking effect. Missing-file is a normal case (no policy in the
        // project) and the Rust side returns null rather than rejecting,
        // so anything that reaches here is a real read/parse failure.
        logDiag({
          level: "warn",
          source: "chat-window",
          message: `policyLoad failed for ${workspaceRoot} — falling back to no project policy`,
          detail: err,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    convRef.current = conversation;
    // Guard the async listMessages resolution so an A→B→A rapid switch can't
    // paint stale messages from an older fetch over the current view. The
    // closure-captured `ignore` is flipped to true by the cleanup; any
    // resolution after that is dropped.
    let ignore = false;
    if (conversation) {
      api
        .listMessages(conversation.id)
        .then((msgs) => {
          if (!ignore) setMessages(msgs);
        })
        .catch((e) => {
          if (!ignore) setErr(String(e));
        });
      // RESUME: probe the durable checkpoint for an UNFINISHED run on this
      // conversation. A hit surfaces a "Resume run" affordance (collapsed by
      // default — review-before-continue). This is a pure read with no resume
      // side effect; we NEVER auto-resume. Best-effort: a probe failure just
      // leaves the affordance hidden.
      api
        .agentRunLatestCheckpoint(conversation.id)
        .then((ckpt) => {
          if (!ignore) setPendingResume(ckpt ?? null);
        })
        .catch((e) => {
          if (!ignore) {
            setPendingResume(null);
            logDiag({
              level: "warn",
              source: "chat-window",
              message:
                "agentRunLatestCheckpoint probe failed — resume affordance hidden",
              detail: e,
            });
          }
        });
    } else {
      setMessages([]);
      setPendingResume(null);
    }
    setResumeReviewOpen(false);
    setRecalled([]);
    setRecallOpen(false); // collapse the recall pill on conversation switch
    setRoutedNotice(null); // clear the previous chat's route chip on switch
    setConvParams(parseConversationParams(conversation?.params));
    setShowParamsPanel(false);
    return () => {
      ignore = true;
    };
  }, [conversation?.id]);

  const ensureConversation = useEvent(async (): Promise<Conversation> => {
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
    try {
      return await promise;
    } finally {
      creatingConvRef.current = null;
    }
  });

  /* ── Confirmation gate for dangerous agent tools ── */

  const requestConfirmation = useEvent(
    (
      toolName: string,
      args: Record<string, unknown>,
      risk: string,
    ): Promise<ConfirmDecision> => {
      setRememberPrefix(false);
      setDestructiveAck(false);
      setTrustRun(false);
      return new Promise((resolve) => {
        confirmResolveRef.current = resolve;
        setConfirmState({ toolName, args, risk });
      });
    },
  );

  async function chooseWorkspace() {
    setWorkspaceErr(null);
    // Use Tauri's native directory picker — window.prompt is blocked in the
    // Tauri 2 webview anyway, and even when it worked it gave the user zero
    // help validating a real on-disk path. The dialog plugin is loaded lazily
    // so the initial bundle stays slim.
    let picked: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const res = await open({
        directory: true,
        multiple: false,
        defaultPath: workspaceRoot ?? undefined,
        title: "Choose workspace root",
      });
      picked = Array.isArray(res) ? (res[0] ?? null) : res;
    } catch (e) {
      // Distinguish "plugin not loaded" (legitimate dev fallback) from a real
      // platform/permission error. The dialog plugin reports missing IPC
      // commands with messages like "plugin not registered", "command not
      // found", or "not allowed by the scope". Only those silently fall
      // through to the prompt; anything else (e.g. a permission denial we
      // need to debug) surfaces via setErr and the diagnostics ring buffer.
      const msg = e instanceof Error ? e.message : String(e);
      const isPluginMissing =
        /plugin\s*(not\s*registered|missing)/i.test(msg) ||
        /command\s*(not\s*found|missing)/i.test(msg) ||
        /not\s*allowed\s*by\s*the\s*scope/i.test(msg);
      if (!isPluginMissing) {
        logDiag({
          level: "warn",
          source: "chat-window",
          message:
            "workspace dialog open() failed — falling back to typed entry",
          detail: e,
        });
        setWorkspaceErr(`Workspace picker unavailable: ${msg}`);
      }
      // Audit L-F1 (2026-05-28): the old fallback called `window.prompt`,
      // which Tauri 2 WKWebView blocks → the user got nothing. Removed
      // the dead branch; the picker-unavailable error above is now the
      // terminal state. If the user needs to set the workspace and the
      // dialog plugin is broken, the workaround is to invoke
      // `agent_set_workspace` directly via DiagnosticsPanel.
      return;
    }
    try {
      const set = await api.agentSetWorkspace(picked);
      setWorkspaceRoot(set);
    } catch (e) {
      setWorkspaceErr(String(e));
    }
  }

  async function checkUpdates() {
    setUpdateMsg("Checking…");
    try {
      const upd = await checkForUpdate();
      if (!upd) {
        setUpdateMsg("Up to date.");
        return;
      }
      setUpdateMsg(`Update available: v${upd.version}. Downloading…`);
      await upd.downloadAndInstall();
      setUpdateMsg("Installed. Relaunching…");
      await relaunch();
    } catch (e) {
      setUpdateMsg(`Update failed: ${e}`);
    }
  }

  function handleConfirm(approved: boolean) {
    // Destructive actions must clear the explicit ack checkbox — defends
    // against single-click approval fatigue and prompt-injection chains
    // that flash a dangerous-looking command past the user.
    if (approved && confirmState?.risk === "destructive" && !destructiveAck) {
      return;
    }
    const remember = approved && rememberPrefix;
    // Item 5: only arm per-run trust on an APPROVE. A destructive call never
    // arms it (the trust checkbox is hidden for non-normal risk below), so this
    // can only carry through for a normal-risk approval.
    const trust = approved && trustRun;
    setConfirmState(null);
    setRememberPrefix(false);
    setDestructiveAck(false);
    setTrustRun(false);
    confirmResolveRef.current?.({
      approve: approved,
      remember,
      trustRun: trust,
    });
    confirmResolveRef.current = null;
  }

  // Settle a pending tool-confirmation as a deny-aborted when the run is
  // stopped. Without this the agent loop stays parked on `await
  // requestConfirmation` forever (modal lingers over a dead loop) and, on a
  // late "Allow", would execute the very tool the user tried to cancel. The
  // runner also re-checks abort after the gate, so this is the un-park half.
  // Round 6 HIGH (2026-05-30).
  const abortWithConfirm = useEvent(() => {
    if (confirmResolveRef.current) {
      confirmResolveRef.current({ approve: false, reason: "aborted" });
      confirmResolveRef.current = null;
    }
    setConfirmState(null);
    setRememberPrefix(false);
    setDestructiveAck(false);
    setTrustRun(false);
    abort();
  });

  const isWorking =
    isStreaming || agentStatus === "thinking" || agentStatus === "tool";
  // For an active OpenRouter model, agent mode is gated on whether the catalogue
  // says the model supports tools. The catalogue is fetched lazily (below) and
  // cached per model id; until it resolves, agent mode is held off.
  const [orToolsByModel, setOrToolsByModel] = useState<Record<string, boolean>>(
    {},
  );
  useEffect(() => {
    if (status?.backend !== "openrouter") return;
    const model = status.model;
    if (!model || model in orToolsByModel) return;
    let cancelled = false;
    void api
      .openrouterListModels()
      .then((models) => {
        if (cancelled) return;
        const hit = models.find((m) => m.id === model);
        // Unknown model → assume tool-capable (the user opted into OpenRouter
        // agent mode); a model the catalogue marks tool-less stays disabled.
        setOrToolsByModel((prev) => ({
          ...prev,
          [model]: hit ? hit.tools : true,
        }));
      })
      .catch(() => {
        // Catalogue fetch failed (offline / no key) — don't block agent mode on
        // a transient lookup error; let the user try (degrades gracefully).
        if (!cancelled) setOrToolsByModel((prev) => ({ ...prev, [model]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [status?.backend, status?.model, orToolsByModel]);

  // Agent mode (tool-calling loop) runs on Ollama, MLX, and the
  // OpenAI-compatible cloud backends (custom / OpenRouter). The native
  // (mistralrs) backend has no tool-call support — agent mode is disabled
  // there. For a user `custom` backend the user opted in, so it's allowed (it
  // degrades to a text pass if the model ignores tools); for `openrouter` it's
  // gated on the catalogue tools flag once that resolves.
  const agentAvailable =
    status?.backend === "ollama" ||
    status?.backend === "mlx" ||
    status?.backend === "custom" ||
    (status?.backend === "openrouter" &&
      !!status.model &&
      orToolsByModel[status.model] === true);

  /* ── Send pipeline ── */
  // Self-healing send: when nothing is running, the first send warms the
  // selected model (via ModelPicker's exposed start) and then dispatches.
  // The composer is never disabled behind the Start ceremony.
  const [warming, setWarming] = useState(false);
  const { send, resend, resumeRun, abort, injectSteering } = useChatSend({
    status,
    agentMode,
    agentAvailable,
    workspaceRoot,
    projectPolicy,
    convParams,
    agent,
    messages,
    ensureConversation,
    convRef,
    requestConfirmation,
    setMessages,
    setStreaming,
    setErr,
    setRecalled,
    setAgentStatus,
    setAgentMetrics,
    onMemoriesChanged,
    routingEnabled: autoRoute,
    onRouted: setRoutedNotice,
  });

  // Persist the auto-route toggle; clear the live notice when turned off.
  const toggleAutoRoute = useCallback(() => {
    setAutoRoute((on) => {
      const next = !on;
      localStorage.setItem("chat.autoRoute", next ? "1" : "0");
      if (!next) setRoutedNotice(null);
      return next;
    });
  }, []);

  // Item 2: persist the plain-chat RAG auto-retrieve toggle.
  const toggleRagContext = useCallback(() => {
    setRagContext((on) => {
      const next = !on;
      setRagContextEnabled(next);
      return next;
    });
  }, []);

  // Item 1: drop a recalled memory from THIS turn's pill — either by demoting
  // its scope one step (conversation ← project ← global) or deleting it
  // outright. Both update the live pill list optimistically and notify the host
  // so the Memories panel count refreshes.
  const recallDemote = useCallback(
    async (m: Memory) => {
      setRecallBusy(m.id);
      try {
        await demoteMemory(m.id);
        // Demote can move a memory out of this conversation's recall scope;
        // drop it from the pill either way so the user sees the correction land.
        setRecalled((prev) => prev.filter((r) => r.id !== m.id));
        onMemoriesChanged?.();
      } catch (e) {
        setErr(`Demote failed: ${e}`);
      } finally {
        setRecallBusy(null);
      }
    },
    [onMemoriesChanged],
  );
  const recallDelete = useCallback(
    async (m: Memory) => {
      setRecallBusy(m.id);
      try {
        await api.deleteMemory(m.id);
        setRecalled((prev) => prev.filter((r) => r.id !== m.id));
        onMemoriesChanged?.();
      } catch (e) {
        setErr(`Delete failed: ${e}`);
      } finally {
        setRecallBusy(null);
      }
    },
    [onMemoriesChanged],
  );

  // Item 3: queue the steering draft into the in-flight agent run. Clears the
  // draft + flashes a confirmation on success. injectSteering returns false if
  // no run is active (race: the run finished between render and click) — leave
  // the text so the user can fall back to a normal send.
  const submitSteering = useCallback(() => {
    const t = steerText.trim();
    if (!t) return;
    if (injectSteering(t)) {
      setSteerText("");
      setSteerSent(true);
      window.setTimeout(() => setSteerSent(false), 2500);
    }
  }, [steerText, injectSteering]);

  // RESUME: a run can only be safely resumed on a LOCAL backend. A cloud route
  // (`:cloud` ollama tags, custom, OpenRouter) bills per turn, and a buggy /
  // mis-rehydrated resume could silently re-bill — so we gate resume to
  // local-only (ollama non-:cloud, mlx) and tell the user precisely why a cloud
  // route can't resume rather than risk it.
  const isLocalBackend =
    (status?.backend === "ollama" && !status.model?.endsWith(":cloud")) ||
    status?.backend === "mlx";

  // RESUME: continue the interrupted run after the user reviewed it and clicked
  // Resume. Picks the original user prompt from the visible history (recall
  // context only — the run continues from the checkpoint, not a new turn), hands
  // the checkpoint's run_id + rehydrated turns to the send pipeline, and clears
  // the affordance. NEVER called automatically.
  const handleResume = useCallback(async () => {
    if (!pendingResume || resumeBusy) return;
    if (!isLocalBackend) {
      setErr(
        "Resume is available on local backends only (Ollama or MLX). " +
          "Cloud routes bill per turn, so resuming one could silently re-bill — " +
          "switch to a local model to resume this run.",
      );
      return;
    }
    if (!(agentMode && agentAvailable)) {
      setErr("Turn on Agent mode to resume this run.");
      return;
    }
    setResumeBusy(true);
    const ckpt = pendingResume;
    // The original prompt: the last visible user turn that started the run.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";
    // Clear the affordance up front so a second click can't double-fire; the
    // run's own completion will close the checkpoint set.
    setPendingResume(null);
    setResumeReviewOpen(false);
    try {
      await resumeRun({
        prompt,
        priorHistory: messages,
        runId: ckpt.run_id,
        turns: ckpt.turns,
      });
    } catch (e) {
      setErr(`Failed to resume run: ${e}`);
    } finally {
      setResumeBusy(false);
    }
  }, [
    pendingResume,
    resumeBusy,
    isLocalBackend,
    agentMode,
    agentAvailable,
    messages,
    resumeRun,
  ]);

  // RESUME: dismiss the affordance WITHOUT resuming. Closes the checkpoint set
  // so it is never re-offered, then hides the affordance. Best-effort: even if
  // the close IPC fails we still hide it this session.
  const handleDismissResume = useCallback(async () => {
    if (!pendingResume || resumeBusy) return;
    setResumeBusy(true);
    const conv = convRef.current;
    const ckpt = pendingResume;
    setPendingResume(null);
    setResumeReviewOpen(false);
    try {
      if (conv) await api.agentRunClose(ckpt.run_id, conv.id);
    } catch (e) {
      logDiag({
        level: "warn",
        source: "chat-window",
        message: "agentRunClose on dismiss failed — run may be re-offered",
        detail: e,
      });
    } finally {
      setResumeBusy(false);
    }
  }, [pendingResume, resumeBusy]);

  /**
   * Persist per-conversation params. Optimistically updates local state so
   * the panel + context meter react immediately; a failed write surfaces in
   * the error bar but leaves the optimistic value in place (the user can
   * retry by editing again).
   */
  const saveConvParams = useCallback(async (next: ConversationParams) => {
    setConvParams(next);
    const conv = convRef.current;
    if (!conv) return; // no conversation yet — keep the draft in state only.
    try {
      await api.updateConversationParams(
        conv.id,
        serializeConversationParams(next),
      );
    } catch (e) {
      setErr(`Failed to save conversation parameters: ${e}`);
    }
  }, []);

  // When the backend changes to one that can't do agent mode, drop the
  // agent toggle so send() never silently falls through to plain streaming.
  useEffect(() => {
    if (!agentAvailable && agentMode) setAgentMode(false);
  }, [agentAvailable, agentMode]);

  // First-run handoff from the setup wizard (product review 2026-06-10,
  // onboarding #1). The wizard's sample prompts are agent-TOOL prompts —
  // running them in plain chat made the model hallucinate a directory
  // listing as the user's first-ever response. The wizard auto-starts the
  // downloaded model and App fires this event; we ARM agent mode here and
  // flip it on once the backend reports agent-capable (the server may still
  // be loading when the event lands — flipping immediately would be undone
  // by the agentAvailable guard above). Then prompt for a workspace so
  // "what's in my current directory?" resolves to a real folder.
  const [firstRunArmed, setFirstRunArmed] = useState(false);
  useEffect(() => {
    const arm = () => setFirstRunArmed(true);
    window.addEventListener("chat-window:agent-first-run", arm);
    return () => window.removeEventListener("chat-window:agent-first-run", arm);
  }, []);
  useEffect(() => {
    if (!firstRunArmed || !agentAvailable) return;
    setFirstRunArmed(false);
    setAgentMode(true);
    if (!workspaceRoot) void chooseWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRunArmed, agentAvailable, workspaceRoot]);

  // 2026-05-25 user-reported "Stop model didn't unstick the spinner". When
  // `status.running` flips false while a send is in flight, abort the
  // outbound controller so the UI returns to idle. Without this the
  // streaming fetch sits waiting for bytes from a server that's now dead
  // and the spinner stays on "thinking" until the fetch eventually
  // errors out (which can take a long time on a graceful TCP close).
  const wasRunningRef = useRef<boolean>(false);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    const nowRunning = !!status?.running;
    wasRunningRef.current = nowRunning;
    if (wasRunning && !nowRunning && isWorking) {
      abortWithConfirm();
      setStreaming(undefined);
      setAgentStatus("idle");
    }
  }, [status?.running, isWorking, abortWithConfirm]);

  // Per-message action handlers (regenerate / edit-and-retry / fork-at-message)
  // plus the edit-modal draft state. Extracted into a hook; identical behavior
  // (each handler stays `useEvent`-stable for MessageRow's React.memo).
  const {
    editState,
    setEditState,
    onRegenerate,
    onEditUser,
    submitEdit,
    onForkMsg,
    retryLast,
  } = useMessageActions({
    messages,
    conversation,
    isWorking,
    resend,
    setMessages,
    setErr,
    onForked,
  });

  // Show the landing whenever there's nothing to display — INCLUDING the cold
  // start where no conversation is selected (a stranger's first launch).
  // `send()` auto-creates a conversation via `ensureConversation()`, so the
  // null case sends fine; previously requiring a non-null conversation left
  // the whole pane blank on first run.
  const showLanding = messages.length === 0 && !isWorking;

  // Item 4: surface the backend auto-restart as transient inline state instead
  // of only the one-shot error bar. The restart-watcher emits a `server-status`
  // with `last_error` of "model server crashed — restarting (attempt N/M)"
  // (see backend_process.rs emit_restarting) while it backs off and relaunches;
  // detect that exact shape so a generic "model crashed, giving up" terminal
  // error still goes through the normal error bar.
  const restartingNotice = (() => {
    const le = status?.last_error;
    if (!le) return null;
    return /restarting \(attempt/i.test(le) ? le : null;
  })();

  return (
    <div className="chat-window" onClick={citation.onCitationClick}>
      {agentMode && agent.dryRun && (
        <div
          className="dry-run-banner"
          data-testid="agent-dry-run-banner"
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <ShieldCheck size={14} /> Dry-run: tool side-effects suppressed
        </div>
      )}
      {/* RESUME: an interrupted run was found on this conversation's durable
          checkpoint. Surface a review-before-continue affordance — collapsed by
          default. The user MUST click Resume; we NEVER auto-resume. Hidden while
          a run is already in flight. */}
      {pendingResume && !isWorking && (
        <ResumeBanner
          ckpt={pendingResume}
          open={resumeReviewOpen}
          busy={resumeBusy}
          canResume={isLocalBackend && agentMode && agentAvailable}
          localBackend={isLocalBackend}
          onToggleReview={() => setResumeReviewOpen((o) => !o)}
          onResume={() => void handleResume()}
          onDismiss={() => void handleDismissResume()}
        />
      )}
      {compareMode ? (
        <Suspense
          fallback={<div className="lazy-loading">Loading compare…</div>}
        >
          <CompareView
            status={status}
            history={messages}
            params={{
              temperature: convParams.temperature,
              top_p: convParams.top_p,
              max_tokens: convParams.max_tokens,
            }}
            onClose={() => setCompareMode(false)}
          />
        </Suspense>
      ) : showLanding ? (
        <EmptyChatLanding modelReady={!!status?.running} />
      ) : (
        <StreamingMessageList
          registerStreamSetter={registerStreamSetter}
          messages={messages}
          conversationId={conversation?.id ?? null}
          workspaceRoot={workspaceRoot}
          currentModel={status?.running ? status.model : null}
          agentStatus={agentStatus}
          onRegenerate={onRegenerate}
          onEditUser={onEditUser}
          onFork={onForkMsg}
        />
      )}
      <div className="chat-input-wrap">
        {recalled.length > 0 && (
          <div className="recall-pill-wrap" data-testid="recall-pill-wrap">
            {/* `.recall-pill` is owned by W4-CHAT2 (chat.css). The button reuses
                it for the pill look; minimal inline resets here keep the new
                expandable affordance usable before W4-CHAT2 adds dedicated CSS
                for .recall-pill-toggle / .recall-list / .recall-item-*. */}
            <button
              type="button"
              className="recall-pill recall-pill-toggle"
              aria-expanded={recallOpen}
              data-testid="recall-pill-toggle"
              onClick={() => setRecallOpen((o) => !o)}
              title="Show the memories recalled for this turn"
              style={{ cursor: "pointer", font: "inherit" }}
            >
              <span className="recall-icon">
                <Zap size={16} />
              </span>
              Recalled {recalled.length} memor
              {recalled.length === 1 ? "y" : "ies"} for this turn
              {recallOpen ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
            </button>
            {recallOpen && (
              <ul
                className="recall-list"
                data-testid="recall-list"
                style={{
                  listStyle: "none",
                  margin: "4px 0 6px",
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {recalled.map((m) => (
                  <li
                    key={m.id}
                    className="recall-list-item"
                    data-testid={`recall-item-${m.id}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      color: "var(--text-muted)",
                    }}
                  >
                    <span
                      className="recall-item-text"
                      style={{ flex: 1, wordBreak: "break-word" }}
                    >
                      {m.content}
                    </span>
                    <span
                      className="recall-item-actions"
                      style={{ display: "inline-flex", gap: 4 }}
                    >
                      <button
                        type="button"
                        className="recall-item-btn"
                        disabled={recallBusy === m.id}
                        title="Demote this memory one scope (it likely shouldn't have surfaced here)"
                        aria-label="Demote recalled memory"
                        data-testid={`recall-demote-${m.id}`}
                        onClick={() => void recallDemote(m)}
                        style={{
                          cursor: recallBusy === m.id ? "default" : "pointer",
                          background: "var(--surface)",
                          color: "var(--text)",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          padding: "2px 4px",
                          display: "inline-flex",
                        }}
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        type="button"
                        className="recall-item-btn recall-item-delete"
                        disabled={recallBusy === m.id}
                        title="Delete this memory"
                        aria-label="Delete recalled memory"
                        data-testid={`recall-delete-${m.id}`}
                        onClick={() => void recallDelete(m)}
                        style={{
                          cursor: recallBusy === m.id ? "default" : "pointer",
                          background: "var(--surface)",
                          color: "var(--danger-fg, #fca5a5)",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          padding: "2px 4px",
                          display: "inline-flex",
                        }}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <ErrorBar
          message={err}
          onDismiss={() => setErr(null)}
          // Item 3: a send/stream failure surfaces a one-click Retry that
          // re-runs the last user turn. Gated on the error copy useChatSend
          // sets for recoverable send failures ("…send again to retry"), so
          // non-retryable errors (Start a model first / failed to save) don't
          // grow a misleading button. Disabled while a run is in flight.
          onRetry={
            err && /retry/i.test(err) && !isWorking
              ? () => {
                  setErr(null);
                  void retryLast();
                }
              : undefined
          }
          retryLabel="Retry"
        />

        <div className="chat-routing-bar">
          <button
            type="button"
            className={`route-toggle${autoRoute ? " on" : ""}`}
            onClick={toggleAutoRoute}
            disabled={agentMode}
            title={
              agentMode
                ? "Auto-route applies to plain chat (turn off Agent mode)"
                : "Auto-route each message to the best-fit configured model"
            }
          >
            <Shuffle size={14} /> Auto-route {autoRoute ? "on" : "off"}
          </button>
          {autoRoute && (
            <button
              type="button"
              className="route-manage"
              onClick={() => setShowRoutes(true)}
            >
              Manage routes
            </button>
          )}
          {autoRoute && routedNotice && (
            <span
              className="route-chip"
              title={routedNotice.reason ?? routedNotice.method}
            >
              → {routedNotice.label} · <code>{routedNotice.model}</code>
              <span className="route-method"> · {routedNotice.method}</span>
            </span>
          )}
          {/* Item 2: auto-retrieve indexed RAG corpora for plain chat. Disabled
              in agent mode (the model already has the search_project_knowledge
              tool there). */}
          <button
            type="button"
            className={`route-toggle${ragContext ? " on" : ""}`}
            onClick={toggleRagContext}
            disabled={agentMode}
            data-testid="rag-context-toggle"
            title={
              agentMode
                ? "Doc retrieval applies to plain chat (agent mode uses the search tool instead)"
                : "Auto-retrieve relevant chunks from your indexed documents and add them as context"
            }
          >
            <BookOpen size={14} /> Use docs {ragContext ? "on" : "off"}
          </button>
          {/* W5B-COMPARE: enter/exit side-by-side multi-model compare. A
              separate exploratory surface; nothing it streams is saved. */}
          <button
            type="button"
            className={`route-toggle${compareMode ? " on" : ""}`}
            onClick={() => setCompareMode((v) => !v)}
            data-testid="compare-toggle"
            title="Run one prompt across 2–3 models side by side (exploratory — not saved to chat)"
          >
            <Columns size={14} /> Compare {compareMode ? "on" : "off"}
          </button>
        </div>

        {showRoutes && (
          <RoutesSettings
            status={status}
            onClose={() => setShowRoutes(false)}
          />
        )}

        {/* The agent toolbar steers the SINGLE-model chat — hide it while the
            exploratory compare surface is open (it has its own controls). */}
        {!compareMode && (
          <AgentToolbar
            conversation={conversation}
            messages={messages}
            agent={agent}
            agentMode={agentMode}
            agentAvailable={agentAvailable}
            agentStatus={agentStatus}
            agentMetrics={agentMetrics}
            activeModel={status?.model ?? null}
            isWorking={isWorking}
            workspaceRoot={workspaceRoot}
            projectPolicy={projectPolicy}
            convParams={convParams}
            showParamsPanel={showParamsPanel}
            showAgentSettings={showAgentSettings}
            showExportMenu={showExportMenu}
            onToggleAgent={() => setAgentMode((v) => !v)}
            onToggleParams={() => setShowParamsPanel((v) => !v)}
            onToggleAgentSettings={() => setShowAgentSettings((v) => !v)}
            onToggleToolHistory={() => setShowToolHistory((v) => !v)}
            onToggleExportMenu={() => setShowExportMenu((v) => !v)}
            onCloseExportMenu={() => setShowExportMenu(false)}
          />
        )}

        {showParamsPanel && (
          <ParamsPanel
            params={convParams}
            onSave={saveConvParams}
            onClose={() => setShowParamsPanel(false)}
            disabled={isWorking}
          />
        )}

        {agentMode && showAgentSettings && (
          <AgentSettingsPanel
            agent={agent}
            workspaceRoot={workspaceRoot}
            workspaceErr={workspaceErr}
            onDismissWorkspaceErr={() => setWorkspaceErr(null)}
            updateMsg={updateMsg}
            onChooseWorkspace={chooseWorkspace}
            onCheckUpdates={checkUpdates}
          />
        )}

        <ContextRolloverBanner
          messages={messages}
          status={status}
          conversation={conversation}
          onContinued={(newId) => onForked?.(newId)}
        />

        {/* Item 4: backend auto-restart inline progress. The watcher cycles the
            backend behind the scenes; show a transient "restarting" chip with a
            spinner so the user understands the pause instead of seeing only a
            one-shot error and a frozen composer. */}
        {restartingNotice && (
          <div
            className="backend-restart-notice"
            data-testid="backend-restart-notice"
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--text-muted)",
              padding: "6px 8px",
              marginBottom: 6,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            <span
              className="backend-restart-spinner"
              aria-hidden="true"
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border: "2px solid var(--border)",
                borderTopColor: "var(--accent)",
                display: "inline-block",
                // `spin` is the app-global 360° keyframe (styles/panels.css).
                animation: "spin 0.8s linear infinite",
              }}
            />
            <span>Restarting model… {restartingNotice}</span>
          </div>
        )}

        {/* Item 3: mid-run steering. While an agent run is in flight, let the
            user inject extra guidance that the runner appends at the next turn
            boundary — without aborting. Shown only during an agent run; plain
            streaming has no turn boundary to inject at. */}
        {agentMode && agentAvailable && isWorking && (
          <div
            className="steering-row"
            data-testid="steering-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 6,
            }}
          >
            <input
              type="text"
              className="steering-input"
              data-testid="steering-input"
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitSteering();
                }
              }}
              placeholder="Steer the running agent (added at the next step, no interrupt)…"
              style={{
                flex: 1,
                boxSizing: "border-box",
                background: "var(--surface)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 12,
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              className="steering-send"
              data-testid="steering-send"
              onClick={submitSteering}
              disabled={!steerText.trim()}
              title="Queue this guidance for the next agent step"
              style={{
                fontSize: 12,
                padding: "5px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                cursor: steerText.trim() ? "pointer" : "default",
              }}
            >
              Steer
            </button>
            {steerSent && (
              <span
                data-testid="steering-confirm"
                style={{ fontSize: 11, color: "var(--accent)" }}
              >
                Queued ✓
              </span>
            )}
          </div>
        )}

        {!compareMode && (
        <div className="composer-row">
          <ChatInput
            // Without an ensureModel handle (detached windows) keep the old
            // disabled-until-running behavior.
            disabled={warming || (!status?.running && !ensureModel)}
            onSend={(text, images) => {
              if (status?.running || !ensureModel) {
                send(text, images);
                return;
              }
              // Warm the selected model, then dispatch. On failure the
              // ModelPicker surfaces its own error; the message is not lost
              // because ChatInput restores it when we report false.
              setWarming(true);
              return ensureModel()
                .then((ok) => {
                  if (ok) send(text, images);
                  return ok;
                })
                .catch(() => false)
                .finally(() => setWarming(false));
            }}
            warming={warming}
            onAbort={abortWithConfirm}
            streaming={isWorking}
            currentModel={status?.running ? status.model : null}
            status={status}
          />
          <ContextMeter
            messages={messages}
            model={status?.running ? status.model : null}
            status={status}
          />
        </div>
        )}
      </div>

      {showToolHistory && (
        <ToolHistory
          messages={messages}
          onClose={() => setShowToolHistory(false)}
        />
      )}

      {askUser.askUserReq && (
        <ConfirmDialog
          ariaLabel="Agent question"
          onDismiss={askUser.cancelAskUser}
          title="Agent asks:"
          actions={
            <>
              <button
                className="agent-confirm-deny"
                onClick={askUser.cancelAskUser}
              >
                Cancel
              </button>
              <button
                className="agent-confirm-allow"
                onClick={askUser.submitAskUser}
                disabled={!askUser.askUserAnswer.trim()}
              >
                Send
              </button>
            </>
          }
        >
          <div style={{ padding: "8px 0", fontSize: 13 }}>
            {askUser.askUserReq.question}
          </div>
          {askUser.askUserReq.hint && (
            <div
              style={{
                padding: "0 0 8px 0",
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              {askUser.askUserReq.hint}
            </div>
          )}
          <textarea
            className="ask-user-input"
            value={askUser.askUserAnswer}
            onChange={(e) => askUser.setAskUserAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                askUser.submitAskUser();
              } else if (e.key === "Escape") {
                e.preventDefault();
                askUser.cancelAskUser();
              }
            }}
            placeholder="Your answer (Cmd+Enter to send, Esc to cancel)…"
            autoFocus
            rows={3}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              fontSize: 13,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
        </ConfirmDialog>
      )}

      {/* Edit-and-retry modal */}
      {editState && (
        <ConfirmDialog
          ariaLabel="Edit message"
          data-testid="edit-message-modal"
          onDismiss={() => setEditState(null)}
          title="Edit message"
          actions={
            <>
              <button
                className="agent-confirm-deny"
                onClick={() => setEditState(null)}
              >
                Cancel
              </button>
              <button
                data-testid="edit-message-submit"
                className="agent-confirm-allow"
                onClick={submitEdit}
                disabled={!editState.text.trim()}
              >
                Resend
              </button>
            </>
          }
        >
          <textarea
            className="ask-user-input"
            value={editState.text}
            onChange={(e) =>
              setEditState((s) => (s ? { ...s, text: e.target.value } : s))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditState(null);
              }
            }}
            placeholder="Edit your message (Cmd+Enter to resend, Esc to cancel)…"
            autoFocus
            rows={4}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 8,
              fontSize: 13,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
        </ConfirmDialog>
      )}

      {/* Citation open confirmation — shows the resolved absolute path so the
          user sees exactly which file an untrusted model is asking to open. */}
      {citation.citationConfirm && (
        <ConfirmDialog
          ariaLabel="Open file in editor"
          data-testid="citation-confirm-modal"
          onDismiss={citation.dismissConfirm}
          title="Open file in editor?"
          actions={
            <>
              <button
                className="agent-confirm-deny"
                onClick={citation.dismissConfirm}
              >
                Cancel
              </button>
              <button
                data-testid="citation-confirm-allow"
                className="agent-confirm-allow"
                onClick={citation.confirmOpen}
              >
                Open
              </button>
            </>
          }
        >
          <div
            style={{
              padding: "8px 0",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            This citation was written by the model. It will open in an external
            editor:
          </div>
          <pre className="agent-confirm-args">
            {citation.citationConfirm.resolved}
            {citation.citationConfirm.line
              ? `:${citation.citationConfirm.line}`
              : ""}
          </pre>
        </ConfirmDialog>
      )}

      {/* Tool confirmation modal */}
      {confirmState && (
        <ConfirmDialog
          ariaLabel={`Confirm tool ${confirmState.toolName}`}
          data-testid="agent-confirm-modal"
          boxClassName={`risk-${confirmState.risk}`}
          onDismiss={() => handleConfirm(false)}
          title={
            <>
              Allow <code>{confirmState.toolName}</code>?
              {confirmState.risk !== "normal" && (
                <span className={`agent-risk-badge risk-${confirmState.risk}`}>
                  {confirmState.risk}
                </span>
              )}
            </>
          }
          actions={
            <>
              <button
                data-testid="agent-confirm-deny"
                className="agent-confirm-deny"
                onClick={() => handleConfirm(false)}
              >
                Deny
              </button>
              <button
                data-testid="agent-confirm-allow"
                className="agent-confirm-allow"
                onClick={() => handleConfirm(true)}
                disabled={
                  confirmState.risk === "destructive" && !destructiveAck
                }
              >
                Allow
              </button>
            </>
          }
        >
          {confirmState.risk === "destructive" && (
            <>
              <div className="agent-risk-warning">
                ⚠ This action matches a known destructive pattern. Read it
                carefully before approving.
              </div>
              <label
                className="agent-confirm-remember"
                style={{ color: "var(--danger-fg, #fca5a5)" }}
              >
                <input
                  type="checkbox"
                  checked={destructiveAck}
                  onChange={(e) => setDestructiveAck(e.target.checked)}
                />
                I have read this and accept the consequences
              </label>
            </>
          )}
          {/* UX re-review H-3: surface a "Long-running" chip when the
              model requested a non-default timeout_secs so the user
              isn't surprised by a 5-min hang from a JSON arg buried in
              the &lt;pre&gt; below. */}
          {confirmState.toolName === "run_shell" &&
            (() => {
              const t = (confirmState.args as Record<string, unknown>)
                .timeout_secs;
              if (typeof t === "number" && t > 60) {
                return (
                  <div
                    className="agent-confirm-chip"
                    data-testid="agent-confirm-long-running"
                  >
                    <Clock size={16} /> Long-running ({t}s budget)
                  </div>
                );
              }
              return null;
            })()}
          {/* UX re-review M10: kill_process modal previously showed raw
              {pid: 12345} with no process name — the user couldn't tell
              if pid 12345 was their editor or Finder. Surface pid +
              signal in plain language. */}
          {confirmState.toolName === "kill_process" &&
            (() => {
              const a = confirmState.args as Record<string, unknown>;
              const pid = typeof a.pid === "number" ? a.pid : "?";
              const signal =
                typeof a.signal === "string" ? a.signal.toUpperCase() : "TERM";
              return (
                <div
                  className="agent-confirm-chip danger"
                  data-testid="agent-confirm-kill"
                >
                  ⚠ Send SIG{signal} to pid {String(pid)} — irreversible
                </div>
              );
            })()}
          {/* UX re-review M10 generalized: every IRREVERSIBLE tool gets a
              loud plain-language chip in addition to the destructive
              risk badge. */}
          {(confirmState.toolName === "delete_path" ||
            confirmState.toolName === "agent_undo") &&
            (() => {
              const a = confirmState.args as Record<string, unknown>;
              if (confirmState.toolName === "delete_path") {
                const recursive = a.recursive === true;
                const path = typeof a.path === "string" ? a.path : "?";
                return (
                  <div
                    className="agent-confirm-chip"
                    style={{
                      background: "var(--danger-bg)",
                      color: "var(--danger-fg)",
                    }}
                    data-testid="agent-confirm-delete"
                  >
                    ⚠ {recursive ? "Recursively delete" : "Delete"}{" "}
                    <code>{path}</code> — cannot be undone unless captured by
                    agent_undo
                  </div>
                );
              }
              // UX re-review L-new-3: the modal doesn't have access to
              // list_undo() here, so we can't tell whether the top entry
              // was an Absent-marker (create → undo deletes) or a Bytes
              // entry (edit → undo restores). Surface both possibilities.
              return (
                <div
                  className="agent-confirm-chip danger"
                  data-testid="agent-confirm-undo"
                >
                  ⚠ Revert the most recent agent file write (may delete a
                  created file) — cannot be redone
                </div>
              );
            })()}
          <ConfirmBody
            toolName={confirmState.toolName}
            args={confirmState.args}
          />
          {confirmState.toolName === "run_shell" &&
            confirmState.risk === "normal" &&
            (() => {
              const cmd = String(confirmState.args.command ?? "");
              const first = cmd.trim().split(/\s+/)[0] ?? "";
              if (!first) return null;
              return (
                <label className="agent-confirm-remember">
                  <input
                    type="checkbox"
                    checked={rememberPrefix}
                    onChange={(e) => setRememberPrefix(e.target.checked)}
                  />
                  Also approve all <code>{first} *</code> commands this session
                </label>
              );
            })()}
          {/* Item 5: per-run "trust this task". Shown only for normal-risk
              calls — destructive / irreversible tools always re-confirm and a
              trust tick must never imply otherwise. Auto-approves this run's
              remaining normal-risk, non-irreversible tool calls. Does NOT
              persist past this run. */}
          {confirmState.risk === "normal" && (
            <label
              className="agent-confirm-remember"
              data-testid="agent-confirm-trust-run"
            >
              <input
                type="checkbox"
                checked={trustRun}
                onChange={(e) => setTrustRun(e.target.checked)}
              />
              Allow all remaining actions for this task (this run only;
              irreversible actions still ask)
            </label>
          )}
        </ConfirmDialog>
      )}

      {quickToast &&
        (() => {
          const activateToast = () => {
            if (quickToast.error) {
              dismissToast();
              return;
            }
            // Activate → dump the reply into the clipboard as a starting point.
            // Strict v1.3: no auto-resubmit, no conversation creation.
            try {
              navigator.clipboard.writeText(quickToast.reply).catch((err) =>
                logDiag({
                  level: "info",
                  source: "chat-window",
                  message: "quick-toast clipboard.writeText rejected",
                  detail: err,
                }),
              );
            } catch (err) {
              logDiag({
                level: "info",
                source: "chat-window",
                message: "quick-toast clipboard write threw synchronously",
                detail: err,
              });
            }
            dismissToast();
          };
          return (
            <div
              className="quick-toast"
              data-testid="quick-prompt-toast"
              role={quickToast.error ? "alert" : "button"}
              aria-label={
                quickToast.error ? undefined : "Copy quick reply to clipboard"
              }
              tabIndex={0}
              onClick={activateToast}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activateToast();
                }
              }}
            >
              {quickToast.error ? (
                <span>Quick prompt failed: {quickToast.error}</span>
              ) : (
                <span>
                  Quick reply ready ↗{" "}
                  <em
                    style={{ color: "var(--text-muted)", fontStyle: "normal" }}
                  >
                    (click to copy)
                  </em>
                </span>
              )}
            </div>
          );
        })()}
    </div>
  );
}
