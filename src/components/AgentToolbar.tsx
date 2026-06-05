import { useCallback, useEffect, useState } from "react";
import { History, Settings, RotateCcw } from "lucide-react";
import { ExportMenu } from "./ExportMenu";
import { api } from "../lib/tauri-api";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
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
/**
 * UI surface for `agent_undo`. Reads the snapshot stack on render, shows
 * "Undo last (filename)" when there's something to revert, and pops via
 * the approval-gated IPC. Stays disabled while empty.
 *
 * Code re-review H-NEW-1: wrapped in `useTwoClickConfirm` so a single
 * misclick can't revert. Same pattern as conversation delete + Fork-from-
 * here. The Rust IPC's approval token is still required; this is the
 * human-facing gate.
 */
function AgentUndoButton() {
  const [topEntry, setTopEntry] = useState<{ path: string; kind: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmer = useTwoClickConfirm();
  const refresh = useCallback(async () => {
    try {
      const rows = await api.agentListUndo();
      setTopEntry(rows[0] ?? null);
    } catch {
      setTopEntry(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
    // Audit H10 (2026-05-27): previously polled every 3s while visible —
    // ~1200 IPC/hour for a UI that only changes when the user issues a
    // mutating agent tool. Bumped to 30s and added an immediate refresh
    // on tab-visibility regain so a backgrounded → foregrounded session
    // sees the current state without waiting for the next tick. A full
    // event-driven push from Rust (`agent-undo-changed`) requires
    // threading AppHandle through ~10 IPC call sites in commands/agent.rs
    // — deferred to a future pass; the 30s tick is the practical floor
    // since the undo button is a passive informational chip, not a
    // primary affordance.
    const onVisChange = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisChange);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [refresh]);
  if (!topEntry) {
    return (
      <button
        type="button"
        className="agent-settings-btn"
        title="Nothing to undo — no agent writes captured yet"
        disabled
      >
        <RotateCcw size={16} /> Undo (none)
      </button>
    );
  }
  const base = topEntry.path.split("/").pop() ?? topEntry.path;
  const armed = confirmer.armed === "undo";
  return (
    <button
      type="button"
      className={`agent-settings-btn${armed ? " armed" : ""}`}
      title={
        armed
          ? `Click again to revert ${topEntry.kind} of ${topEntry.path}`
          : `Revert ${topEntry.kind} of ${topEntry.path}`
      }
      data-testid="agent-undo-btn"
      disabled={busy}
      onClick={() => {
        confirmer.request("undo", () => {
          void (async () => {
            setBusy(true);
            try {
              await api.agentUndoLast();
              await refresh();
            } catch {
              // Approval rejection / nothing-to-undo — surface in toolbar
              // is not actionable; the diag layer already logs the cause.
            } finally {
              setBusy(false);
            }
          })();
        });
      }}
    >
      {busy
        ? "Reverting…"
        : armed
          ? "Click again to confirm"
          : <><RotateCcw size={16} /> Undo {base}</>}
    </button>
  );
}

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
      {/* Audit H-F4 (2026-05-27): mount ExportMenu only when a real
          conversation is selected. The previous `conversation as
          Conversation` cast silenced TS but passed `null` through to
          ExportMenu's typed prop — the disabled-state branch was the
          only thing keeping it from runtime-crashing on a null deref. */}
      {conversation && (
        <ExportMenu
          conversation={conversation}
          messages={messages}
          open={showExportMenu}
          onToggle={onToggleExportMenu}
          onClose={onCloseExportMenu}
          disabled={messages.length === 0}
        />
      )}
      <button
        className="agent-toggle"
        onClick={onToggleToolHistory}
        disabled={messages.length === 0}
        title="Expand tool-call history (calls are hidden from the chat)"
      >
        <History size={16} /> History
      </button>
      <button
        data-testid="params-toggle"
        className={`agent-toggle ${showParamsPanel ? "active" : ""}`}
        onClick={onToggleParams}
        title="Per-conversation model parameters"
        aria-expanded={showParamsPanel}
      >
        <Settings size={16} /> Params{!paramsAreEmpty(convParams) ? " •" : ""}
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
          <Settings size={16} />
        </button>
      )}
      {/* (Removed the read-only "Preset: X" chip — the preset <select> above
          already shows the active preset; the chip was a duplicate.) */}
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
      {agentMetrics && agentMode && (() => {
        const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
        const tok = agentMetrics.promptTokens + agentMetrics.completionTokens;
        return (
          <span
            className="agent-metrics"
            title={`${agentMetrics.iterations} iterations · ${agentMetrics.toolCalls} tool calls · ${Math.round(agentMetrics.totalLlmMs)}ms LLM · ${Math.round(agentMetrics.totalToolMs)}ms tools · ${agentMetrics.retries} retries · ${agentMetrics.promptTokens} prompt + ${agentMetrics.completionTokens} completion tokens`}
          >
            {agentMetrics.iterations} iter · {agentMetrics.toolCalls} tools · {fmt(agentMetrics.totalLlmMs)} llm
            {agentMetrics.retries > 0 && ` · ${agentMetrics.retries} retries`}
            {tok > 0 && ` · ${tok.toLocaleString()} tok`}
          </span>
        );
      })()}
      {/* UX re-review M1: agent_undo had no UI surface — only the model
          could revert its own writes. This button lets the user pop the
          most-recent agent file-write off the snapshot stack without
          asking the model. The Rust IPC is approval-gated so a stray
          click still has to confirm. */}
      {agentMode && <AgentUndoButton />}
    </div>
  );
}
