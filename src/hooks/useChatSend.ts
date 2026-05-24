import { useCallback, useRef } from "react";
import { api } from "../lib/tauri-api";
import { streamChat } from "../lib/mlx-client";
import { streamNativeChat } from "../lib/native-client";
import { runAgentLoop, cancelActiveShell } from "../lib/agent-loop";
import type { AgentMetrics, AgentStatus, ConfirmDecision } from "../lib/agent-loop";
import type { ChatImage, Conversation, ConversationParams, Memory, Message, ProjectPolicy, ServerStatus } from "../types";
import {
  getMemoryMode,
  recall,
  formatRecallBlock,
  extractFacts,
  saveMemory,
} from "../lib/memory-client";
import { logDiag } from "../lib/diagnostics";
import { formatUserProfile } from "../lib/user-profile";
import type { AgentSettings } from "./useAgentSettings";
import { useEvent } from "./useEvent";
import type { AppSettings } from "../types";
import { listen } from "@tauri-apps/api/event";

function tmpKey(): string {
  return `tmp:${crypto.randomUUID()}`;
}

// ── Settings cache for per-send reads ────────────────────────────────────
//
// Code review M5: streaming a send used to round-trip the entire settings
// blob just to read user_profile. Cache it lazily + invalidate when the
// settings IPC fires a `settings-changed` event after a successful save.
// Cache miss on first send is fine — the IPC is local + cheap, just not
// cheap enough to repeat every keystroke-driven message.

let cachedSettings: AppSettings | null = null;
let cacheInFlight: Promise<AppSettings> | null = null;
let invalidatorBound = false;

