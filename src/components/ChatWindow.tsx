import { useCallback, useEffect, useRef, useState } from "react";
import { Zap, Clock, ShieldCheck, Shuffle } from "lucide-react";
import { api } from "../lib/tauri-api";
import type { ConfirmDecision } from "../lib/agent-loop";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AgentMetrics, AgentStatus } from "../lib/agent-loop";
import type { Conversation, ConversationParams, Memory, Message, ProjectPolicy, ServerStatus } from "../types";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { ContextRolloverBanner } from "./ContextRolloverBanner";
import { ToolHistory } from "./ToolHistory";
import { ParamsPanel } from "./ParamsPanel";
import { ContextMeter } from "./ContextMeter";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorBar } from "./ErrorBar";
import { AgentToolbar } from "./AgentToolbar";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import { EmptyChatLanding } from "./EmptyChatLanding";
import {
  emptyParams,
  parseConversationParams,
  serializeConversationParams,
} from "../lib/conversation-params";
import { logDiag } from "../lib/diagnostics";
import { useAgentSettings } from "../hooks/useAgentSettings";
import { useCitationOpener } from "../hooks/useCitationOpener";
import { useAskUserModal } from "../hooks/useAskUserModal";
import { useQuickPromptToast } from "../hooks/useQuickPromptToast";
import { useChatSend } from "../hooks/useChatSend";
import type { RouteDecision } from "../lib/chat-router";
import { RoutesSettings } from "./RoutesSettings";
import { useEvent } from "../hooks/useEvent";

interface Props {
  status: ServerStatus | null;
  conversation: Conversation | null;
  onConversationCreated: (c: Conversation) => void;
  onMemoriesChanged?: () => void;
  /**
   * Invoked after a fork is created. Receives the new conversation id so the
   * host can refresh the sidebar and switch the active selection to it.
   */
  onForked?: (newConvId: number) => void;
}

interface ConfirmState {
  toolName: string;
  args: Record<string, unknown>;
  risk: string;
}

