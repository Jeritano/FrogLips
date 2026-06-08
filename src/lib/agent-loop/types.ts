import type { Message, ProjectPolicy, ServerStatus } from "../../types";

export type AgentStatus = "idle" | "thinking" | "tool" | "done" | "error";

/**
 * Risk classification for a tool call. These are the exact strings the Rust
 * classifiers (`classify_shell_risk`, `classify_applescript_risk`,
 * `classify_http_risk`) and `classifyToolRisk` can produce.
 */
export type Risk = "normal" | "destructive" | "pipe-from-network" | "privileged";

/**
 * Shape of a parsed tool-result body. Tools speak a JSON-over-string
 * protocol: every result is a JSON string that deserialises to either a
 * success or a structured failure. `ToolResultFail` carries the optional
 * `kind`/`dry_run`/`blocked_by_safety` fields the runner sniffs for.
 */
export interface ToolResultOk {
  ok: true;
  dry_run?: boolean;
  [k: string]: unknown;
}
export interface ToolResultFail {
  ok: false;
  kind?: string;
  message?: string;
  dry_run?: boolean;
  blocked_by_safety?: string;
  [k: string]: unknown;
}
export type ToolResult = ToolResultOk | ToolResultFail;

/** Backends the agent loop can run a tool-calling chat against. */
export type AgentBackend = "ollama" | "mlx" | "native";

/** Per-tool execution stats. Maturity review P1 #23 — was previously only
 *  recorded as a total, so a chatty `web_fetch` dominating the run was
 *  invisible. Populated by the agent loop; exposed via AgentMetrics. */
export interface ToolStat {
  count: number;
  totalMs: number;
  errors: number;
}

export interface AgentMetrics {
  iterations: number;
  toolCalls: number;
  totalToolMs: number;
  totalLlmMs: number;
  retries: number;
  promptTokens: number;
  completionTokens: number;
  /** Per-tool breakdown. Tool name → stats. */
  toolStats?: Record<string, ToolStat>;
}

export interface ConfirmDecision {
  approve: boolean;
  remember?: boolean;
  /**
   * Optional reason tag — distinguishes an explicit user click from an
   * abort-driven synthetic deny or a deny-all default. Recorded in the
   * agent audit log so a reviewer can tell the difference between "the
   * human said no" and "the run was cancelled before the gate fired".
   *   - "user_allow"        : human clicked Allow
   *   - "user_deny"         : human clicked Deny
   *   - "aborted"           : run-level abort fired while the modal was open
   *                           OR before the gate had a chance to render
   *   - "unattended_denied" : default deny-all gate fired (no UI involved)
   */
  reason?: "user_allow" | "user_deny" | "aborted" | "unattended_denied";
}

