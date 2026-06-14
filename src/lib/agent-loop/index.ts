/* Barrel: re-exports the public surface of the agent loop.
   Keeps `import ... from "./lib/agent-loop"` working unchanged. */

export { runAgentLoop } from "./runner";
export { cancelActiveShell } from "./dispatch";
export { setMaxConcurrentSubagents } from "./subagent";
export type {
  AgentStatus,
  AgentMetrics,
  ConfirmDecision,
  AgentRunOptions,
  AgentBackend,
} from "./types";
