import type {
  McpServerConfig,
  Message,
  ProjectPolicy,
  ServerStatus,
} from "../../types";
import type { CheckpointTurn } from "../tauri-api";

export type AgentStatus = "idle" | "thinking" | "tool" | "done" | "error";

/**
 * Risk classification for a tool call. These are the exact strings the Rust
 * classifiers (`classify_shell_risk`, `classify_applescript_risk`,
 * `classify_http_risk`) and `classifyToolRisk` can produce.
 */
export type Risk =
  | "normal"
  | "destructive"
  | "pipe-from-network"
  | "privileged";

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

/** Backends the agent loop can run a tool-calling chat against.
 *  - `ollama | mlx | native` — local / in-process.
 *  - `custom | openrouter`    — OpenAI-compatible cloud endpoints, routed
 *    through Rust (`custom_chat_stream` / `custom_chat_stream_tools`). For
 *    `custom`, `model` carries the `CustomBackend.id`; for `openrouter`, `model`
 *    is the catalogue model id (the per-call override). Both run un-gated by the
 *    local-inference semaphore (see `shouldBypassInferenceGate`). */
export type AgentBackend =
  | "ollama"
  | "mlx"
  | "native"
  | "custom"
  | "openrouter";

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
   * Per-run "trust this task" (item 5). When the user ticks "Allow all
   * remaining actions for this task" at a confirmation modal and approves, the
   * runner auto-approves this run's REMAINING allowlisted, normal-risk tool
   * calls without re-prompting — killing confirm-fatigue on a multi-step task.
   * It is RUN-SCOPED only (never persisted across runs) and NEVER covers
   * irreversible tools (delete_path / kill_process / agent_undo) or non-normal
   * risk, which always re-confirm. Ignored unless `approve` is also true.
   */
  trustRun?: boolean;
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
  /**
   * Fires when a canonical message lands in the runner's message array
   * (assistant reply, assistant-with-tool-calls, tool result) — STRUCTURAL
   * changes only, never per streamed token. In-flight assistant text is
   * delivered exclusively through `onAssistantDelta`; consumers that want a
   * live bubble must accumulate deltas themselves (and coalesce to frames).
   */
  onUpdate: (msgs: Message[]) => void;
  onStatusChange: (status: AgentStatus) => void;
  onMetrics?: (m: AgentMetrics) => void;
  /**
   * Optional durable per-iteration checkpoint hook (item 4A). Fires ONCE per
   * agent iteration, after that turn's tool-results have settled and before the
   * next "thinking" status, with the run's agent turns so far (system/user
   * turns excluded). Interactive sends wire this to `api.agentRunCheckpoint`
   * so an interrupted long run leaves a durable shadow record.
   *
   * ABSENT (the default — subagents, flows, and tests set nothing) makes the
   * runner byte-identical to its prior behaviour: no checkpoint IPC fires.
   */
  onCheckpoint?: (turns: CheckpointTurn[]) => void;
  /**
   * Optional: fires for each raw content delta from the streaming LLM
   * response. The ONLY channel carrying in-flight assistant text — render
   * the live bubble from this, then drop the accumulator when `onUpdate`
   * delivers the canonical message that absorbed it.
   */
  onAssistantDelta?: (text: string) => void;
  /**
   * Optional: the transport retried the in-flight stream (transient 5xx /
   * connection fault). Any text accumulated from `onAssistantDelta` for the
   * current turn belongs to the abandoned attempt — discard it.
   */
  onStreamReset?: () => void;
  /**
   * Mid-run steering (W4-SEND item 3). Called at each turn boundary (before the
   * runner composes the next LLM request) to drain any user messages queued
   * while the run is in flight. Returned strings are appended as `user` turns so
   * the model sees the new guidance WITHOUT aborting the run. Returning an empty
   * array (or omitting the callback entirely — the default) leaves the loop
   * byte-identical to its prior behaviour. The caller owns the queue and is
   * responsible for clearing it as it drains.
   */
  drainSteeringMessages?: () => string[];
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
   * Ollama keep_alive for local requests ("5m" | "30m" | "-1"). Settings-
   * driven; defaults to "30m" in the chat layer (the daemon's own 5m makes
   * idle reloads of 20-60GB models painfully common).
   */
  keepAlive?: string;
  /** Names of the user's registered call_api targets, surfaced in the system
   *  prompt so the model knows which APIs it can call. */
  savedApiNames?: string[];
  /**
   * Max agent tool-turns for this run. Overrides the runner default (80),
   * clamped to [5, 400]. Wired from the `agent_max_iterations` setting so long
   * multi-file builds can raise the ceiling. Absent = default.
   */
  maxIterations?: number;
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
  /**
   * RESUME: prior agent turns rehydrated from a durable checkpoint, to continue
   * an interrupted long run. When present (and non-empty) the runner appends
   * these as already-settled history AFTER the incoming `messages` (which carry
   * the original user prompt + system context) and BEFORE the loop's first LLM
   * call, then inserts a single conservative re-validation system note so the
   * model treats the prior work as DONE history rather than re-doing it.
   *
   * The turns are the exact `CheckpointTurn` shadow the runner emitted: an
   * assistant turn that carried tool_calls is the JSON `{ content, tool_calls }`
   * envelope (decoded here). Past tool calls are NEVER re-executed — they are
   * reconstructed as history only. Absent/empty = a normal (non-resume) run,
   * byte-identical to today.
   */
  resumeFromTurns?: CheckpointTurn[];
  /**
   * GLOBAL list of built-in tool names the user switched OFF in the Skills &
   * Tools hub (settings.disabled_tools). Excluded from the system prompt's
   * advertised tools, ON TOP of `toolAllowlist` (only ever further restricts).
   * Absent/empty (the default) = nothing disabled = today's behavior.
   */
  disabledTools?: string[];
  /**
   * MCP server configs (settings.mcp_servers). Tools from any server whose
   * config `enabled === false` are excluded from the system prompt's advertised
   * tools. `enabled === undefined`/`true` (and unknown servers) stay available
   * — today's behavior. Absent/empty (the default) = no server gated.
   */
  mcpServerConfigs?: McpServerConfig[];
  /**
   * Gated macOS "Computer Use" mode (settings.computer_use_enabled). When true,
   * the cu_* desktop-control tools are advertised + permitted and screenshot
   * tool results are fed back to the model as vision input. Default false:
   * cu_* tools are dropped from the advertised list AND hard-blocked at dispatch.
   */
  computerUseEnabled?: boolean;
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