export interface AgentRunOptions {
  model: string;
  messages: Message[];
  conversationId: number;
  workspaceRoot: string | null;
  /**
   * Which LLM backend to run the tool-calling loop against. Defaults to
   * "ollama" when omitted (back-compat). MLX uses the OpenAI-compatible
   * `/v1/chat/completions` endpoint; native (mistralrs) has no tool-call
   * support and the runner rejects it before the loop starts.
   */
  backend?: AgentBackend;
  /**
   * Connection details for the MLX backend (host/port/model). Required when
   * `backend === "mlx"`; ignored otherwise. Ollama uses a fixed local URL.
   */
  serverStatus?: ServerStatus | null;
  /** Optional system-prompt override (from active preset). */
  systemPromptOverride?: string;
  /** Tools the user has allowed for this conversation. Empty = all allowed. */
  toolAllowlist?: string[];
  /** Optional tool-calling fitness hint. When omitted the runner derives it
   *  from `model` via classifyToolFitness; "weak" appends a JSON-format nudge
   *  to the system prompt to lift small/abliterated models' tool-call rate. */
  modelFitness?: import("../model-capabilities").ToolFitness;
  /** Session-scoped flags: dangerous tools auto-approved if true. */
  approveAllShell?: boolean;
  approveAllWrite?: boolean;
  /**
   * Dry-run mode. When true, side-effectful tools (`write_file`, `edit_file`,
   * `multi_edit`, `run_shell`, `applescript_run`, `browser_navigate`,
   * `browser_click`, `browser_fill`) are short-circuited in the dispatcher —
   * they return a `{ok:true, dry_run:true, would_*:...}` payload instead of
   * invoking the Tauri command. Read-only tools execute normally.
   */
  dryRun?: boolean;
  /** Shell command prefixes auto-approved this session (e.g. "git", "ls"). */
  approvedShellPrefixes?: string[];
  /** Called when user opts into "remember this command pattern". */
  onApproveShellPrefix?: (prefix: string) => void;
  onUpdate: (msgs: Message[]) => void;
  onStatusChange: (status: AgentStatus) => void;
  onMetrics?: (m: AgentMetrics) => void;
  /**
   * Optional: fires for each raw content delta from the streaming LLM
   * response. Use this to render an in-flight assistant bubble; the runner
   * also pushes the partial message into `onUpdate(msgs)` so consumers that
   * ignore this callback still see streaming progress.
   */
  onAssistantDelta?: (text: string) => void;
  requestConfirmation: (
    toolName: string,
    args: Record<string, unknown>,
    risk: Risk,
  ) => Promise<ConfirmDecision>;
  signal: AbortSignal;
  /** Internal: depth counter for spawn_subagent recursion guard. */
  _subagentDepth?: number;
  /**
   * Optional pre-loaded project policy. The runner will also load one
   * lazily from `workspaceRoot` on start, but callers can short-circuit
   * that by passing the policy directly (used in tests).
   */
  projectPolicy?: ProjectPolicy | null;
  /**
   * Explicit context-window size in tokens. When omitted the context
   * manager resolves it from `model`. Used to budget the sent message
   * array so a small-context model can't evict the system prompt.
   */
  contextTokens?: number;
  /**
   * Per-conversation model parameter overrides. When provided, the agent
   * chat clients thread these into the backend request. Null fields fall
   * back to backend defaults.
   */
  params?: ChatParams | null;
  /**
   * Optional workflow_runs.id when this loop is invoked from a workflow
   * card. Threaded into every `recordAuditSafe` call so the audit row can
   * be correlated back to the run that produced it (schema v12). Null /
   * omitted for interactive chat turns.
   */
  workflowRunId?: number | null;
}

/**
 * Base model parameters applied to every agent chat turn, regardless of
 * backend. Per-conversation `ChatParams` override individual fields; this is
 * the shared default so agent behaviour is portable across ollama/mlx/native.
 */
export interface AgentChatConfig {
  temperature: number;
  top_p: number;
  /** Upper bound on generated tokens (ollama `num_predict` / OpenAI `max_tokens`). */
  max_tokens: number;
  /** Context-window size hint in tokens. */
  context_size: number;
}

/**
 * The single shared default. Resolved once and applied uniformly across the
 * three backend clients' agent paths. A low temperature keeps tool-calling
 * deterministic; the token cap stops a runaway generation.
 */
export const DEFAULT_AGENT_CHAT_CONFIG: AgentChatConfig = {
  temperature: 0.4,
  top_p: 0.95,
  max_tokens: 4096,
  context_size: 8192,
};

/**
 * Merge per-conversation `ChatParams` over the base `AgentChatConfig`. Null /
 * undefined fields fall through to the base default — this is the override
 * layer, not a replacement.
 */
export function resolveAgentChatConfig(
  params?: ChatParams | null,
  base: AgentChatConfig = DEFAULT_AGENT_CHAT_CONFIG,
): AgentChatConfig {
  return {
    temperature: params?.temperature ?? base.temperature,
    top_p: params?.top_p ?? base.top_p,
    max_tokens: params?.max_tokens ?? base.max_tokens,
    context_size: base.context_size,
  };
}

/** Resolved per-conversation model parameters threaded into chat requests. */
export interface ChatParams {
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  /** Replaces the system-prompt; the runner prepends it as a system message. */
  system_prompt?: string | null;
}
