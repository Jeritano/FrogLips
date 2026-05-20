import { useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import { streamChat } from "../lib/mlx-client";
import { runAgentLoop, cancelActiveShell } from "../lib/agent-loop";
import type { AgentMetrics, AgentStatus, ConfirmDecision } from "../lib/agent-loop";
import {
  loadAllPresets,
  getActivePresetId,
  setActivePresetId,
} from "../lib/agent-presets";
import type { AgentPreset } from "../lib/agent-presets";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Conversation, Memory, Message, ServerStatus } from "../types";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { ToolHistory } from "./ToolHistory";
import { conversationToMarkdown, downloadText, safeFilename } from "../lib/export";
import {
  getMemoryMode,
  recall,
  formatRecallBlock,
  extractFacts,
  saveMemory,
} from "../lib/memory-client";

interface Props {
  status: ServerStatus | null;
  conversation: Conversation | null;
  onConversationCreated: (c: Conversation) => void;
  onMemoriesChanged?: () => void;
}

interface ConfirmState {
  toolName: string;
  args: Record<string, unknown>;
  risk: string;
}

const ALL_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "search_files",
  "file_exists",
  "run_shell",
  "write_file",
  "edit_file",
] as const;

function loadAllowlist(): string[] {
  try {
    const raw = localStorage.getItem("agent.allowlist");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
  } catch { return []; }
}
function saveAllowlist(list: string[]) {
  localStorage.setItem("agent.allowlist", JSON.stringify(list));
}

function tmpKey(): string {
  return `tmp:${crypto.randomUUID()}`;
}

