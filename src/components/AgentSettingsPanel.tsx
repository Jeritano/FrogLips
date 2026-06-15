import { lazy, Suspense, useState } from "react";
import { McpSettings } from "./McpSettings";
import { CustomBackendsSettings } from "./CustomBackendsSettings";
import { ErrorBar } from "./ErrorBar";
import type { AgentSettings } from "../hooks/useAgentSettings";
import {
  SYNTAX_THEMES,
  getSyntaxTheme,
  setSyntaxTheme,
  type SyntaxThemeId,
} from "../lib/syntax-theme";
import {
  BUBBLE_COLORS,
  getBubbleColor,
  setBubbleColor,
} from "../lib/bubble-color";

// AuditLog only renders inside the agent-settings disclosure (gear icon
// while agent mode is on). Lazy-loaded so first paint of the chat
// surface doesn't pay for the datastore helpers.
//
// RagPanel used to live here too but moved to its own top-level
// Knowledge view (sidebar) for discoverability — see KnowledgeView.tsx.
// Agents and workflows that need the corpus library now point users to
// the sidebar Knowledge entry instead of the chat-agent gear.
const AuditLog = lazy(() =>
  import("./AuditLog").then((m) => ({ default: m.AuditLog })),
);

const ALL_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "search_files",
  "file_exists",
  "run_shell",
  "write_file",
  "edit_file",
  "multi_edit",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branches",
  "git_commit",
  "web_fetch",
  "web_search",
  "read_pdf",
  "screenshot",
  "clipboard_get",
  "clipboard_set",
  "open_app",
  "show_notification",
  "applescript_run",
  "http_request",
  "find_definition",
  "find_references",
  "format_code",
  "task_create",
  "task_status",
  "task_list",
  "task_cancel",
  "ask_user",
  "spawn_subagent",
  "await_subagents",
  "list_subagents",
] as const;

interface Props {
  agent: AgentSettings;
  workspaceRoot: string | null;
  workspaceErr: string | null;
  /** Optional dismiss callback for the workspace error — UX re-review H-2
   *  added so this surface uses the shared ErrorBar component with a real
   *  close button instead of a sticky inline string. */
  onDismissWorkspaceErr?: () => void;
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
  onDismissWorkspaceErr,
  updateMsg,
  onChooseWorkspace,
  onCheckUpdates,
}: Props) {
  const [syntaxTheme, setSyntaxThemeState] = useState<SyntaxThemeId>(() =>
    getSyntaxTheme(),
  );
  const [bubbleColor, setBubbleColorState] = useState<string | null>(() =>
    getBubbleColor(),
  );
  return (
    <div className="agent-settings" data-testid="agent-settings-panel">
      <div className="agent-settings-row">
        <span className="agent-settings-label">Workspace:</span>
        <code className="agent-settings-value">
          {workspaceRoot ?? "(home folder — default)"}
        </code>
        <button className="agent-settings-btn" onClick={onChooseWorkspace}>
          Set…
        </button>
      </div>
      {!workspaceRoot && (
        <div className="agent-settings-row">
          <span className="agent-settings-hint">
            No workspace set: the agent is confined to your home folder
            (system and credential paths like ~/.ssh and ~/.aws are always
            blocked). Set a workspace to narrow it to a single project.
          </span>
        </div>
      )}
      <ErrorBar
        message={workspaceErr}
        onDismiss={onDismissWorkspaceErr ?? (() => undefined)}
      />
      <div className="agent-settings-row">
        <span className="agent-settings-label">Approve all this session:</span>
        <label>
          <input
            type="checkbox"
            checked={agent.approveAllShell}
            onChange={(e) => agent.setApproveAllShell(e.target.checked)}
          />
          shell (normal-risk only)
        </label>
        <label>
          <input
            type="checkbox"
            checked={agent.approveAllWrite}
            onChange={(e) => agent.setApproveAllWrite(e.target.checked)}
          />
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
          {agent.allowlist.length === 0
            ? "(all enabled)"
            : `${agent.allowlist.length} selected`}
        </span>
      </div>
      <div className="agent-tool-grid">
        {ALL_TOOL_NAMES.map((n) => {
          const enabled =
            agent.allowlist.length === 0 || agent.allowlist.includes(n);
          return (
            <label
              key={n}
              className={`agent-tool-pill ${enabled ? "on" : "off"}`}
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={() => agent.toggleAllowed(n)}
              />
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
          <span className="agent-settings-value">
            {agent.approvedShellPrefixes.join(", ")}
          </span>
          <button
            className="agent-settings-btn"
            onClick={() => agent.setApprovedShellPrefixes([])}
          >
            Clear
          </button>
        </div>
      )}
      <div className="agent-settings-row">
        <span className="agent-settings-label">Updates:</span>
        <button className="agent-settings-btn" onClick={onCheckUpdates}>
          Check now
        </button>
        {updateMsg && <span className="agent-settings-hint">{updateMsg}</span>}
      </div>
      <div className="agent-settings-row">
        <span className="agent-settings-label">Code colors:</span>
        <select
          className="agent-settings-select"
          value={syntaxTheme}
          aria-label="Code syntax highlight palette"
          onChange={(e) => {
            const id = e.target.value as SyntaxThemeId;
            setSyntaxThemeState(id);
            setSyntaxTheme(id);
          }}
        >
          {SYNTAX_THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="agent-settings-hint">
          Syntax-highlight palette for code blocks. Adapts to light/dark.
        </span>
      </div>
      <div className="agent-settings-row">
        <span className="agent-settings-label">Chat bubble:</span>
        <div
          className="wf-color-row"
          role="radiogroup"
          aria-label="User chat bubble color"
        >
          {BUBBLE_COLORS.map((c) => {
            const selected = (bubbleColor ?? null) === c.value;
            return (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`wf-color-swatch${selected ? " selected" : ""}${c.value === null ? " wf-color-default" : ""}`}
                style={c.value ? { background: c.value } : undefined}
                title={c.name}
                aria-label={c.name}
                onClick={() => {
                  setBubbleColorState(c.value);
                  setBubbleColor(c.value);
                }}
              />
            );
          })}
        </div>
      </div>
      <McpSettings />
      <CustomBackendsSettings />
      <Suspense fallback={<div className="lazy-loading">Loading…</div>}>
        <AuditLog />
      </Suspense>
    </div>
  );
}
