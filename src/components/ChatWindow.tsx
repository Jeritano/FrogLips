import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import { streamChat } from "../lib/mlx-client";
import { streamNativeChat } from "../lib/native-client";
import { runAgentLoop, cancelActiveShell } from "../lib/agent-loop";
import type { AgentMetrics, AgentStatus, ConfirmDecision } from "../lib/agent-loop";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { ChatImage, Conversation, Memory, Message, ProjectPolicy, ServerStatus } from "../types";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { McpSettings } from "./McpSettings";
import { ToolHistory } from "./ToolHistory";

// RagPanel and AuditLog only render inside the agent-settings disclosure
// (gear icon while agent mode is on). Lazy-load so first paint of the chat
// surface doesn't pay for them — both pull in their own datastore helpers.
const RagPanel = lazy(() =>
  import("./RagPanel").then((m) => ({ default: m.RagPanel })),
);
const AuditLog = lazy(() =>
  import("./AuditLog").then((m) => ({ default: m.AuditLog })),
);
import { conversationToMarkdown, downloadText, safeFilename, type ExportMode } from "../lib/export";
import {
  getMemoryMode,
  recall,
  formatRecallBlock,
  extractFacts,
  saveMemory,
} from "../lib/memory-client";
import { logDiag } from "../lib/diagnostics";
import { useAgentSettings } from "../hooks/useAgentSettings";
import { useCitationOpener } from "../hooks/useCitationOpener";
import { useAskUserModal } from "../hooks/useAskUserModal";
import { useQuickPromptToast } from "../hooks/useQuickPromptToast";

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

function tmpKey(): string {
  return `tmp:${crypto.randomUUID()}`;
}

/**
 * Extract memory facts from a completed user/assistant turn and persist them.
 * Shared by the agent-mode and plain-streaming send paths. `source` only
 * tags the diagnostics line. Fires `onAdded` when at least one new (non-dedup)
 * memory landed.
 */
async function extractAndSaveFacts(
  userText: string,
  responseText: string,
  convId: number,
  mode: "queue" | "direct",
  source: string,
  onAdded: () => void,
) {
  try {
    const facts = await extractFacts(userText, responseText, convId);
    if (!facts.length) return;
    let added = 0;
    for (const f of facts) {
      try {
        const r = await saveMemory({
          content: f.fact,
          conversationId: convId,
          tags: mode === "queue" ? "auto,pending" : "auto",
          status: mode === "queue" ? "pending" : "active",
        });
        if (!r.deduped) added++;
      } catch (err) {
        logDiag({
          level: "warn",
          source: "memory-extract",
          message: `${source} saveMemory failed for an extracted fact`,
          detail: err,
        });
      }
    }
    if (added > 0) onAdded();
  } catch (err) {
    logDiag({
      level: "warn",
      source: "memory-extract",
      message: `${source} extractFacts pipeline rejected`,
      detail: err,
    });
  }
}

