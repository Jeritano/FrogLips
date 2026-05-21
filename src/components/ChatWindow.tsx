import { lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri-api";
import { streamChat } from "../lib/mlx-client";
import { streamNativeChat } from "../lib/native-client";
import type { AskUserRequest } from "../types";
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

function loadDryRun(): boolean {
  try {
    return localStorage.getItem("agent.dryRun") === "true";
  } catch { return false; }
}
function saveDryRun(v: boolean) {
  try { localStorage.setItem("agent.dryRun", v ? "true" : "false"); } catch (err) {
    logDiag({
      level: "warn",
      source: "chat-window",
      message: "saveDryRun: localStorage write failed",
      detail: err,
    });
  }
}

function tmpKey(): string {
  return `tmp:${crypto.randomUUID()}`;
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
  const [allowlist, setAllowlist] = useState<string[]>(() => loadAllowlist());
  const [approveAllShell, setApproveAllShell] = useState(false);
  const [approveAllWrite, setApproveAllWrite] = useState(false);
  const [dryRun, setDryRun] = useState<boolean>(() => loadDryRun());
  const [approvedShellPrefixes, setApprovedShellPrefixes] = useState<string[]>([]);
  const [agentMetrics, setAgentMetrics] = useState<AgentMetrics | null>(null);
  const [rememberPrefix, setRememberPrefix] = useState(false);
  const [destructiveAck, setDestructiveAck] = useState(false);
  const [showToolHistory, setShowToolHistory] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [askUserReq, setAskUserReq] = useState<AskUserRequest | null>(null);
  const [askUserAnswer, setAskUserAnswer] = useState("");
  const [presets, setPresets] = useState<AgentPreset[]>(() => loadAllPresets());
  const [activePresetId, setActivePresetIdState] = useState<string>(() => getActivePresetId());
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [projectPolicy, setProjectPolicy] = useState<ProjectPolicy | null>(null);
  const [quickToast, setQuickToast] = useState<{ reply: string; error: string | null } | null>(null);
  const activePreset = presets.find((p) => p.id === activePresetId) ?? presets[0];
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

  // Listen for agent ask_user requests. One modal at a time — if a second
  // request fires before the first resolves, the new one replaces (rare).
  useEffect(() => {
    let off: UnlistenFn | undefined;
    listen<AskUserRequest>("ask-user", (e) => {
      setAskUserReq(e.payload);
      setAskUserAnswer("");
    }).then((fn) => { off = fn; }).catch((err) =>
      logDiag({
        level: "warn",
        source: "chat-window",
        message: "ask-user listener registration failed — modal will not appear",
        detail: err,
      }),
    );
    return () => { if (off) off(); };
  }, []);

  // Quick-prompt result toast. Backend fires `quick-prompt-completed` after
  // a menu-bar prompt finishes; we flash a small "Quick reply ready ↗" chip
  // that the user can click to inspect (or just dismiss). Auto-clears after
  // 8s so it doesn't linger forever.
  useEffect(() => {
    let off: UnlistenFn | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    listen<{ reply: string; error: string | null }>("quick-prompt-completed", (e) => {
      const payload = e.payload;
      setQuickToast({ reply: payload.reply ?? "", error: payload.error ?? null });
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => setQuickToast(null), 8000);
    }).then((fn) => { off = fn; }).catch((err) =>
      logDiag({
        level: "warn",
        source: "chat-window",
        message: "quick-prompt-completed listener registration failed",
        detail: err,
      }),
    );
    return () => {
      if (off) off();
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  async function submitAskUser() {
    if (!askUserReq) return;
    const id = askUserReq.id;
    const answer = askUserAnswer.trim();
    setAskUserReq(null);
    setAskUserAnswer("");
    try { await api.agentAskUserReply(id, answer); }
    catch (e) { setErr(`ask_user reply failed: ${e}`); }
  }

  async function cancelAskUser() {
    if (!askUserReq) return;
    const id = askUserReq.id;
    setAskUserReq(null);
    setAskUserAnswer("");
    try { await api.agentAskUserCancel(id); } catch (err) {
      logDiag({
        level: "info",
        source: "chat-window",
        message: `cancelAskUser: backend cancel failed for ${id} (may have already resolved)`,
        detail: err,
      });
    }
  }

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
   * Send a user message and stream the response.
   *
   * `priorHistory` overrides the React closure's `messages` when regenerating —
   * the caller will have already mutated `messages` (e.g. removing the prior
   * user/assistant pair) but those updates aren't visible to this function via
   * the closure yet. Passing the truth explicitly avoids dup'd user messages
   * and stale-history pollution.
   */
  async function send(text: string, imagesOrPriorHistory?: ChatImage[] | Message[], priorHistoryArg?: Message[]) {
    // Overload-style dispatch: ChatInput passes images as the 2nd arg, the
    // regenerate path passes priorHistory. Distinguish by shape — Message
    // objects have a `role` field, ChatImage objects have `base64`.
    let images: ChatImage[] | undefined;
    let priorHistory: Message[] | undefined = priorHistoryArg;
    if (Array.isArray(imagesOrPriorHistory) && imagesOrPriorHistory.length > 0) {
      const first = imagesOrPriorHistory[0] as unknown as Record<string, unknown>;
      if ("base64" in first) {
        images = imagesOrPriorHistory as ChatImage[];
      } else {
        priorHistory = imagesOrPriorHistory as Message[];
      }
    }
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

    // Recall memories
    let recallBlock: string | null = null;
    let recallHits: Memory[] = [];
    if (mode !== "off") {
      try {
        recallHits = await recall(text, 5, { cwd: workspaceRoot, convId: conv.id });
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
          projectPolicy,
          systemPromptOverride: activePreset?.systemPromptOverride,
          toolAllowlist: effectiveAllowlist,
          approveAllShell,
          approveAllWrite,
          dryRun,
          approvedShellPrefixes,
          onApproveShellPrefix: (p) => {
            setApprovedShellPrefixes((prev) => (prev.includes(p) ? prev : [...prev, p]));
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
                } catch (err) {
                  logDiag({
                    level: "warn",
                    source: "memory-extract",
                    message: "agent-mode saveMemory failed for an extracted fact",
                    detail: err,
                  });
                }
              }
              if (added > 0) onMemoriesChanged?.();
            }).catch((err) =>
              logDiag({
                level: "warn",
                source: "memory-extract",
                message: "agent-mode extractFacts pipeline rejected",
                detail: err,
              }),
            );
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
        setErr(String(e));
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
            } catch (err) {
              logDiag({
                level: "warn",
                source: "memory-extract",
                message: "chat saveMemory failed for an extracted fact",
                detail: err,
              });
            }
          }
          if (added > 0) onMemoriesChanged?.();
        }).catch((err) =>
          logDiag({
            level: "warn",
            source: "memory-extract",
            message: "chat extractFacts pipeline rejected",
            detail: err,
          }),
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

  function abort() {
    cancelActiveShell();
    abortRef.current?.abort();
  }

  const isWorking = streaming !== undefined || agentStatus === "thinking" || agentStatus === "tool";
  const agentAvailable = status?.backend === "ollama";

  // Stable handler identity for MessageRow's React.memo. The closure always
  // sees the latest state via a ref-style indirection: we refresh the inner
  // fn on every render and expose a thin wrapper that delegates to it.
  const handleRegenerateRef = useRef<(() => void | Promise<void>) | null>(null);
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
    await send(userText, truncated);
  };
  const onRegenerate = useCallback(() => handleRegenerateRef.current?.(), []);

  // Citation chip click handler — event-delegated at the chat-window root.
  // `.citation-chip` anchors are emitted by the markdown post-processor with
  // data-path and (optional) data-line attributes. We intercept the click,
  // resolve to a Tauri command, and toast the resulting editor.
  const onCitationClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const chip = target.closest(".citation-chip") as HTMLAnchorElement | null;
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    const path = chip.getAttribute("data-path") ?? "";
    const lineRaw = chip.getAttribute("data-line");
    const line = lineRaw ? Number(lineRaw) : undefined;
    if (!path) return;
    api.agentOpenPathInEditor(path, line)
      .then((prog) => {
        const label = prog === "code" ? "VS Code"
          : prog === "cursor" ? "Cursor"
          : "default app";
        setUpdateMsg(`Opened in ${label}`);
        setTimeout(
          () => setUpdateMsg((m) => (m && m.startsWith("Opened") ? null : m)),
          2200,
        );
      })
      .catch((err2) => setErr(`Open failed: ${err2}`));
  }, []);

  return (
    <div className="chat-window" onClick={onCitationClick}>
      {agentMode && dryRun && (
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
        {err && <div className="error-bar">{err}</div>}

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
            title={agentAvailable ? "Toggle agent mode (tool calling)" : "Agent mode requires Ollama backend"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
            Agent
          </button>
          {agentMode && (
            <select
              data-testid="agent-preset-select"
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
              data-testid="agent-settings-gear"
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
              <span className="agent-settings-label">Safety:</span>
              <label data-testid="agent-dry-run-toggle">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(e) => {
                    setDryRun(e.target.checked);
                    saveDryRun(e.target.checked);
                  }}
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

      {askUserReq && (
        <div className="agent-confirm-overlay" onClick={(e) => e.target === e.currentTarget && cancelAskUser()}>
          <div className="agent-confirm-box">
            <div className="agent-confirm-title">Agent asks:</div>
            <div style={{ padding: "8px 0", fontSize: 13 }}>{askUserReq.question}</div>
            {askUserReq.hint && (
              <div style={{ padding: "0 0 8px 0", fontSize: 11, color: "var(--text-muted)" }}>{askUserReq.hint}</div>
            )}
            <textarea
              className="ask-user-input"
              value={askUserAnswer}
              onChange={(e) => setAskUserAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitAskUser();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelAskUser();
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
              <button className="agent-confirm-deny" onClick={cancelAskUser}>Cancel</button>
              <button className="agent-confirm-allow" onClick={submitAskUser} disabled={!askUserAnswer.trim()}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tool confirmation modal */}
      {confirmState && (
        <div className="agent-confirm-overlay" data-testid="agent-confirm-modal" onClick={(e) => e.target === e.currentTarget && handleConfirm(false)}>
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

      {quickToast && (
        <div
          className="quick-toast"
          data-testid="quick-prompt-toast"
          role="button"
          tabIndex={0}
          onClick={() => {
            if (quickToast.error) { setQuickToast(null); return; }
            // Click → dump the reply into the input area as a starting point.
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
            setQuickToast(null);
          }}
        >
          {quickToast.error ? (
            <span>Quick prompt failed: {quickToast.error}</span>
          ) : (
            <span>Quick reply ready ↗ <em style={{ color: "var(--text-muted)", fontStyle: "normal" }}>(click to copy)</em></span>
          )}
        </div>
      )}
    </div>
  );
}
