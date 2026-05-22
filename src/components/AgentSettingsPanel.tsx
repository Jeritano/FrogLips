import { lazy, Suspense } from "react";
import { McpSettings } from "./McpSettings";
import type { AgentSettings } from "../hooks/useAgentSettings";

// RagPanel and AuditLog only render inside the agent-settings disclosure
// (gear icon while agent mode is on). Lazy-load so first paint of the chat
// surface doesn't pay for them — both pull in their own datastore helpers.
const RagPanel = lazy(() =>
  import("./RagPanel").then((m) => ({ default: m.RagPanel })),
);
const AuditLog = lazy(() =>
  import("./AuditLog").then((m) => ({ default: m.AuditLog })),
);

const ALL_TOOL_NAMES = [
  "read_file", "list_dir", "search_files", "file_exists",
  "run_shell", "write_file", "edit_file", "multi_edit",
  "git_status", "git_diff", "git_log", "git_show", "git_branches", "git_commit",
  "web_fetch", "web_search", "read_pdf", "screenshot",
  "clipboard_get", "clipboard_set", "open_app", "show_notification",
  "applescript_run", "http_request",
  "find_definition", "find_references", "format_code",
  "task_create", "task_status", "task_list", "task_cancel",
  "ask_user", "spawn_subagent", "await_subagents", "list_subagents",
] as const;

interface Props {
  agent: AgentSettings;
  workspaceRoot: string | null;
  workspaceErr: string | null;
  updateMsg: string | null;
  onChooseWorkspace: () => void;
  onCheckUpdates: () => void;
}

/**
 * Agent-mode settings disclosure (the gear panel). Workspace picker, session
 * approvals, dry-run, tool allowlist grid, approved shell prefixes, updater
 * and the lazy MCP / RAG / AuditLog panels. Extracted verbatim from ChatWindow.
 */
export function AgentSettingsPanel({
  agent,
  workspaceRoot,
  workspaceErr,
  updateMsg,
  onChooseWorkspace,
  onCheckUpdates,
}: Props) {
  return (
    <div className="agent-settings" data-testid="agent-settings-panel">
      <div className="agent-settings-row">
        <span className="agent-settings-label">Workspace:</span>
        <code className="agent-settings-value">{workspaceRoot ?? "(full filesystem)"}</code>
        <button className="agent-settings-btn" onClick={onChooseWorkspace}>Set…</button>
      </div>
      {workspaceErr && <div className="error-bar" role="alert">{workspaceErr}</div>}
      <div className="agent-settings-row">
        <span className="agent-settings-label">Approve all this session:</span>
        <label>
          <input type="checkbox" checked={agent.approveAllShell}
                 onChange={(e) => agent.setApproveAllShell(e.target.checked)} />
          shell (normal-risk only)
        </label>
        <label>
          <input type="checkbox" checked={agent.approveAllWrite}
                 onChange={(e) => agent.setApproveAllWrite(e.target.checked)} />
          writes/edits
        </label>
      </div>
      <div className="agent-settings-row">
        <span className="agent-settings-label">Safety:</span>
        <label data-testid="agent-dry-run-toggle">
          <input
            type="checkbox"
            checked={agent.dryRun}
            onChange={(e) => agent.setDryRun(e.target.checked)}
          />
          Dry-run mode
        </label>
        <span className="agent-settings-hint">
          Side-effectful tools report what they would do without executing.
        </span>
      </div>
      <div className="agent-settings-row">
        <span className="agent-settings-label">Allowed tools:</span>
        <span className="agent-settings-hint">
          {agent.allowlist.length === 0 ? "(all enabled)" : `${agent.allowlist.length} selected`}
        </span>
      </div>
      <div className="agent-tool-grid">
        {ALL_TOOL_NAMES.map((n) => {
          const enabled = agent.allowlist.length === 0 || agent.allowlist.includes(n);
          return (
            <label key={n} className={`agent-tool-pill ${enabled ? "on" : "off"}`}>
              <input type="checkbox" checked={enabled}
                     onChange={() => agent.toggleAllowed(n)} />
              {n}
            </label>
          );
        })}
      </div>
      {agent.allowlist.length > 0 && (
        <button className="agent-settings-btn" onClick={agent.resetAllowlist}>
          Reset to all enabled
        </button>
      )}
      {agent.approvedShellPrefixes.length > 0 && (
        <div className="agent-settings-row">
          <span className="agent-settings-label">Approved shell prefixes:</span>
          <span className="agent-settings-value">{agent.approvedShellPrefixes.join(", ")}</span>
          <button className="agent-settings-btn" onClick={() => agent.setApprovedShellPrefixes([])}>
            Clear
          </button>
        </div>
      )}
      <div className="agent-settings-row">
        <span className="agent-settings-label">Updates:</span>
        <button className="agent-settings-btn" onClick={onCheckUpdates}>Check now</button>
        {updateMsg && <span className="agent-settings-hint">{updateMsg}</span>}
      </div>
      <McpSettings />
      {/*
       * Render lazy panels inside a single Suspense boundary — both
       * resolve from the same chunk pipeline, and a shared fallback
       * keeps the panel layout stable while they hydrate (no flash of
       * empty space between the rows).
       */}
      <Suspense fallback={<div className="lazy-loading">Loading…</div>}>
        <RagPanel />
        <AuditLog />
      </Suspense>
    </div>
  );
}
