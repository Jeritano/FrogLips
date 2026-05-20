/* Barrel: re-exports the public surface of the agent loop.
   Keeps `import ... from "./lib/agent-loop"` working unchanged. */

export { runAgentLoop } from "./runner";
export { cancelActiveShell } from "./dispatch";
export type {
  AgentStatus,
  AgentMetrics,
  ConfirmDecision,
  AgentRunOptions,
} from "./types";