export function ChatWindow({ status, conversation, onConversationCreated, onMemoriesChanged }: Props) {
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
  const [allowlist, setAllowlist] = useState<string[]>(() => loadAllowlist());
  const [approveAllShell, setApproveAllShell] = useState(false);
  const [approveAllWrite, setApproveAllWrite] = useState(false);
  const [approvedShellPrefixes, setApprovedShellPrefixes] = useState<string[]>([]);
  const [agentMetrics, setAgentMetrics] = useState<AgentMetrics | null>(null);
  const [rememberPrefix, setRememberPrefix] = useState(false);
  const [showToolHistory, setShowToolHistory] = useState(false);
  const [presets, setPresets] = useState<AgentPreset[]>(() => loadAllPresets());
  const [activePresetId, setActivePresetIdState] = useState<string>(() => getActivePresetId());
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const activePreset = presets.find((p) => p.id === activePresetId) ?? presets[0];
  const abortRef = useRef<AbortController | null>(null);
  const creatingConvRef = useRef<Promise<Conversation> | null>(null);
  const convRef = useRef<Conversation | null>(null);
  const confirmResolveRef = useRef<((v: ConfirmDecision) => void) | null>(null);

  useEffect(() => {
    api.agentGetWorkspace().then(setWorkspaceRoot).catch(() => {});
  }, []);

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
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmState({ toolName, args, risk });
    });
  }

  async function chooseWorkspace() {
    setWorkspaceErr(null);
    const path = window.prompt(
      "Workspace root (agent confined to this dir; blank = full FS):",
      workspaceRoot ?? "",
    );
    if (path === null) return;
    try {
      const set = await api.agentSetWorkspace(path.trim() || null);
      setWorkspaceRoot(set);
    } catch (e) {
      setWorkspaceErr(String(e));
    }
  }

  function toggleAllowed(name: string) {
    setAllowlist((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      saveAllowlist(next);
      return next;
    });
  }

  function selectPreset(id: string) {
    setActivePresetIdState(id);
    setActivePresetId(id);
    setPresets(loadAllPresets());
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
    const remember = approved && rememberPrefix;
    setConfirmState(null);
    setRememberPrefix(false);
    confirmResolveRef.current?.({ approve: approved, remember });
    confirmResolveRef.current = null;
  }

  /* ── Send ── */

  async function send(text: string) {
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
    };
    let userId: number;
    try {
      userId = await api.addMessage(conv.id, "user", text);
    } catch (e) {
      setErr(`Failed to save message: ${e}`);
      return;
    }
    userMsg.id = userId;
    const baseHistory = [...messages, userMsg];
    const streamConvId = conv.id;
    const isStreamConvActive = () => convRef.current?.id === streamConvId;
    if (isStreamConvActive()) setMessages(baseHistory);

    // Recall memories
    let recallBlock: string | null = null;
    let recallHits: Memory[] = [];
    if (mode !== "off") {
      try {
        recallHits = await recall(text, 5);
        recallBlock = formatRecallBlock(recallHits);
        if (isStreamConvActive()) setRecalled(recallHits);
        if (recallHits.length > 0) {
          api.touchMemories(recallHits.map((m) => m.id)).catch(() => {});
        }
      } catch {/* recall is best-effort */}
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
      { conversation_id: conv.id, role: "system", content: identityPrompt },
    ];
    if (recallBlock) {
      systemPreamble.push({ conversation_id: conv.id, role: "system", content: recallBlock });
    }
    const historyForApi: Message[] = [...systemPreamble, ...baseHistory];

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    /* ── Agent mode ── */
    if (agentMode && status.backend === "ollama") {
      if (isStreamConvActive()) setAgentStatus("thinking");
      try {
        setAgentMetrics(null);
        // Preset's allowedTools wins when non-empty; otherwise fall back to manual allowlist
        const effectiveAllowlist =
          activePreset && activePreset.allowedTools.length > 0 ? activePreset.allowedTools : allowlist;
        const finalText = await runAgentLoop({
          model: status.model,
          messages: historyForApi,
          conversationId: conv.id,
          workspaceRoot,
          systemPromptOverride: activePreset?.systemPromptOverride,
          toolAllowlist: effectiveAllowlist,
          approveAllShell,
          approveAllWrite,
          approvedShellPrefixes,
          onApproveShellPrefix: (p) => {
            setApprovedShellPrefixes((prev) => (prev.includes(p) ? prev : [...prev, p]));
          },
          onUpdate: (msgs) => {
            if (isStreamConvActive()) {
              setMessages(msgs.filter((m) => m.role !== "system"));
            }
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
            extractFacts(text, finalText, conv.id).then(async (facts) => {
              if (!facts.length) return;
              let added = 0;
              for (const f of facts) {
                try {
                  const r = await saveMemory({
                    content: f.fact,
                    conversationId: conv.id,
                    tags: mode === "queue" ? "auto,pending" : "auto",
                    status: mode === "queue" ? "pending" : "active",
                  });
                  if (!r.deduped) added++;
                } catch {/* ignore */}
              }
              if (added > 0) onMemoriesChanged?.();
            }).catch(() => {});
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted && isStreamConvActive()) {
          setErr(String(e));
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
    try {
      for await (const chunk of streamChat(status, historyForApi, { signal: ctrl.signal })) {
        if (chunk.done) break;
        acc += chunk.delta;
        if (acc.length > ACC_MAX) {
          ctrl.abort();
          break;
        }
        if (isStreamConvActive()) setStreaming(acc);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        aborted = true;
      } else if (isStreamConvActive()) {
        setErr(String(e));
      }
    } finally {
      abortRef.current = null;
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
        extractFacts(text, acc, conv.id).then(async (facts) => {
          if (!facts.length) return;
          let added = 0;
          for (const f of facts) {
            try {
              const r = await saveMemory({
                content: f.fact,
                conversationId: conv.id,
                tags: mode === "queue" ? "auto,pending" : "auto",
                status: mode === "queue" ? "pending" : "active",
              });
              if (!r.deduped) added++;
            } catch {/* ignore individual failures */}
          }
          if (added > 0) onMemoriesChanged?.();
        }).catch(() => {});
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
      } catch {/* best effort */}
      if (sameConv()) setMessages((m) => [...m, tombstone]);
    }
  }

  function abort() {
    cancelActiveShell();
    abortRef.current?.abort();
  }

  const isWorking = streaming !== undefined || agentStatus === "thinking" || agentStatus === "tool";
  const agentAvailable = status?.backend === "ollama";

  return (
    <div className="chat-window">
      <MessageList
        messages={messages}
        streaming={streaming}
        conversationId={conversation?.id ?? null}
        currentModel={status?.running ? status.model : null}
        agentStatus={agentStatus}
        onRegenerate={async () => {
          // Pop the last assistant message and resend the last user message
          if (isWorking || !conversation) return;
          let lastUser: Message | undefined;
          let lastAsst: Message | undefined;
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!lastAsst && m.role === "assistant" && !m.tool_calls?.length) lastAsst = m;
            else if (lastAsst && !lastUser && m.role === "user") { lastUser = m; break; }
          }
          if (!lastUser) return;
          // Remove last assistant from DB + state
          if (lastAsst?.id) {
            try { await api.deleteMessage(lastAsst.id); } catch {/* best effort */}
          }
          // Also remove from state (last assistant)
          setMessages((ms) => {
            const idx = [...ms].reverse().findIndex((m) => m.role === "assistant" && !m.tool_calls?.length);
            if (idx < 0) return ms;
            return ms.slice(0, ms.length - 1 - idx).concat(ms.slice(ms.length - idx));
          });
          await send(lastUser.content);
        }}
      />
      <div className="chat-input-wrap">
        {recalled.length > 0 && (
          <div className="recall-pill">
            <span className="recall-icon">⚡</span>
            Recalled {recalled.length} memor{recalled.length === 1 ? "y" : "ies"} for this turn
          </div>
        )}
        {err && <div className="error-bar">{err}</div>}

        {/* Agent mode toggle */}
        <div className="agent-toolbar">
          <button
            className="agent-toggle"
            disabled={!conversation || messages.length === 0}
            onClick={() => {
              if (!conversation) return;
              const md = conversationToMarkdown(conversation, messages);
              downloadText(md, safeFilename(conversation.title, "md"));
            }}
            title="Export conversation as Markdown"
          >
            ⤓ Export
          </button>
          <button
            className="agent-toggle"
            onClick={() => setShowToolHistory((v) => !v)}
            disabled={messages.length === 0}
            title="Tool call history"
          >
            ⌖ Tools
          </button>
          <button
            className={`agent-toggle ${agentMode ? "active" : ""}`}
            onClick={() => setAgentMode((v) => !v)}
            disabled={isWorking || !agentAvailable}
            title={agentAvailable ? "Toggle agent mode (tool calling)" : "Agent mode requires Ollama backend"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
            Agent
          </button>
          {agentMode && (
            <select
              className="agent-preset-select"
              value={activePresetId}
              onChange={(e) => selectPreset(e.target.value)}
              disabled={isWorking}
              title={activePreset?.description ?? ""}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          {agentMode && (
            <button
              className="agent-toggle"
              onClick={() => setShowAgentSettings((v) => !v)}
              disabled={isWorking}
              title="Agent settings"
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
          <div className="agent-settings">
            <div className="agent-settings-row">
              <span className="agent-settings-label">Workspace:</span>
              <code className="agent-settings-value">{workspaceRoot ?? "(full filesystem)"}</code>
              <button className="agent-settings-btn" onClick={chooseWorkspace}>Set…</button>
            </div>
            {workspaceErr && <div className="error-bar">{workspaceErr}</div>}
            <div className="agent-settings-row">
              <span className="agent-settings-label">Approve all this session:</span>
              <label>
                <input type="checkbox" checked={approveAllShell}
                       onChange={(e) => setApproveAllShell(e.target.checked)} />
                shell (normal-risk only)
              </label>
              <label>
                <input type="checkbox" checked={approveAllWrite}
                       onChange={(e) => setApproveAllWrite(e.target.checked)} />
                writes/edits
              </label>
            </div>
            <div className="agent-settings-row">
              <span className="agent-settings-label">Allowed tools:</span>
              <span className="agent-settings-hint">
                {allowlist.length === 0 ? "(all enabled)" : `${allowlist.length} selected`}
              </span>
            </div>
            <div className="agent-tool-grid">
              {ALL_TOOL_NAMES.map((n) => {
                const enabled = allowlist.length === 0 || allowlist.includes(n);
                return (
                  <label key={n} className={`agent-tool-pill ${enabled ? "on" : "off"}`}>
                    <input type="checkbox" checked={enabled}
                           onChange={() => toggleAllowed(n)} />
                    {n}
                  </label>
                );
              })}
            </div>
            {allowlist.length > 0 && (
              <button className="agent-settings-btn" onClick={() => { setAllowlist([]); saveAllowlist([]); }}>
                Reset to all enabled
              </button>
            )}
            {approvedShellPrefixes.length > 0 && (
              <div className="agent-settings-row">
                <span className="agent-settings-label">Approved shell prefixes:</span>
                <span className="agent-settings-value">{approvedShellPrefixes.join(", ")}</span>
                <button className="agent-settings-btn" onClick={() => setApprovedShellPrefixes([])}>
                  Clear
                </button>
              </div>
            )}
            <div className="agent-settings-row">
              <span className="agent-settings-label">Updates:</span>
              <button className="agent-settings-btn" onClick={checkUpdates}>Check now</button>
              {updateMsg && <span className="agent-settings-hint">{updateMsg}</span>}
            </div>
          </div>
        )}

        <ChatInput
          disabled={!status?.running}
          onSend={send}
          onAbort={abort}
          streaming={isWorking}
        />
      </div>

      {showToolHistory && (
        <ToolHistory messages={messages} onClose={() => setShowToolHistory(false)} />
      )}

      {/* Tool confirmation modal */}
      {confirmState && (
        <div className="agent-confirm-overlay" onClick={(e) => e.target === e.currentTarget && handleConfirm(false)}>
          <div className={`agent-confirm-box risk-${confirmState.risk}`}>
            <div className="agent-confirm-title">
              Allow <code>{confirmState.toolName}</code>?
              {confirmState.risk !== "normal" && (
                <span className={`agent-risk-badge risk-${confirmState.risk}`}>
                  {confirmState.risk}
                </span>
              )}
            </div>
            {confirmState.risk === "destructive" && (
              <div className="agent-risk-warning">
                ⚠ This command matches a known destructive pattern. Read carefully before approving.
              </div>
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
              <button className="agent-confirm-deny" onClick={() => handleConfirm(false)}>Deny</button>
              <button className="agent-confirm-allow" onClick={() => handleConfirm(true)}>Allow</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