export function ChatWindow({ status, conversation, onConversationCreated, onMemoriesChanged, onForked }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const [recalled, setRecalled] = useState<Memory[]>([]);
  const [agentMode, setAgentMode] = useState(false);
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

  const abortRef = useRef<AbortController | null>(null);
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
      .catch(() => { if (!cancelled) setProjectPolicy(null); });
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  useEffect(() => {
    convRef.current = conversation;
    if (conversation) {
      api.listMessages(conversation.id).then(setMessages).catch((e) => setErr(String(e)));
    } else {
      setMessages([]);
    }
    setRecalled([]);
  }, [conversation?.id]);

  async function ensureConversation(): Promise<Conversation> {
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
  }

  /* ── Confirmation gate for dangerous agent tools ── */

  function requestConfirmation(
    toolName: string,
    args: Record<string, unknown>,
    risk: string,
  ): Promise<ConfirmDecision> {
    setRememberPrefix(false);
    setDestructiveAck(false);
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmState({ toolName, args, risk });
    });
  }

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
      // Plugin missing in dev / a permission was denied → fall back to a
      // typed entry so the user isn't blocked. Empty input clears scope.
      const typed = window.prompt(
        "Workspace root (agent confined to this dir; blank = full FS):",
        workspaceRoot ?? "",
      );
      if (typed === null) return;
      picked = typed.trim() ? typed.trim() : null;
      void e;
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

  /* ── Send ── */

  /**
   * Core send: persist the user turn, recall memories, stream the response
   * (agent loop or plain streaming) and persist the assistant turn.
   *
   * `priorHistory`, when supplied, overrides the React closure's `messages` —
   * the regenerate/edit callers have already truncated the message list but
   * those updates aren't visible here via the closure yet. Passing the truth
   * explicitly avoids dup'd user messages and stale-history pollution.
   */
  async function runSend(text: string, images?: ChatImage[], priorHistory?: Message[]) {
    if (!status?.running || !status.model) {
      setErr("Start a model first");
      return;
    }
    setErr(null);

    let conv: Conversation;
    try {
      conv = await ensureConversation();
    } catch (e) {
      setErr(`Failed to create conversation: ${e}`);
      return;
    }
    const mode = getMemoryMode();

    const userMsg: Message = {
      _tmpKey: tmpKey(),
      conversation_id: conv.id,
      role: "user",
      content: text,
      images,
    };
    let userId: number;
    try {
      userId = await api.addMessage(conv.id, "user", text, null, images);
    } catch (e) {
      setErr(`Failed to save message: ${e}`);
      return;
    }
    userMsg.id = userId;
    const baseHistory = [...(priorHistory ?? messages), userMsg];
    const streamConvId = conv.id;
    const isStreamConvActive = () => convRef.current?.id === streamConvId;
    if (isStreamConvActive()) setMessages(baseHistory);

    // Abort any still-streaming send before starting a new one — otherwise the
    // older controller is orphaned and its stream keeps appending tokens.
    // Created here (before recall) so Stop can also cancel memory recall.
    abortRef.current?.abort();
    cancelActiveShell();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Recall memories
    let recallBlock: string | null = null;
    let recallHits: Memory[] = [];
    if (mode !== "off") {
      try {
        recallHits = await recall(text, 5, { cwd: workspaceRoot, convId: conv.id }, ctrl.signal);
        recallBlock = formatRecallBlock(recallHits);
        if (isStreamConvActive()) setRecalled(recallHits);
        if (recallHits.length > 0) {
          api.touchMemories(recallHits.map((m) => m.id)).catch((err) =>
            logDiag({
              level: "warn",
              source: "memory-recall",
              message: "touchMemories failed — recency scores may be stale",
              detail: err,
            }),
          );
        }
      } catch (err) {
        logDiag({
          level: "warn",
          source: "memory-recall",
          message: "recall() threw — proceeding without recalled memories",
          detail: err,
        });
      }
    } else {
      if (isStreamConvActive()) setRecalled([]);
    }

    // Authoritative model-identity preamble. Some cloud-routed Ollama tags
    // (e.g. *:cloud) return inconsistent self-identity in reply text — this
    // pins the model to its actual tag so "what model are you?" answers
    // truthfully regardless of the upstream training data.
    const identityPrompt =
      `You are model "${status.model}" running via the ${status.backend} backend on the user's machine. ` +
      `When asked about your identity, name, version, or which model you are, respond with the exact identifier above ("${status.model}"). ` +
      `Do not claim to be GPT, Claude, Gemini, DeepSeek, Kimi, Llama, Qwen, or any other model unless that name appears literally inside "${status.model}". ` +
      `If you genuinely don't know, say "I'm running as ${status.model}; I don't have additional details about my training."`;

    const systemPreamble: Message[] = [
      { _tmpKey: tmpKey(), conversation_id: conv.id, role: "system", content: identityPrompt },
    ];
    if (recallBlock) {
      systemPreamble.push({ _tmpKey: tmpKey(), conversation_id: conv.id, role: "system", content: recallBlock });
    }
    const historyForApi: Message[] = [...systemPreamble, ...baseHistory];

    /* ── Agent mode ── */
    if (agentMode && agentAvailable) {
      if (isStreamConvActive()) setAgentStatus("thinking");
      try {
        setAgentMetrics(null);
        // Preset's allowedTools wins when non-empty; otherwise fall back to manual allowlist
        const effectiveAllowlist =
          agent.activePreset && agent.activePreset.allowedTools.length > 0
            ? agent.activePreset.allowedTools
            : agent.allowlist;
        // rAF-coalesce the per-delta onUpdate firehose. The runner mutates
        // its message snapshot once per token; without coalescing we'd thrash
        // React at 100+ tok/s. Latest snapshot wins; we never drop the final
        // state because the runner also emits onUpdate after stream end.
        let pendingMsgs: Message[] | null = null;
        let rafHandle = 0;
        const flush = () => {
          rafHandle = 0;
          const snap = pendingMsgs;
          pendingMsgs = null;
          if (snap && isStreamConvActive()) {
            setMessages(snap.filter((m) => m.role !== "system"));
          }
        };
        const finalText = await runAgentLoop({
          model: status.model,
          messages: historyForApi,
          conversationId: conv.id,
          workspaceRoot,
          // Gated by `agentAvailable` above, so backend is "ollama" | "mlx".
          backend: status.backend === "mlx" ? "mlx" : "ollama",
          serverStatus: status,
          projectPolicy,
          systemPromptOverride: agent.activePreset?.systemPromptOverride,
          toolAllowlist: effectiveAllowlist,
          approveAllShell: agent.approveAllShell,
          approveAllWrite: agent.approveAllWrite,
          dryRun: agent.dryRun,
          approvedShellPrefixes: agent.approvedShellPrefixes,
          onApproveShellPrefix: (p) => {
            agent.setApprovedShellPrefixes((prev) => (prev.includes(p) ? prev : [...prev, p]));
          },
          onUpdate: (msgs) => {
            if (!isStreamConvActive()) return;
            pendingMsgs = msgs;
            if (!rafHandle) rafHandle = requestAnimationFrame(flush);
          },
          onAssistantDelta: () => {
            // onUpdate already carries the streaming text; this hook exists
            // so callers can wire side-effects (e.g. token-level metrics)
            // without re-scanning the message list. No-op here.
          },
          onStatusChange: (s) => {
            if (isStreamConvActive()) setAgentStatus(s);
          },
          onMetrics: (m) => {
            if (isStreamConvActive()) setAgentMetrics(m);
          },
          requestConfirmation,
          signal: ctrl.signal,
        });
        // Flush any pending rAF snapshot so the final state lands before we
        // persist the assistant turn below.
        if (rafHandle) {
          cancelAnimationFrame(rafHandle);
          flush();
        }

        if (finalText != null) {
          // Persist final assistant response to DB and assign id to message in state
          try {
            const id = await api.addMessage(conv.id, "assistant", finalText, status.model);
            if (isStreamConvActive()) {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && !last.id && last._tmpKey) {
                  return [...prev.slice(0, -1), { ...last, id }];
                }
                return prev;
              });
            }
          } catch (e) {
            if (isStreamConvActive()) setErr(`Failed to save response: ${e}`);
          }

          if (mode === "queue" || mode === "direct") {
            void extractAndSaveFacts(text, finalText, conv.id, mode, "agent-mode", () =>
              onMemoriesChanged?.(),
            );
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted && isStreamConvActive()) {
          logDiag({
            level: "error",
            source: "agent-loop",
            message: "agent run failed",
            detail: e,
          });
          setErr(`Agent run failed: ${e}. Your message was kept — send again to retry.`);
        }
      } finally {
        abortRef.current = null;
        if (isStreamConvActive()) setAgentStatus("idle");
      }
      return;
    }

    /* ── Regular streaming mode ── */
    if (isStreamConvActive()) setStreaming("");
    let acc = "";
    let aborted = false;
    const ACC_MAX = 262_144;
    // Coalesce streaming updates to one per animation frame. At 100+ tok/s
    // a setState per chunk thrashes the renderer; rAF caps it to ~60 Hz.
    let scheduled = 0;
    const flushStreaming = () => {
      scheduled = 0;
      if (isStreamConvActive()) setStreaming(acc);
    };
    try {
      const stream = status.backend === "native"
        ? streamNativeChat(historyForApi, { signal: ctrl.signal })
        : streamChat(status, historyForApi, { signal: ctrl.signal });
      for await (const chunk of stream) {
        if (chunk.done) break;
        acc += chunk.delta;
        if (acc.length > ACC_MAX) {
          ctrl.abort();
          break;
        }
        if (!scheduled) scheduled = requestAnimationFrame(flushStreaming);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        aborted = true;
      } else if (isStreamConvActive()) {
        logDiag({
          level: "error",
          source: "chat-stream",
          message: "streaming chat failed",
          detail: e,
        });
        setErr(`The model stopped responding: ${e}. Send again to retry.`);
      }
    } finally {
      if (scheduled) cancelAnimationFrame(scheduled);
      abortRef.current = null;
      // No need to flush the final acc here — the assistant message gets
      // appended to `messages` below from `acc`, which renders the final
      // text via the normal MessageRow path. Clearing streaming hides the
      // cursor bubble.
      if (isStreamConvActive()) setStreaming(undefined);
    }

    const sameConv = isStreamConvActive;

    if (acc) {
      const asst: Message = {
        _tmpKey: tmpKey(),
        conversation_id: conv.id,
        role: "assistant",
        content: aborted ? acc + "\n\n[stopped]" : acc,
        model: status.model,
      };
      try {
        const id = await api.addMessage(conv.id, "assistant", asst.content, status.model);
        asst.id = id;
      } catch (e) {
        if (sameConv()) setErr(`Failed to save response: ${e}`);
      }
      if (sameConv()) setMessages((m) => [...m, asst]);

      if (mode === "queue" || mode === "direct") {
        void extractAndSaveFacts(text, acc, conv.id, mode, "chat", () =>
          onMemoriesChanged?.(),
        );
      }
    } else if (aborted) {
      const tombstone: Message = {
        _tmpKey: tmpKey(),
        conversation_id: conv.id,
        role: "assistant",
        content: "[stopped before response]",
        model: status.model,
      };
      try {
        const id = await api.addMessage(conv.id, "assistant", tombstone.content, status.model);
        tombstone.id = id;
      } catch (err) {
        logDiag({
          level: "warn",
          source: "chat-window",
          message: "failed to persist abort tombstone — message stays unsaved",
          detail: err,
        });
      }
      if (sameConv()) setMessages((m) => [...m, tombstone]);
    }
  }

  /** Normal send from the composer — optional pasted/attached images. */
  const send = useCallback((text: string, images?: ChatImage[]) => {
    return runSend(text, images);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, agentMode, projectPolicy, workspaceRoot, messages, agent]);

  /** Regenerate / edit-and-retry resend with an explicit truncated history. */
  function resend(text: string, priorHistory: Message[]) {
    return runSend(text, undefined, priorHistory);
  }

  function abort() {
    cancelActiveShell();
    abortRef.current?.abort();
  }

  const isWorking = streaming !== undefined || agentStatus === "thinking" || agentStatus === "tool";
  // Agent mode (tool-calling loop) runs on Ollama and MLX. The native
  // (mistralrs) backend has no tool-call support — agent mode is disabled.
  const agentAvailable = status?.backend === "ollama" || status?.backend === "mlx";

  // When the backend changes to one that can't do agent mode, drop the
  // agent toggle so send() never silently falls through to plain streaming.
  useEffect(() => {
    if (!agentAvailable && agentMode) setAgentMode(false);
  }, [agentAvailable, agentMode]);

  // Stable handler identity for MessageRow's React.memo. The closure always
  // sees the latest state via a ref-style indirection: we refresh the inner
  // fn on every render and expose a thin wrapper that delegates to it.
  const handleRegenerateRef = useRef<(() => void | Promise<void>) | null>(null);
  useEffect(() => {
    handleRegenerateRef.current = async () => {
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
    };
  });
  const onRegenerate = useCallback(() => handleRegenerateRef.current?.(), []);

  // Edit-and-retry. Opens a small editor seeded with the user message's
  // current text; on submit we truncate everything from that message onward
  // (mirroring regenerate) and resend with the edited text.
  const onEditUser = useCallback((msg: Message) => {
    if (isWorking) return;
    setEditState({ msg, text: msg.content });
  }, [isWorking]);

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

  return (
    <div className="chat-window" onClick={citation.onCitationClick}>
      {agentMode && agent.dryRun && (
        <div className="dry-run-banner" data-testid="agent-dry-run-banner">
          🛡️ Dry-run: tool side-effects suppressed
        </div>
      )}
      <MessageList
        messages={messages}
        streaming={streaming}
        conversationId={conversation?.id ?? null}
        workspaceRoot={workspaceRoot}
        currentModel={status?.running ? status.model : null}
        agentStatus={agentStatus}
        onRegenerate={onRegenerate}
        onEditUser={onEditUser}
        onFork={async (msg) => {
          // Fork-from-here. The button already confirmed with the user; we
          // just need the persisted message id + current conv id. Missing
          // either is a no-op (the row's `canFork` gate prevents this in
          // practice — kept as a belt-and-suspenders check).
          if (!conversation?.id || msg.id == null) return;
          try {
            const newId = await api.conversationFork(conversation.id, msg.id);
            onForked?.(newId);
          } catch (e) {
            setErr(`Fork failed: ${e}`);
          }
        }}
      />
      <div className="chat-input-wrap">
        {recalled.length > 0 && (
          <div className="recall-pill">
            <span className="recall-icon">⚡</span>
            Recalled {recalled.length} memor{recalled.length === 1 ? "y" : "ies"} for this turn
          </div>
        )}
        {err && <div className="error-bar" role="alert">{err}</div>}

        {/* Agent mode toggle */}
        <div className="agent-toolbar">
          <div className="export-menu-wrap" style={{ position: "relative", display: "inline-block" }}>
            <button
              data-testid="export-btn"
              className="agent-toggle"
              disabled={!conversation || messages.length === 0}
              onClick={() => setShowExportMenu((v) => !v)}
              title="Export conversation as Markdown"
              aria-haspopup="menu"
              aria-expanded={showExportMenu}
            >
              ⤓ Export ▾
            </button>
            {showExportMenu && conversation && (
              <div
                role="menu"
                className="export-menu"
                data-testid="export-menu"
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  zIndex: 100,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 4,
                  minWidth: 180,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  marginTop: 2,
                }}
                onMouseLeave={() => setShowExportMenu(false)}
              >
                {(["plain", "detailed"] as ExportMode[]).map((mode) => (
                  <button
                    key={mode}
                    role="menuitem"
                    data-testid={`export-${mode}`}
                    className="agent-toggle"
                    style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent" }}
                    onClick={() => {
                      const md = conversationToMarkdown(conversation, messages, mode);
                      const suffix = mode === "detailed" ? "detailed" : undefined;
                      downloadText(md, safeFilename(conversation.title, "md", suffix));
                      setShowExportMenu(false);
                    }}
                  >
                    {mode === "plain" ? "Plain Markdown" : "Detailed Markdown"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="agent-toggle"
            onClick={() => setShowToolHistory((v) => !v)}
            disabled={messages.length === 0}
            title="Tool call history"
          >
            ⌖ Tools
          </button>
          <button
            data-testid="agent-toggle"
            className={`agent-toggle ${agentMode ? "active" : ""}`}
            onClick={() => setAgentMode((v) => !v)}
            disabled={isWorking || !agentAvailable}
            title={agentAvailable ? "Toggle agent mode (tool calling)" : "Agent mode requires the Ollama or MLX backend"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
            Agent
          </button>
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
              onClick={() => setShowAgentSettings((v) => !v)}
              disabled={isWorking}
              title="Agent settings"
              aria-label="Agent settings"
              aria-expanded={showAgentSettings}
            >
              ⚙
            </button>
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

        {agentMode && showAgentSettings && (
          <div className="agent-settings" data-testid="agent-settings-panel">
            <div className="agent-settings-row">
              <span className="agent-settings-label">Workspace:</span>
              <code className="agent-settings-value">{workspaceRoot ?? "(full filesystem)"}</code>
              <button className="agent-settings-btn" onClick={chooseWorkspace}>Set…</button>
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
              <button className="agent-settings-btn" onClick={checkUpdates}>Check now</button>
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
        )}

        <ChatInput
          disabled={!status?.running}
          onSend={send}
          onAbort={abort}
          streaming={isWorking}
          currentModel={status?.running ? status.model : null}
        />
      </div>

      {showToolHistory && (
        <ToolHistory messages={messages} onClose={() => setShowToolHistory(false)} />
      )}

      {askUser.askUserReq && (
        <div className="agent-confirm-overlay" onClick={(e) => e.target === e.currentTarget && askUser.cancelAskUser()}>
          <div className="agent-confirm-box" role="dialog" aria-modal="true" aria-label="Agent question">
            <div className="agent-confirm-title">Agent asks:</div>
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
            <div className="agent-confirm-actions">
              <button className="agent-confirm-deny" onClick={askUser.cancelAskUser}>Cancel</button>
              <button className="agent-confirm-allow" onClick={askUser.submitAskUser} disabled={!askUser.askUserAnswer.trim()}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit-and-retry modal */}
      {editState && (
        <div
          className="agent-confirm-overlay"
          data-testid="edit-message-modal"
          onClick={(e) => e.target === e.currentTarget && setEditState(null)}
        >
          <div className="agent-confirm-box" role="dialog" aria-modal="true" aria-label="Edit message">
            <div className="agent-confirm-title">Edit message</div>
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
            <div className="agent-confirm-actions">
              <button className="agent-confirm-deny" onClick={() => setEditState(null)}>Cancel</button>
              <button
                data-testid="edit-message-submit"
                className="agent-confirm-allow"
                onClick={submitEdit}
                disabled={!editState.text.trim()}
              >
                Resend
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Citation open confirmation — shows the resolved absolute path so the
          user sees exactly which file an untrusted model is asking to open. */}
      {citation.citationConfirm && (
        <div
          className="agent-confirm-overlay"
          data-testid="citation-confirm-modal"
          onClick={(e) => e.target === e.currentTarget && citation.dismissConfirm()}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); citation.dismissConfirm(); } }}
        >
          <div className="agent-confirm-box" role="dialog" aria-modal="true" aria-label="Open file in editor">
            <div className="agent-confirm-title">Open file in editor?</div>
            <div style={{ padding: "8px 0", fontSize: 12, color: "var(--text-muted)" }}>
              This citation was written by the model. It will open in an external editor:
            </div>
            <pre className="agent-confirm-args">
              {citation.citationConfirm.resolved}{citation.citationConfirm.line ? `:${citation.citationConfirm.line}` : ""}
            </pre>
            <div className="agent-confirm-actions">
              <button
                className="agent-confirm-deny"
                onClick={citation.dismissConfirm}
              >
                Cancel
              </button>
              <button
                data-testid="citation-confirm-allow"
                className="agent-confirm-allow"
                onClick={citation.confirmOpen}
              >
                Open
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tool confirmation modal */}
      {confirmState && (
        <div
          className="agent-confirm-overlay"
          data-testid="agent-confirm-modal"
          onClick={(e) => e.target === e.currentTarget && handleConfirm(false)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); handleConfirm(false); } }}
        >
          <div
            className={`agent-confirm-box risk-${confirmState.risk}`}
            role="dialog"
            aria-modal="true"
            aria-label={`Confirm tool ${confirmState.toolName}`}
          >
            <div className="agent-confirm-title">
              Allow <code>{confirmState.toolName}</code>?
              {confirmState.risk !== "normal" && (
                <span className={`agent-risk-badge risk-${confirmState.risk}`}>
                  {confirmState.risk}
                </span>
              )}
            </div>
            {confirmState.risk === "destructive" && (
              <>
                <div className="agent-risk-warning">
                  ⚠ This action matches a known destructive pattern. Read it carefully before approving.
                </div>
                <label className="agent-confirm-remember" style={{ color: "#fca5a5" }}>
                  <input
                    type="checkbox"
                    checked={destructiveAck}
                    onChange={(e) => setDestructiveAck(e.target.checked)}
                  />
                  I have read this and accept the consequences
                </label>
              </>
            )}
            <pre className="agent-confirm-args">
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
            <div className="agent-confirm-actions">
              <button data-testid="agent-confirm-deny" className="agent-confirm-deny" onClick={() => handleConfirm(false)}>Deny</button>
              <button
                data-testid="agent-confirm-allow"
                className="agent-confirm-allow"
                onClick={() => handleConfirm(true)}
                disabled={confirmState.risk === "destructive" && !destructiveAck}
              >
                Allow
              </button>
            </div>
          </div>
        </div>
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