export function ChatWindow({ status, conversation, onConversationCreated, onMemoriesChanged, onForked }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const [recalled, setRecalled] = useState<Memory[]>([]);
  const [agentMode, setAgentMode] = useState(false);
  // Multi-model auto-routing (plain chat). Persisted across sessions.
  const [autoRoute, setAutoRoute] = useState<boolean>(
    () => localStorage.getItem("chat.autoRoute") === "1",
  );
  const [routedNotice, setRoutedNotice] = useState<RouteDecision | null>(null);
  const [showRoutes, setShowRoutes] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [workspaceErr, setWorkspaceErr] = useState<string | null>(null);
  const [agentMetrics, setAgentMetrics] = useState<AgentMetrics | null>(null);
  const [rememberPrefix, setRememberPrefix] = useState(false);
  const [destructiveAck, setDestructiveAck] = useState(false);
  const [showToolHistory, setShowToolHistory] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [projectPolicy, setProjectPolicy] = useState<ProjectPolicy | null>(null);
  // Edit-and-retry: holds the user message being edited plus its draft text.
  const [editState, setEditState] = useState<{ msg: Message; text: string } | null>(null);
  // Per-conversation model parameters (temperature / top-p / max tokens /
  // system prompt). Decoded from `conversation.params`; all-null = defaults.
  const [convParams, setConvParams] = useState<ConversationParams>(emptyParams);
  const [showParamsPanel, setShowParamsPanel] = useState(false);

  const agent = useAgentSettings();
  const askUser = useAskUserModal(setErr);
  const { quickToast, dismissToast } = useQuickPromptToast();

  const onCitationOpened = useCallback((label: string) => {
    setUpdateMsg(`Opened in ${label}`);
    setTimeout(
      () => setUpdateMsg((m) => (m && m.startsWith("Opened") ? null : m)),
      2200,
    );
  }, []);
  const citation = useCitationOpener(workspaceRoot, setErr, onCitationOpened);

  const creatingConvRef = useRef<Promise<Conversation> | null>(null);
  const convRef = useRef<Conversation | null>(null);
  const confirmResolveRef = useRef<((v: ConfirmDecision) => void) | null>(null);

  useEffect(() => {
    api.agentGetWorkspace().then(setWorkspaceRoot).catch((err) =>
      logDiag({
        level: "warn",
        source: "chat-window",
        message: "agentGetWorkspace failed on mount",
        detail: err,
      }),
    );
  }, []);

  // Refresh the active project policy whenever the workspace changes.
  // Missing / malformed `.froglips/policy.json` → null (silent).
  useEffect(() => {
    if (!workspaceRoot) {
      setProjectPolicy(null);
      return;
    }
    let cancelled = false;
    api.policyLoad(workspaceRoot)
      .then((p) => { if (!cancelled) setProjectPolicy(p ?? null); })
      .catch((err) => {
        if (!cancelled) setProjectPolicy(null);
        // A malformed .froglips/policy.json or unreadable file used to vanish
        // silently — log it so the user can debug why their policy isn't
        // taking effect. Missing-file is a normal case (no policy in the
        // project) and the Rust side returns null rather than rejecting,
        // so anything that reaches here is a real read/parse failure.
        logDiag({
          level: "warn",
          source: "chat-window",
          message: `policyLoad failed for ${workspaceRoot} — falling back to no project policy`,
          detail: err,
        });
      });
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  useEffect(() => {
    convRef.current = conversation;
    // Guard the async listMessages resolution so an A→B→A rapid switch can't
    // paint stale messages from an older fetch over the current view. The
    // closure-captured `ignore` is flipped to true by the cleanup; any
    // resolution after that is dropped.
    let ignore = false;
    if (conversation) {
      api.listMessages(conversation.id)
        .then((msgs) => { if (!ignore) setMessages(msgs); })
        .catch((e) => { if (!ignore) setErr(String(e)); });
    } else {
      setMessages([]);
    }
    setRecalled([]);
    setRoutedNotice(null); // clear the previous chat's route chip on switch
    setConvParams(parseConversationParams(conversation?.params));
    setShowParamsPanel(false);
    return () => { ignore = true; };
  }, [conversation?.id]);

  const ensureConversation = useEvent(async (): Promise<Conversation> => {
    if (convRef.current) return convRef.current;
    if (creatingConvRef.current) return creatingConvRef.current;
    const promise = (async () => {
      const title = "New chat";
      const id = await api.createConversation(title, status?.model ?? null);
      const c: Conversation = {
        id,
        title,
        model: status?.model ?? null,
        created_at: Math.floor(Date.now() / 1000),
      };
      convRef.current = c;
      onConversationCreated(c);
      return c;
    })();
    creatingConvRef.current = promise;
    try { return await promise; } finally { creatingConvRef.current = null; }
  });

  /* ── Confirmation gate for dangerous agent tools ── */

  const requestConfirmation = useEvent((
    toolName: string,
    args: Record<string, unknown>,
    risk: string,
  ): Promise<ConfirmDecision> => {
    setRememberPrefix(false);
    setDestructiveAck(false);
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmState({ toolName, args, risk });
    });
  });

  async function chooseWorkspace() {
    setWorkspaceErr(null);
    // Use Tauri's native directory picker — window.prompt is blocked in the
    // Tauri 2 webview anyway, and even when it worked it gave the user zero
    // help validating a real on-disk path. The dialog plugin is loaded lazily
    // so the initial bundle stays slim.
    let picked: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const res = await open({
        directory: true,
        multiple: false,
        defaultPath: workspaceRoot ?? undefined,
        title: "Choose workspace root",
      });
      picked = Array.isArray(res) ? (res[0] ?? null) : res;
    } catch (e) {
      // Distinguish "plugin not loaded" (legitimate dev fallback) from a real
      // platform/permission error. The dialog plugin reports missing IPC
      // commands with messages like "plugin not registered", "command not
      // found", or "not allowed by the scope". Only those silently fall
      // through to the prompt; anything else (e.g. a permission denial we
      // need to debug) surfaces via setErr and the diagnostics ring buffer.
      const msg = e instanceof Error ? e.message : String(e);
      const isPluginMissing =
        /plugin\s*(not\s*registered|missing)/i.test(msg) ||
        /command\s*(not\s*found|missing)/i.test(msg) ||
        /not\s*allowed\s*by\s*the\s*scope/i.test(msg);
      if (!isPluginMissing) {
        logDiag({
          level: "warn",
          source: "chat-window",
          message: "workspace dialog open() failed — falling back to typed entry",
          detail: e,
        });
        setWorkspaceErr(`Workspace picker unavailable: ${msg}`);
      }
      // Audit L-F1 (2026-05-28): the old fallback called `window.prompt`,
      // which Tauri 2 WKWebView blocks → the user got nothing. Removed
      // the dead branch; the picker-unavailable error above is now the
      // terminal state. If the user needs to set the workspace and the
      // dialog plugin is broken, the workaround is to invoke
      // `agent_set_workspace` directly via DiagnosticsPanel.
      return;
    }
    try {
      const set = await api.agentSetWorkspace(picked);
      setWorkspaceRoot(set);
    } catch (e) {
      setWorkspaceErr(String(e));
    }
  }

  async function checkUpdates() {
    setUpdateMsg("Checking…");
    try {
      const upd = await checkForUpdate();
      if (!upd) {
        setUpdateMsg("Up to date.");
        return;
      }
      setUpdateMsg(`Update available: v${upd.version}. Downloading…`);
      await upd.downloadAndInstall();
      setUpdateMsg("Installed. Relaunching…");
      await relaunch();
    } catch (e) {
      setUpdateMsg(`Update failed: ${e}`);
    }
  }

  function handleConfirm(approved: boolean) {
    // Destructive actions must clear the explicit ack checkbox — defends
    // against single-click approval fatigue and prompt-injection chains
    // that flash a dangerous-looking command past the user.
    if (approved && confirmState?.risk === "destructive" && !destructiveAck) {
      return;
    }
    const remember = approved && rememberPrefix;
    setConfirmState(null);
    setRememberPrefix(false);
    setDestructiveAck(false);
    confirmResolveRef.current?.({ approve: approved, remember });
    confirmResolveRef.current = null;
  }

  // Settle a pending tool-confirmation as a deny-aborted when the run is
  // stopped. Without this the agent loop stays parked on `await
  // requestConfirmation` forever (modal lingers over a dead loop) and, on a
  // late "Allow", would execute the very tool the user tried to cancel. The
  // runner also re-checks abort after the gate, so this is the un-park half.
  // Round 6 HIGH (2026-05-30).
  const abortWithConfirm = useEvent(() => {
    if (confirmResolveRef.current) {
      confirmResolveRef.current({ approve: false, reason: "aborted" });
      confirmResolveRef.current = null;
    }
    setConfirmState(null);
    setRememberPrefix(false);
    setDestructiveAck(false);
    abort();
  });

  const isWorking = streaming !== undefined || agentStatus === "thinking" || agentStatus === "tool";
  // Agent mode (tool-calling loop) runs on Ollama and MLX. The native
  // (mistralrs) backend has no tool-call support — agent mode is disabled.
  const agentAvailable = status?.backend === "ollama" || status?.backend === "mlx";

  /* ── Send pipeline ── */
  const { send, resend, abort } = useChatSend({
    status,
    agentMode,
    agentAvailable,
    workspaceRoot,
    projectPolicy,
    convParams,
    agent,
    messages,
    ensureConversation,
    convRef,
    requestConfirmation,
    setMessages,
    setStreaming,
    setErr,
    setRecalled,
    setAgentStatus,
    setAgentMetrics,
    onMemoriesChanged,
    routingEnabled: autoRoute,
    onRouted: setRoutedNotice,
  });

  // Persist the auto-route toggle; clear the live notice when turned off.
  const toggleAutoRoute = useCallback(() => {
    setAutoRoute((on) => {
      const next = !on;
      localStorage.setItem("chat.autoRoute", next ? "1" : "0");
      if (!next) setRoutedNotice(null);
      return next;
    });
  }, []);

  /**
   * Persist per-conversation params. Optimistically updates local state so
   * the panel + context meter react immediately; a failed write surfaces in
   * the error bar but leaves the optimistic value in place (the user can
   * retry by editing again).
   */
  const saveConvParams = useCallback(async (next: ConversationParams) => {
    setConvParams(next);
    const conv = convRef.current;
    if (!conv) return; // no conversation yet — keep the draft in state only.
    try {
      await api.updateConversationParams(conv.id, serializeConversationParams(next));
    } catch (e) {
      setErr(`Failed to save conversation parameters: ${e}`);
    }
  }, []);

  // When the backend changes to one that can't do agent mode, drop the
  // agent toggle so send() never silently falls through to plain streaming.
  useEffect(() => {
    if (!agentAvailable && agentMode) setAgentMode(false);
  }, [agentAvailable, agentMode]);

  // 2026-05-25 user-reported "Stop model didn't unstick the spinner". When
  // `status.running` flips false while a send is in flight, abort the
  // outbound controller so the UI returns to idle. Without this the
  // streaming fetch sits waiting for bytes from a server that's now dead
  // and the spinner stays on "thinking" until the fetch eventually
  // errors out (which can take a long time on a graceful TCP close).
  const wasRunningRef = useRef<boolean>(false);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    const nowRunning = !!status?.running;
    wasRunningRef.current = nowRunning;
    if (wasRunning && !nowRunning && isWorking) {
      abortWithConfirm();
      setStreaming(undefined);
      setAgentStatus("idle");
    }
  }, [status?.running, isWorking, abortWithConfirm]);

  // Stable handler identity for MessageRow's React.memo — `useEvent` keeps the
  // reference fixed while the body always sees the latest state.
  const onRegenerate = useEvent(async () => {
    if (isWorking || !conversation) return;
    let lastUserIdx = -1;
    let lastAsstIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (lastAsstIdx === -1 && m.role === "assistant" && !m.tool_calls?.length) {
        lastAsstIdx = i;
      } else if (lastAsstIdx !== -1 && lastUserIdx === -1 && m.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1 || lastAsstIdx === -1) return;
    const userText = messages[lastUserIdx].content;
    for (let i = lastUserIdx; i <= lastAsstIdx; i++) {
      const id = messages[i]?.id;
      if (id != null) {
        try { await api.deleteMessage(id); } catch (err) {
          logDiag({
            level: "warn",
            source: "chat-window",
            message: `regenerate: deleteMessage(${id}) failed — proceeding anyway`,
            detail: err,
          });
        }
      }
    }
    const truncated = messages.slice(0, lastUserIdx).concat(messages.slice(lastAsstIdx + 1));
    setMessages(truncated);
    await resend(userText, truncated);
  });

  // Edit-and-retry. Opens a small editor seeded with the user message's
  // current text; on submit we truncate everything from that message onward
  // (mirroring regenerate) and resend with the edited text.
  const onEditUser = useEvent((msg: Message) => {
    if (isWorking) return;
    setEditState({ msg, text: msg.content });
  });

  async function submitEdit() {
    if (!editState || isWorking || !conversation) return;
    const { msg, text } = editState;
    const newText = text.trim();
    setEditState(null);
    if (!newText) return;
    const editIdx = messages.findIndex(
      (m) => (msg.id != null && m.id === msg.id) || (msg._tmpKey && m._tmpKey === msg._tmpKey),
    );
    if (editIdx === -1) return;
    // Delete the edited user message and everything after it from the DB.
    for (let i = editIdx; i < messages.length; i++) {
      const id = messages[i]?.id;
      if (id != null) {
        try { await api.deleteMessage(id); } catch (err) {
          logDiag({
            level: "warn",
            source: "chat-window",
            message: `edit: deleteMessage(${id}) failed — proceeding anyway`,
            detail: err,
          });
        }
      }
    }
    const truncated = messages.slice(0, editIdx);
    setMessages(truncated);
    await resend(newText, truncated);
  }

  // Stable handler for MessageList → MessageRow (React.memo). An inline arrow
  // here would bust the row memo on every parent render (one per streaming
  // rAF frame) and undo the windowing perf work. `useEvent` keeps the
  // reference fixed while the body always observes the latest props.
  const onForkMsg = useEvent(async (msg: Message) => {
    if (!conversation?.id || msg.id == null) return;
    try {
      const newId = await api.conversationFork(conversation.id, msg.id);
      onForked?.(newId);
    } catch (e) {
      setErr(`Fork failed: ${e}`);
    }
  });

  // Show the landing whenever there's nothing to display — INCLUDING the cold
  // start where no conversation is selected (a stranger's first launch).
  // `send()` auto-creates a conversation via `ensureConversation()`, so the
  // null case sends fine; previously requiring a non-null conversation left
  // the whole pane blank on first run.
  const showLanding = messages.length === 0 && !isWorking;

  return (
    <div className="chat-window" onClick={citation.onCitationClick}>
      {agentMode && agent.dryRun && (
        <div className="dry-run-banner" data-testid="agent-dry-run-banner" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldCheck size={14} /> Dry-run: tool side-effects suppressed
        </div>
      )}
      {showLanding ? (
        <EmptyChatLanding modelReady={!!status?.running} />
      ) : (
        <MessageList
          messages={messages}
          streaming={streaming}
          conversationId={conversation?.id ?? null}
          workspaceRoot={workspaceRoot}
          currentModel={status?.running ? status.model : null}
          agentStatus={agentStatus}
          onRegenerate={onRegenerate}
          onEditUser={onEditUser}
          onFork={onForkMsg}
        />
      )}
      <div className="chat-input-wrap">
        {recalled.length > 0 && (
          <div className="recall-pill">
            <span className="recall-icon"><Zap size={16} /></span>
            Recalled {recalled.length} memor{recalled.length === 1 ? "y" : "ies"} for this turn
          </div>
        )}
        <ErrorBar message={err} onDismiss={() => setErr(null)} />

        <div className="chat-routing-bar">
          <button
            type="button"
            className={`route-toggle${autoRoute ? " on" : ""}`}
            onClick={toggleAutoRoute}
            disabled={agentMode}
            title={
              agentMode
                ? "Auto-route applies to plain chat (turn off Agent mode)"
                : "Auto-route each message to the best-fit configured model"
            }
          >
            <Shuffle size={14} /> Auto-route {autoRoute ? "on" : "off"}
          </button>
          {autoRoute && (
            <button type="button" className="route-manage" onClick={() => setShowRoutes(true)}>
              Manage routes
            </button>
          )}
          {autoRoute && routedNotice && (
            <span className="route-chip" title={routedNotice.reason ?? routedNotice.method}>
              → {routedNotice.label} · <code>{routedNotice.model}</code>
              <span className="route-method"> · {routedNotice.method}</span>
            </span>
          )}
        </div>

        {showRoutes && <RoutesSettings status={status} onClose={() => setShowRoutes(false)} />}

        <AgentToolbar
          conversation={conversation}
          messages={messages}
          agent={agent}
          agentMode={agentMode}
          agentAvailable={agentAvailable}
          agentStatus={agentStatus}
          agentMetrics={agentMetrics}
          activeModel={status?.model ?? null}
          isWorking={isWorking}
          workspaceRoot={workspaceRoot}
          projectPolicy={projectPolicy}
          convParams={convParams}
          showParamsPanel={showParamsPanel}
          showAgentSettings={showAgentSettings}
          showExportMenu={showExportMenu}
          onToggleAgent={() => setAgentMode((v) => !v)}
          onToggleParams={() => setShowParamsPanel((v) => !v)}
          onToggleAgentSettings={() => setShowAgentSettings((v) => !v)}
          onToggleToolHistory={() => setShowToolHistory((v) => !v)}
          onToggleExportMenu={() => setShowExportMenu((v) => !v)}
          onCloseExportMenu={() => setShowExportMenu(false)}
        />

        {showParamsPanel && (
          <ParamsPanel
            params={convParams}
            onSave={saveConvParams}
            onClose={() => setShowParamsPanel(false)}
            disabled={isWorking}
          />
        )}

        {agentMode && showAgentSettings && (
          <AgentSettingsPanel
            agent={agent}
            workspaceRoot={workspaceRoot}
            workspaceErr={workspaceErr}
            onDismissWorkspaceErr={() => setWorkspaceErr(null)}
            updateMsg={updateMsg}
            onChooseWorkspace={chooseWorkspace}
            onCheckUpdates={checkUpdates}
          />
        )}

        <ContextRolloverBanner
          messages={messages}
          status={status}
          conversation={conversation}
          onContinued={(newId) => onForked?.(newId)}
        />

        <div className="composer-row">
          <ChatInput
            disabled={!status?.running}
            onSend={send}
            onAbort={abortWithConfirm}
            streaming={isWorking}
            currentModel={status?.running ? status.model : null}
            status={status}
          />
          <ContextMeter
            messages={messages}
            model={status?.running ? status.model : null}
            status={status}
          />
        </div>
      </div>

      {showToolHistory && (
        <ToolHistory messages={messages} onClose={() => setShowToolHistory(false)} />
      )}

      {askUser.askUserReq && (
        <ConfirmDialog
          ariaLabel="Agent question"
          onDismiss={askUser.cancelAskUser}
          title="Agent asks:"
          actions={
            <>
              <button className="agent-confirm-deny" onClick={askUser.cancelAskUser}>Cancel</button>
              <button className="agent-confirm-allow" onClick={askUser.submitAskUser} disabled={!askUser.askUserAnswer.trim()}>
                Send
              </button>
            </>
          }
        >
          <div style={{ padding: "8px 0", fontSize: 13 }}>{askUser.askUserReq.question}</div>
          {askUser.askUserReq.hint && (
            <div style={{ padding: "0 0 8px 0", fontSize: 11, color: "var(--text-muted)" }}>{askUser.askUserReq.hint}</div>
          )}
          <textarea
            className="ask-user-input"
            value={askUser.askUserAnswer}
            onChange={(e) => askUser.setAskUserAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                askUser.submitAskUser();
              } else if (e.key === "Escape") {
                e.preventDefault();
                askUser.cancelAskUser();
              }
            }}
            placeholder="Your answer (Cmd+Enter to send, Esc to cancel)…"
            autoFocus
            rows={3}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "var(--surface)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 6,
              padding: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical",
            }}
          />
        </ConfirmDialog>
      )}

      {/* Edit-and-retry modal */}
      {editState && (
        <ConfirmDialog
          ariaLabel="Edit message"
          data-testid="edit-message-modal"
          onDismiss={() => setEditState(null)}
          title="Edit message"
          actions={
            <>
              <button className="agent-confirm-deny" onClick={() => setEditState(null)}>Cancel</button>
              <button
                data-testid="edit-message-submit"
                className="agent-confirm-allow"
                onClick={submitEdit}
                disabled={!editState.text.trim()}
              >
                Resend
              </button>
            </>
          }
        >
          <textarea
            className="ask-user-input"
            value={editState.text}
            onChange={(e) => setEditState((s) => (s ? { ...s, text: e.target.value } : s))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditState(null);
              }
            }}
            placeholder="Edit your message (Cmd+Enter to resend, Esc to cancel)…"
            autoFocus
            rows={4}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "var(--surface)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 6,
              padding: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical",
            }}
          />
        </ConfirmDialog>
      )}

      {/* Citation open confirmation — shows the resolved absolute path so the
          user sees exactly which file an untrusted model is asking to open. */}
      {citation.citationConfirm && (
        <ConfirmDialog
          ariaLabel="Open file in editor"
          data-testid="citation-confirm-modal"
          onDismiss={citation.dismissConfirm}
          title="Open file in editor?"
          actions={
            <>
              <button className="agent-confirm-deny" onClick={citation.dismissConfirm}>
                Cancel
              </button>
              <button
                data-testid="citation-confirm-allow"
                className="agent-confirm-allow"
                onClick={citation.confirmOpen}
              >
                Open
              </button>
            </>
          }
        >
          <div style={{ padding: "8px 0", fontSize: 12, color: "var(--text-muted)" }}>
            This citation was written by the model. It will open in an external editor:
          </div>
          <pre className="agent-confirm-args">
            {citation.citationConfirm.resolved}{citation.citationConfirm.line ? `:${citation.citationConfirm.line}` : ""}
          </pre>
        </ConfirmDialog>
      )}

      {/* Tool confirmation modal */}
      {confirmState && (
        <ConfirmDialog
          ariaLabel={`Confirm tool ${confirmState.toolName}`}
          data-testid="agent-confirm-modal"
          boxClassName={`risk-${confirmState.risk}`}
          onDismiss={() => handleConfirm(false)}
          title={
            <>
              Allow <code>{confirmState.toolName}</code>?
              {confirmState.risk !== "normal" && (
                <span className={`agent-risk-badge risk-${confirmState.risk}`}>
                  {confirmState.risk}
                </span>
              )}
            </>
          }
          actions={
            <>
              <button data-testid="agent-confirm-deny" className="agent-confirm-deny" onClick={() => handleConfirm(false)}>Deny</button>
              <button
                data-testid="agent-confirm-allow"
                className="agent-confirm-allow"
                onClick={() => handleConfirm(true)}
                disabled={confirmState.risk === "destructive" && !destructiveAck}
              >
                Allow
              </button>
            </>
          }
        >
          {confirmState.risk === "destructive" && (
            <>
              <div className="agent-risk-warning">
                ⚠ This action matches a known destructive pattern. Read it carefully before approving.
              </div>
              <label className="agent-confirm-remember" style={{ color: "var(--danger-fg, #fca5a5)" }}>
                <input
                  type="checkbox"
                  checked={destructiveAck}
                  onChange={(e) => setDestructiveAck(e.target.checked)}
                />
                I have read this and accept the consequences
              </label>
            </>
          )}
          {/* UX re-review H-3: surface a "Long-running" chip when the
              model requested a non-default timeout_secs so the user
              isn't surprised by a 5-min hang from a JSON arg buried in
              the &lt;pre&gt; below. */}
          {confirmState.toolName === "run_shell" && (() => {
            const t = (confirmState.args as Record<string, unknown>).timeout_secs;
            if (typeof t === "number" && t > 60) {
              return (
                <div className="agent-confirm-chip" data-testid="agent-confirm-long-running">
                  <Clock size={16} /> Long-running ({t}s budget)
                </div>
              );
            }
            return null;
          })()}
          {/* UX re-review M10: kill_process modal previously showed raw
              {pid: 12345} with no process name — the user couldn't tell
              if pid 12345 was their editor or Finder. Surface pid +
              signal in plain language. */}
          {confirmState.toolName === "kill_process" && (() => {
            const a = confirmState.args as Record<string, unknown>;
            const pid = typeof a.pid === "number" ? a.pid : "?";
            const signal = typeof a.signal === "string" ? a.signal.toUpperCase() : "TERM";
            return (
              <div
                className="agent-confirm-chip danger"
                data-testid="agent-confirm-kill"
              >
                ⚠ Send SIG{signal} to pid {String(pid)} — irreversible
              </div>
            );
          })()}
          {/* UX re-review M10 generalized: every IRREVERSIBLE tool gets a
              loud plain-language chip in addition to the destructive
              risk badge. */}
          {(confirmState.toolName === "delete_path" || confirmState.toolName === "agent_undo") && (() => {
            const a = confirmState.args as Record<string, unknown>;
            if (confirmState.toolName === "delete_path") {
              const recursive = a.recursive === true;
              const path = typeof a.path === "string" ? a.path : "?";
              return (
                <div
                  className="agent-confirm-chip"
                  style={{ background: "var(--danger-bg)", color: "var(--danger-fg)" }}
                  data-testid="agent-confirm-delete"
                >
                  ⚠ {recursive ? "Recursively delete" : "Delete"} <code>{path}</code> — cannot be undone unless captured by agent_undo
                </div>
              );
            }
            // UX re-review L-new-3: the modal doesn't have access to
            // list_undo() here, so we can't tell whether the top entry
            // was an Absent-marker (create → undo deletes) or a Bytes
            // entry (edit → undo restores). Surface both possibilities.
            return (
              <div
                className="agent-confirm-chip danger"
                data-testid="agent-confirm-undo"
              >
                ⚠ Revert the most recent agent file write (may delete a created file) — cannot be redone
              </div>
            );
          })()}
          <pre className="agent-confirm-args" data-testid="agent-confirm-args">
            {JSON.stringify(confirmState.args, null, 2)}
          </pre>
          {confirmState.toolName === "run_shell" && confirmState.risk === "normal" && (() => {
            const cmd = String(confirmState.args.command ?? "");
            const first = cmd.trim().split(/\s+/)[0] ?? "";
            if (!first) return null;
            return (
              <label className="agent-confirm-remember">
                <input
                  type="checkbox"
                  checked={rememberPrefix}
                  onChange={(e) => setRememberPrefix(e.target.checked)}
                />
                Also approve all <code>{first} *</code> commands this session
              </label>
            );
          })()}
        </ConfirmDialog>
      )}

      {quickToast && (() => {
        const activateToast = () => {
          if (quickToast.error) { dismissToast(); return; }
          // Activate → dump the reply into the clipboard as a starting point.
          // Strict v1.3: no auto-resubmit, no conversation creation.
          try {
            navigator.clipboard.writeText(quickToast.reply).catch((err) =>
              logDiag({
                level: "info",
                source: "chat-window",
                message: "quick-toast clipboard.writeText rejected",
                detail: err,
              }),
            );
          } catch (err) {
            logDiag({
              level: "info",
              source: "chat-window",
              message: "quick-toast clipboard write threw synchronously",
              detail: err,
            });
          }
          dismissToast();
        };
        return (
        <div
          className="quick-toast"
          data-testid="quick-prompt-toast"
          role={quickToast.error ? "alert" : "button"}
          aria-label={quickToast.error ? undefined : "Copy quick reply to clipboard"}
          tabIndex={0}
          onClick={activateToast}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              activateToast();
            }
          }}
        >
          {quickToast.error ? (
            <span>Quick prompt failed: {quickToast.error}</span>
          ) : (
            <span>Quick reply ready ↗ <em style={{ color: "var(--text-muted)", fontStyle: "normal" }}>(click to copy)</em></span>
          )}
        </div>
        );
      })()}
    </div>
  );
}
