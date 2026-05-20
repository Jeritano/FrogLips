import type { Message } from "../../types";

export type AgentStatus = "idle" | "thinking" | "tool" | "done" | "error";

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
  /** Optional system-prompt override (from active preset). */
  systemPromptOverride?: string;
  /** Tools the user has allowed for this conversation. Empty = all allowed. */
  toolAllowlist?: string[];
  /** Session-scoped flags: dangerous tools auto-approved if true. */
  approveAllShell?: boolean;
  approveAllWrite?: boolean;
  /** Shell command prefixes auto-approved this session (e.g. "git", "ls"). */
  approvedShellPrefixes?: string[];
  /** Called when user opts into "remember this command pattern". */
  onApproveShellPrefix?: (prefix: string) => void;
  onUpdate: (msgs: Message[]) => void;
  onStatusChange: (status: AgentStatus) => void;
  onMetrics?: (m: AgentMetrics) => void;
  requestConfirmation: (
    toolName: string,
    args: Record<string, unknown>,
    risk: string,
  ) => Promise<ConfirmDecision>;
  signal: AbortSignal;
  /** Internal: depth counter for spawn_subagent recursion guard. */
  _subagentDepth?: number;
}
