import type { Message, ProjectPolicy, ServerStatus } from "../../types";

export type AgentStatus = "idle" | "thinking" | "tool" | "done" | "error";

/** Backends the agent loop can run a tool-calling chat against. */
export type AgentBackend = "ollama" | "mlx" | "native";

export interface AgentMetrics {
  iterations: number;
  toolCalls: number;
  totalToolMs: number;
  totalLlmMs: number;
  retries: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ConfirmDecision {
  approve: boolean;
  remember?: boolean;
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
    risk: string,
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
}