async function getCachedSettings(): Promise<AppSettings> {
  if (cachedSettings) return cachedSettings;
  if (cacheInFlight) return cacheInFlight;
  cacheInFlight = api
    .settingsGet()
    .then((s) => {
      cachedSettings = s;
      cacheInFlight = null;
      return s;
    })
    .catch((err) => {
      cacheInFlight = null;
      throw err;
    });
  if (!invalidatorBound) {
    invalidatorBound = true;
    // Settings IPC emits this event after a successful settings_set.
    // Drop the cache so the next read goes to disk again.
    listen("settings-changed", () => {
      cachedSettings = null;
    }).catch(() => {
      // Listener registration failure is non-fatal — worst case we hold
      // a stale About You block until app restart.
    });
  }
  return cacheInFlight;
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

export interface ChatSendConfig {
  status: ServerStatus | null;
  agentMode: boolean;
  agentAvailable: boolean;
  workspaceRoot: string | null;
  projectPolicy: ProjectPolicy | null;
  convParams: ConversationParams;
  agent: AgentSettings;
  messages: Message[];
  /** Resolves the active conversation, creating one lazily if needed. */
  ensureConversation: () => Promise<Conversation>;
  /** Ref to the currently-displayed conversation — used to gate stale streams. */
  convRef: React.MutableRefObject<Conversation | null>;
  requestConfirmation: (
    toolName: string,
    args: Record<string, unknown>,
    risk: string,
  ) => Promise<ConfirmDecision>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setStreaming: (v: string | undefined) => void;
  setErr: (v: string | null) => void;
  setRecalled: (v: Memory[]) => void;
  setAgentStatus: (v: AgentStatus) => void;
  setAgentMetrics: (v: AgentMetrics | null) => void;
  onMemoriesChanged?: () => void;
}

export interface ChatSend {
  /** Normal send from the composer — optional pasted/attached images. */
  send: (text: string, images?: ChatImage[]) => Promise<void>;
  /** Regenerate / edit-and-retry resend with an explicit truncated history. */
  resend: (text: string, priorHistory: Message[]) => Promise<void>;
  /** Abort the in-flight stream / agent run + any active shell. */
  abort: () => void;
}

/**
 * Owns the streaming + agent-dispatch send pipeline extracted from ChatWindow.
 * The returned `send`/`resend`/`abort` callbacks have stable identity (via
 * `useEvent`) yet always observe the latest config, which removes the need for
 * the disabled exhaustive-deps lint on the old `send` useCallback.
 */
export function useChatSend(config: ChatSendConfig): ChatSend {
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Core send: persist the user turn, recall memories, stream the response
   * (agent loop or plain streaming) and persist the assistant turn.
   *
   * `priorHistory`, when supplied, overrides the React closure's `messages` —
   * the regenerate/edit callers have already truncated the message list but
   * those updates aren't visible here via the closure yet. Passing the truth
   * explicitly avoids dup'd user messages and stale-history pollution.
   */
  const runSend = useEvent(async (
    text: string,
    images?: ChatImage[],
    priorHistory?: Message[],
  ): Promise<void> => {
    const {
      status, agentMode, agentAvailable, workspaceRoot, projectPolicy,
      convParams, agent, messages, ensureConversation, convRef,
      requestConfirmation, setMessages, setStreaming, setErr, setRecalled,
      setAgentStatus, setAgentMetrics, onMemoriesChanged,
    } = config;

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
    // Cancel any in-flight shell tied to the PREVIOUS controller's signal
    // (each agent loop keys its active-shell entry by its own AbortSignal,
    // so passing the prior signal targets the correct loop's shell).
    const prevSignal = abortRef.current?.signal;
    abortRef.current?.abort();
    if (prevSignal) cancelActiveShell(prevSignal);
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
    // "About You" profile — the user-authored identity block. Injected here so
    // it reaches both plain chat and agent mode (both consume `historyForApi`).
    // A failed settings read just omits the block; chat proceeds normally.
    //
    // Code review M5: previously called api.settingsGet() on every send,
    // round-tripping the entire settings blob just to read user_profile.
    // Cached for the lifetime of the module + invalidated by a global
    // `settings-changed` event the settings IPC fires after settings_set.
    try {
      const settings = await getCachedSettings();
      const profileBlock = formatUserProfile(settings?.user_profile);
      if (profileBlock) {
        systemPreamble.push({
          _tmpKey: tmpKey(),
          conversation_id: conv.id,
          role: "system",
          content: profileBlock,
        });
      }
    } catch (err) {
      logDiag({
        level: "warn",
        source: "user-profile",
        message: "settingsGet() failed — sending without the About You profile",
        detail: err,
      });
    }
    // Per-conversation system prompt — prepended as its own system message so
    // it composes with (rather than replaces) the identity preamble. Unset =
    // no extra message, exactly as before.
    if (convParams.system_prompt) {
      systemPreamble.push({
        _tmpKey: tmpKey(),
        conversation_id: conv.id,
        role: "system",
        content: convParams.system_prompt,
      });
    }
    if (recallBlock) {
      systemPreamble.push({ _tmpKey: tmpKey(), conversation_id: conv.id, role: "system", content: recallBlock });
    }
    const historyForApi: Message[] = [...systemPreamble, ...baseHistory];

    // Numeric params threaded into the backend request. The system prompt is
    // already injected above, so only the numeric fields go to the clients.
    const chatParams = {
      temperature: convParams.temperature,
      top_p: convParams.top_p,
      max_tokens: convParams.max_tokens,
    };

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
          // Code review H4: an in-flight rAF callback can fire AFTER the
          // user aborts and starts the next send, landing a stale
          // pre-abort snapshot on the new conversation's message list.
          // Skip the setMessages if either the conversation has moved or
          // this send's controller was aborted.
          if (ctrl.signal.aborted) return;
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
          params: chatParams,
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
          // Persist final assistant response to DB and assign id to message in
          // state. Strictly gate BOTH the persistence-driven setMessages AND
          // the addMessage-result handling on isStreamConvActive(): if the
          // user navigated to a different conversation mid-run, the message
          // must still be saved to the DB under the original conversation_id
          // but must NOT appear in the now-active conversation's UI buffer.
          if (!isStreamConvActive()) {
            // Fire-and-forget DB persistence under the original conv id.
            api.addMessage(conv.id, "assistant", finalText, status.model).catch((err) =>
              logDiag({
                level: "warn",
                source: "agent-loop",
                message: "background addMessage (stale conv) failed",
                detail: err,
              }),
            );
          } else {
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
        ? streamNativeChat(historyForApi, {
            signal: ctrl.signal,
            temperature: chatParams.temperature ?? undefined,
            top_p: chatParams.top_p ?? undefined,
            maxTokens: chatParams.max_tokens ?? undefined,
          })
        : streamChat(status, historyForApi, {
            signal: ctrl.signal,
            temperature: chatParams.temperature ?? undefined,
            topP: chatParams.top_p ?? undefined,
            maxTokens: chatParams.max_tokens ?? undefined,
          });
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
      // Persist `acc` cleanly to the DB — never with a UI-only suffix like
      // "[stopped]". On reload + regen/edit, history sent to the model must
      // be the raw assistant text, not editorial markers. The suffix is
      // applied to the in-memory message we render (displayContent) so the
      // user still sees that the stream was interrupted.
      const displayContent = aborted ? acc + "\n\n[stopped]" : acc;
      const asst: Message = {
        _tmpKey: tmpKey(),
        conversation_id: conv.id,
        role: "assistant",
        content: displayContent,
        model: status.model,
      };
      // Strict same-conv gate: if the user switched conversations mid-stream
      // the assistant turn STILL gets persisted under its original
      // conversation_id, but it must not be appended to the now-active
      // conversation's UI buffer. We persist fire-and-forget in that case.
      if (!sameConv()) {
        api.addMessage(conv.id, "assistant", acc, status.model).catch((err) =>
          logDiag({
            level: "warn",
            source: "chat-stream",
            message: "background addMessage (stale conv) failed",
            detail: err,
          }),
        );
      } else {
        try {
          const id = await api.addMessage(conv.id, "assistant", acc, status.model);
          asst.id = id;
        } catch (e) {
          if (sameConv()) setErr(`Failed to save response: ${e}`);
        }
        if (sameConv()) setMessages((m) => [...m, asst]);
      }

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
      if (!sameConv()) {
        api.addMessage(conv.id, "assistant", tombstone.content, status.model).catch((err) =>
          logDiag({
            level: "warn",
            source: "chat-window",
            message: "background addMessage tombstone (stale conv) failed",
            detail: err,
          }),
        );
      } else {
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
  });

  const send = useCallback(
    (text: string, images?: ChatImage[]) => runSend(text, images),
    [runSend],
  );
  const resend = useCallback(
    (text: string, priorHistory: Message[]) => runSend(text, undefined, priorHistory),
    [runSend],
  );
  const abort = useCallback(() => {
    // Key cancelActiveShell by the current loop's AbortSignal so we cancel
    // THIS loop's shell, not whichever happened to be set last in a
    // module-singleton (the old race-prone behaviour).
    const sig = abortRef.current?.signal ?? null;
    cancelActiveShell(sig);
    abortRef.current?.abort();
  }, []);

  return { send, resend, abort };
}
