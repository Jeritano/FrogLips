import { useEffect, useState } from "react";
import { ExportMenu } from "./ExportMenu";
import type { AgentSettings } from "../hooks/useAgentSettings";
import type { AgentMetrics, AgentStatus } from "../lib/agent-loop";
import type { Conversation, ConversationParams, Message, ProjectPolicy } from "../types";
import { paramsAreEmpty } from "../lib/conversation-params";

const COACH_KEY = "agent.coachSeen";

interface Props {
  conversation: Conversation | null;
  messages: Message[];
  agent: AgentSettings;
  agentMode: boolean;
  agentAvailable: boolean;
  agentStatus: AgentStatus;
  agentMetrics: AgentMetrics | null;
  isWorking: boolean;
  workspaceRoot: string | null;
  projectPolicy: ProjectPolicy | null;
  convParams: ConversationParams;
  showParamsPanel: boolean;
  showAgentSettings: boolean;
  showExportMenu: boolean;
  onToggleAgent: () => void;
  onToggleParams: () => void;
  onToggleAgentSettings: () => void;
  onToggleToolHistory: () => void;
  onToggleExportMenu: () => void;
  onCloseExportMenu: () => void;
}

/**
 * Chat toolbar: export menu, tools/params toggles, the agent-mode switch with
 * preset selector + settings gear, live status/metrics, and — when agent mode
 * is on — always-visible preset + workspace discoverability chips. A one-line
 * coach hint appears once on the agent toggle (dismissal persisted).
 */
export function AgentToolbar(props: Props) {
  const {
    conversation, messages, agent, agentMode, agentAvailable, agentStatus,
    agentMetrics, isWorking, workspaceRoot, projectPolicy, convParams,
    showParamsPanel, showAgentSettings, showExportMenu, onToggleAgent,
    onToggleParams, onToggleAgentSettings, onToggleToolHistory,
    onToggleExportMenu, onCloseExportMenu,
  } = props;

  const [coachSeen, setCoachSeen] = useState(() => {
    try {
      return localStorage.getItem(COACH_KEY) === "true";
    } catch {
      return true;
    }
  });

  // Dismiss the coach hint the first time the user actually enables agent mode.
  useEffect(() => {
    if (agentMode && !coachSeen) {
      setCoachSeen(true);
      try { localStorage.setItem(COACH_KEY, "true"); } catch { /* ignore */ }
    }
  }, [agentMode, coachSeen]);

  const workspaceLabel = workspaceRoot
    ? workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot
    : "full filesystem";

  return (
    <div className="agent-toolbar">
      <ExportMenu
        conversation={conversation as Conversation}
        messages={messages}
        open={showExportMenu && !!conversation}
        onToggle={onToggleExportMenu}
        onClose={onCloseExportMenu}
        disabled={!conversation || messages.length === 0}
      />
      <button
        className="agent-toggle"
        onClick={onToggleToolHistory}
        disabled={messages.length === 0}
        title="Tool call history"
      >
        ⌖ Tools
      </button>
      <button
        data-testid="params-toggle"
        className={`agent-toggle ${showParamsPanel ? "active" : ""}`}
        onClick={onToggleParams}
        title="Per-conversation model parameters"
        aria-expanded={showParamsPanel}
      >
        ⚙ Params{!paramsAreEmpty(convParams) ? " •" : ""}
      </button>
      <button
        data-testid="agent-toggle"
        className={`agent-toggle ${agentMode ? "active" : ""}`}
        onClick={onToggleAgent}
        disabled={isWorking || !agentAvailable}
        title={agentAvailable ? "Toggle agent mode (tool calling)" : "Agent mode requires the Ollama or MLX backend"}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
        </svg>
        Agent
      </button>
      {!coachSeen && agentAvailable && (
        <span className="agent-coach-hint" data-testid="agent-coach-hint">
          ← Enable agent mode for file, shell &amp; web tools
        </span>
      )}
      {agentMode && (
        <select
          data-testid="agent-preset-select"
          className="agent-preset-select"
          value={agent.activePresetId}
          onChange={(e) => agent.selectPreset(e.target.value)}
          disabled={isWorking}
          title={agent.activePreset?.description ?? ""}
        >
          {agent.presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
      {agentMode && (
        <button
          data-testid="agent-settings-gear"
          className="agent-toggle"
          onClick={onToggleAgentSettings}
          disabled={isWorking}
          title="Agent settings"
          aria-label="Agent settings"
          aria-expanded={showAgentSettings}
        >
          ⚙
        </button>
      )}
      {agentMode && (
        <span
          className="agent-status-pill agent-preset-chip"
          data-testid="agent-preset-chip"
          title={agent.activePreset?.description ?? "Active agent preset"}
        >
          Preset: {agent.activePreset?.name ?? "Default"}
        </span>
      )}
      {agentMode && (
        <span
          className="agent-status-pill agent-workspace-chip"
          data-testid="agent-workspace-chip"
          title={workspaceRoot ?? "Agent can reach the full filesystem — set a workspace to confine it"}
        >
          Workspace: {workspaceLabel}
        </span>
      )}
      {agentMode && agentStatus !== "idle" && (
        <span className={`agent-status-pill status-${agentStatus}`}>
          {agentStatus === "thinking" && "Thinking…"}
          {agentStatus === "tool" && "Running tool…"}
        </span>
      )}
      {agentMode && projectPolicy && (
        <span
          className="agent-status-pill policy-pill"
          data-testid="agent-policy-chip"
          title={
            `Project policy active${projectPolicy.source_path ? ` (${projectPolicy.source_path})` : ""}${
              projectPolicy.notes ? `\n\n${projectPolicy.notes}` : ""
            }`
          }
        >
          Policy: project{projectPolicy.notes ? ` — ${projectPolicy.notes.slice(0, 40)}${projectPolicy.notes.length > 40 ? "…" : ""}` : ""}
        </span>
      )}
      {agentMetrics && agentMode && (
        <span
          className="agent-metrics"
          title="iterations · tool calls · llm ms · tool ms · retries · prompt tok · completion tok"
        >
          i{agentMetrics.iterations}·t{agentMetrics.toolCalls}·llm {Math.round(agentMetrics.totalLlmMs)}ms·tool {Math.round(agentMetrics.totalToolMs)}ms
          {agentMetrics.retries > 0 && `·r${agentMetrics.retries}`}
          {(agentMetrics.promptTokens + agentMetrics.completionTokens) > 0 &&
            `·${agentMetrics.promptTokens}+${agentMetrics.completionTokens}tok`}
        </span>
      )}
    </div>
  );
}
