import { useCallback, useRef } from "react";
import { api } from "../lib/tauri-api";
import { streamChat } from "../lib/mlx-client";
import { streamOllamaPlain } from "../lib/ollama-plain-client";
import {
  prefetchContextLength,
  resolveContextTokens,
} from "../lib/model-context-lookup";
import { streamNativeChat } from "../lib/native-client";
import { streamCustomChat } from "../lib/custom-client";
import {
  inferenceGate,
  shouldBypassInferenceGate,
} from "../lib/inference-gate";
// Perf review M29 (2026-06-09): the agent-loop package (runner + dispatch +
// tools, ~55 KB minified) is the largest first-party block that used to ride
// the boot chunk. Load it on first agent-mode send instead; `import()`
// resolves from the module cache after that. Type imports below are erased
// at compile time and keep nothing eager.
const loadAgentLoop = () => import("../lib/agent-loop");
import { applyContextBudget } from "../lib/agent-loop/context-manager";
import type {
  AgentBackend,
  AgentMetrics,
  AgentStatus,
  ConfirmDecision,
} from "../lib/agent-loop";
import type {
  ChatImage,
  Conversation,
  ConversationParams,
  Memory,
  Message,
  ProjectPolicy,
  ServerStatus,
} from "../types";
import {
  getMemoryMode,
  recall,
  formatRecallBlock,
  extractFacts,
  saveMemory,
} from "../lib/memory-client";
import { logDiag } from "../lib/diagnostics";
import { buildReplyStat, setReplyStat } from "../lib/reply-stats";
import { formatUserProfile } from "../lib/user-profile";
import {
  loadRoutes,
  routeChatMessage,
  type RouteDecision,
} from "../lib/chat-router";
import { loadAllPresets } from "../lib/agent-presets";
import type { AgentSettings } from "./useAgentSettings";
import { useEvent } from "./useEvent";
import type { AppSettings } from "../types";
import { listen } from "@tauri-apps/api/event";

function tmpKey(): string {
  return `tmp:${crypto.randomUUID()}`;
}

/** Resolve the active server backend string to an agent-loop {@link AgentBackend}.
 *  mlx/native/custom/openrouter pass through; everything else (plain ollama and
 *  the ollama `:cloud` tags, which run on the `ollama` backend) maps to ollama. */
function resolveAgentBackend(backend: string | null): AgentBackend {
  return backend === "mlx" ||
    backend === "native" ||
    backend === "custom" ||
    backend === "openrouter"
    ? backend
    : "ollama";
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
  // 2026-05-25 SE review: register the invalidator listener BEFORE
  // kicking off the fetch. The previous fire-and-forget pattern had a
  // race window during boot: a `settings_set` emitted between the
  // settingsGet() resolving and the listen() promise settling would be
  // lost, leaving the cache forever stale until the user reloaded.
  // Now the listener is awaited synchronously on first call so any
  // subsequent settings-changed event is guaranteed to reach us.
  //
  // Code review (low/bug): assign `cacheInFlight` SYNCHRONOUSLY before any
  // await so the in-flight guard atomically covers BOTH the listener bind
  // and the fetch. The previous version awaited listen() while cacheInFlight
  // was still null, so two concurrent first-sends (double-Enter, programmatic
  // resend, StrictMode double-invoke) each passed the unguarded checks above,
  // registering a duplicate (permanent, never-unlistened) listener plus a
  // redundant settings IPC. One shared promise now serializes both entrants.
  cacheInFlight = (async () => {
    if (!invalidatorBound) {
      try {
        await listen("settings-changed", () => {
          cachedSettings = null;
        });
        invalidatorBound = true;
      } catch {
        // Registration failed — leave invalidatorBound=false so the next
        // getCachedSettings() call retries it. The cache will not
        // auto-invalidate this round; the user must navigate away or
        // reload before stale settings flush.
      }
    }
    try {
      const s = await api.settingsGet();
      cachedSettings = s;
      cacheInFlight = null;
      return s;
    } catch (err) {
      cacheInFlight = null;
      throw err;
    }
  })();
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
  signal?: AbortSignal,
) {
  try {
    const facts = await extractFacts(userText, responseText, convId, signal);
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
  /** Auto-route each message to the best-fit configured model (plain chat only). */
  routingEnabled?: boolean;
  /** Fires with the routing decision for a message (null = no route taken). */
  onRouted?: (decision: RouteDecision | null) => void;
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
  // Per-conversation sticky route id (anti-thrash: bias the classifier toward
  // the route already in use so it doesn't flip models turn-to-turn).
  const stickyRouteRef = useRef<Map<number, string | null>>(new Map());

  /**
   * Core send: persist the user turn, recall memories, stream the response
   * (agent loop or plain streaming) and persist the assistant turn.
   *
   * `priorHistory`, when supplied, overrides the React closure's `messages` —
   * the regenerate/edit callers have already truncated the message list but
   * those updates aren't visible here via the closure yet. Passing the truth
   * explicitly avoids dup'd user messages and stale-history pollution.
   */
  const runSend = useEvent(
    async (
      text: string,
      images?: ChatImage[],
      priorHistory?: Message[],
    ): Promise<void> => {
      const {
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
        routingEnabled,
        onRouted,
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
      // Lazy module: if agent-loop never loaded this session, no shell can be
      // running and the import resolves from cache to a no-op call.
      if (prevSignal)
        void loadAgentLoop().then((m) => m.cancelActiveShell(prevSignal));
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // ── Concurrent pre-stream work ──
      // Memory recall and route classification are independent network/compute
      // awaits on the pre-first-token critical path; run them CONCURRENTLY and
      // apply their (synchronous) UI side-effects only AFTER both settle. Each
      // promise swallows its own failure (recall → [], routing → null) so one
      // can't sink the other, and the existing abort checks are preserved below.
      const recallP: Promise<Memory[]> =
        mode !== "off"
          ? recall(
              text,
              5,
              { cwd: workspaceRoot, convId: conv.id },
              ctrl.signal,
            ).catch((err) => {
              logDiag({
                level: "warn",
                source: "memory-recall",
                message:
                  "recall() threw — proceeding without recalled memories",
                detail: err,
              });
              return [] as Memory[];
            })
          : Promise.resolve([] as Memory[]);

      const routes =
        routingEnabled && !(agentMode && agentAvailable) ? loadRoutes() : [];
      const routeP =
        routes.length > 0
          ? routeChatMessage(text, routes, {
              status,
              stickyRouteId: stickyRouteRef.current.get(conv.id) ?? null,
              signal: ctrl.signal,
            }).catch((e) => {
              logDiag({
                level: "warn",
                source: "chat-router",
                message: "routing failed; using active model",
                detail: e,
              });
              return null;
            })
          : Promise.resolve(null);

      const [recallHits, routeDecision] = await Promise.all([recallP, routeP]);

      // Recall side-effects
      let recallBlock: string | null = null;
      if (mode !== "off") {
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
      } else {
        if (isStreamConvActive()) setRecalled([]);
      }

      // ── Multi-model routing (plain chat only in MVP) ──
      // Apply the route decision: maybe swap the model/backend + role for THIS
      // turn. Falls back to the active model on any failure. Agent mode keeps the
      // active model (routing the tool loop is a phased follow-up).
      let effModel: string = status.model;
      let effBackend: string = status.backend ?? "ollama";
      let routePreset: string | null = null;
      if (routes.length > 0) {
        {
          const decision = routeDecision;
          if (decision && !ctrl.signal.aborted) {
            // MVP: ollama loads on demand and custom/openrouter are cloud, so
            // those swap freely. mlx/native can't hot-swap a model without a
            // preload step (phased), so only honor them when they match the
            // already-active model.
            const loadFree =
              decision.backend === "ollama" ||
              decision.backend === "custom" ||
              decision.backend === "openrouter";
            if (loadFree || decision.model === status.model) {
              effModel = decision.model;
              effBackend = decision.backend;
              routePreset = decision.preset;
              // Cap the sticky map (FIFO) so a long session with many
              // conversations can't grow it unbounded.
              if (
                stickyRouteRef.current.size >= 256 &&
                !stickyRouteRef.current.has(conv.id)
              ) {
                const oldest = stickyRouteRef.current.keys().next().value;
                if (oldest !== undefined) stickyRouteRef.current.delete(oldest);
              }
              stickyRouteRef.current.set(conv.id, decision.routeId);
              if (isStreamConvActive()) onRouted?.(decision);
            } else {
              logDiag({
                level: "info",
                source: "chat-router",
                message: `route "${decision.label}" needs a ${decision.backend} model preload; keeping active model (MVP)`,
              });
              if (isStreamConvActive()) onRouted?.(null);
            }
          } else if (isStreamConvActive()) {
            onRouted?.(null);
          }
        }
      } else if (isStreamConvActive()) {
        onRouted?.(null);
      }

      // Authoritative model-identity preamble. Some cloud-routed Ollama tags
      // (e.g. *:cloud) return inconsistent self-identity in reply text — this
      // pins the model to its actual tag so "what model are you?" answers
      // truthfully regardless of the upstream training data.
      const identityPrompt =
        `You are model "${effModel}" running via the ${effBackend} backend on the user's machine. ` +
        `When asked about your identity, name, version, or which model you are, respond with the exact identifier above ("${effModel}"). ` +
        `Do not claim to be GPT, Claude, Gemini, DeepSeek, Kimi, Llama, Qwen, or any other model unless that name appears literally inside "${effModel}". ` +
        `If you genuinely don't know, say "I'm running as ${effModel}; I don't have additional details about my training."`;

      const systemPreamble: Message[] = [
        {
          _tmpKey: tmpKey(),
          conversation_id: conv.id,
          role: "system",
          content: identityPrompt,
        },
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
          message:
            "settingsGet() failed — sending without the About You profile",
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
      // Routed Role: inject the chosen route's preset system prompt (persona /
      // output format) so a "Coder" or "Researcher" route actually behaves like
      // one. Composes with the identity + profile blocks above.
      if (routePreset) {
        const preset = loadAllPresets().find((p) => p.id === routePreset);
        if (preset?.systemPromptOverride) {
          systemPreamble.push({
            _tmpKey: tmpKey(),
            conversation_id: conv.id,
            role: "system",
            content: preset.systemPromptOverride,
          });
        }
      }
      if (recallBlock) {
        systemPreamble.push({
          _tmpKey: tmpKey(),
          conversation_id: conv.id,
          role: "system",
          content: recallBlock,
        });
      }
      const historyForApi: Message[] = [...systemPreamble, ...baseHistory];

      // 2026-05-25 user-reported "model doesn't see history across a stop/start"
      // verification log. Records the full message manifest sent to the model
      // on every send so a reviewer can confirm the prior turns are present
      // in the outbound payload (DB-backed; survives backend stop/start since
      // React state in ChatWindow.tsx:130 is keyed on conversation.id, not
      // on `status.running`). Flushed to BOTH the in-memory ring + disk
      // (~/.local-llm-app/diag.log via append_diag_log) so it's recoverable
      // after a process restart.
      const rolesSummary = historyForApi.map((m) => m.role).join(",");
      const manifestLine = `outbound history conv=${conv.id} msgs=${historyForApi.length} roles=[${rolesSummary}] running=${!!status.running} ready=${!!status.ready}`;
      logDiag({ level: "info", source: "chat-send", message: manifestLine });
      try {
        // Wrapped: api.appendDiagLog is absent in some test mocks. Disk
        // write is best-effort — the in-memory ring above is the canonical
        // record.
        void api
          .appendDiagLog?.(`[chat-send] ${manifestLine}`)
          .catch(() => undefined);
      } catch {
        /* swallow — diag write is observational only */
      }

      // Numeric params threaded into the backend request. The system prompt is
      // already injected above, so only the numeric fields go to the clients.
      const chatParams = {
        temperature: convParams.temperature,
        top_p: convParams.top_p,
        max_tokens: convParams.max_tokens,
      };

      // Inference perf O1/O2 (2026-06-11): resolve ONE context number per
      // local-Ollama model and use it for BOTH the prompt budget and the
      // request's num_ctx. Before this, the budgeter packed prompts for the
      // model's full window while the daemon ran at its own (much smaller)
      // default and silently head-truncated — dropping the system prompt and,
      // in agent mode, the tool schemas. Clamped: /api/show can report
      // 256k-1M windows whose KV would eat the machine. Cached per model.
      const SEND_CTX_CEILING = 65_536;
      const isLocalOllama =
        effBackend === "ollama" && !effModel.endsWith(":cloud");
      let sendCtx: number | undefined;
      if (isLocalOllama) {
        const real =
          (await prefetchContextLength(effModel, status)) ??
          resolveContextTokens(effModel, status);
        sendCtx = Math.min(real, SEND_CTX_CEILING);
      }
      const keepAlive =
        (await getCachedSettings().catch(() => null))?.ollama_keep_alive ??
        "30m";

      // Item 1: apply the configured local-inference permit count before either
      // path acquires a slot. Best-effort — a missing/invalid setting leaves the
      // module default (1) in place. Module singleton, so one set per send is
      // enough for both agent + plain-chat paths.
      {
        const permits = (await getCachedSettings().catch(() => null))
          ?.inference_permits;
        if (typeof permits === "number" && Number.isFinite(permits)) {
          inferenceGate.setPermits(permits);
        }
      }

      /* ── Agent mode ── */
      if (agentMode && agentAvailable) {
        if (isStreamConvActive()) setAgentStatus("thinking");
        // Perf review C1 (2026-06-09): in-flight agent text renders through
        // the same plain-text StreamingMessage path as regular chat. The old
        // design pushed a placeholder Message mutated in place through
        // onUpdate — MessageRow's memo saw identical props every flush, so
        // the bubble FROZE at its first frame while the history memo busted
        // 60×/s for nothing. Now: deltas accumulate here and flush to
        // `setStreaming` once per animation frame (escaped plain text, one
        // markdown parse when the canonical row lands); `onUpdate` is
        // structural-only and retires the bubble in the same flush that
        // lands the message which absorbed its text. Declared outside the
        // try so the finally can tear the bubble down on every exit path.
        let agentAcc = "";
        let accRaf = 0;
        const flushAcc = () => {
          accRaf = 0;
          if (ctrl.signal.aborted) return;
          if (isStreamConvActive()) setStreaming(agentAcc);
        };
        // Item 3: bracket this interactive run so a divergent workspace change
        // mid-run is rejected (WORKSPACE_ROOT is process-global). Best-effort —
        // a begin failure must not block the run; we just skip the end too.
        let runBracketed = false;
        try {
          await api.agentRunBegin();
          runBracketed = true;
        } catch (err) {
          logDiag({
            level: "warn",
            source: "agent-loop",
            message:
              "agentRunBegin failed — workspace divergence guard inactive for this run",
            detail: err,
          });
        }
        try {
          setAgentMetrics(null);
          // Preset's allowedTools wins when non-empty; otherwise fall back to manual allowlist
          const effectiveAllowlist =
            agent.activePreset && agent.activePreset.allowedTools.length > 0
              ? agent.activePreset.allowedTools
              : agent.allowlist;
          // rAF-coalesce structural onUpdate snapshots (tool results can land
          // in bursts). Latest snapshot wins; the final state is never dropped
          // because the runner emits onUpdate after the loop settles.
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
              // Retire the in-flight bubble unless a new iteration already
              // started streaming into the accumulator (cleared synchronously
              // in onUpdate, so non-empty here means fresh text arrived since).
              if (agentAcc === "") {
                if (accRaf) {
                  cancelAnimationFrame(accRaf);
                  accRaf = 0;
                }
                setStreaming(undefined);
              }
            }
          };
          // Item 4A: a stable run id for this interactive agent send. The
          // runner's onCheckpoint fires per iteration with this id so an
          // interrupted long run leaves a durable (invisible) shadow record.
          const runId = `run:${crypto.randomUUID()}`;
          const agentLoop = await loadAgentLoop();
          const { runAgentLoop } = agentLoop;
          // Item 2: apply the configured global subagent concurrency budget
          // before the run starts. Best-effort — a missing/invalid setting
          // leaves the module default in place.
          {
            const cfg = await getCachedSettings().catch(() => null);
            const cap = cfg?.max_concurrent_subagents;
            if (typeof cap === "number" && Number.isFinite(cap)) {
              agentLoop.setMaxConcurrentSubagents(cap);
            }
          }
          const finalText = await runAgentLoop({
            model: status.model,
            messages: historyForApi,
            conversationId: conv.id,
            workspaceRoot,
            // Agent turn-budget override from settings (raise for long
            // multi-file builds); undefined → runner default.
            maxIterations:
              (await getCachedSettings().catch(() => null))
                ?.agent_max_iterations ?? undefined,
            // Resolved agent backend. Routing is disabled in agent mode, so the
            // active `status.backend` is the target. mlx/native/custom/openrouter
            // pass through; anything else (incl. plain ollama + `:cloud`) is the
            // ollama agent path. For custom, `status.model` carries the backend
            // id; for openrouter, the catalogue model — the same convention the
            // agent-chat dispatch expects.
            backend: resolveAgentBackend(status.backend),
            serverStatus: status,
            contextTokens: sendCtx,
            keepAlive,
            projectPolicy,
            params: chatParams,
            systemPromptOverride: agent.activePreset?.systemPromptOverride,
            toolAllowlist: effectiveAllowlist,
            approveAllShell: agent.approveAllShell,
            approveAllWrite: agent.approveAllWrite,
            dryRun: agent.dryRun,
            approvedShellPrefixes: agent.approvedShellPrefixes,
            onApproveShellPrefix: (p) => {
              agent.setApprovedShellPrefixes((prev) =>
                prev.includes(p) ? prev : [...prev, p],
              );
            },
            onUpdate: (msgs) => {
              if (!isStreamConvActive()) return;
              // The canonical message landing here absorbed any streamed
              // prelude — clear the accumulator synchronously so a delta from
              // the NEXT iteration arriving before the rAF flush can't splice
              // old text in front of it.
              agentAcc = "";
              pendingMsgs = msgs;
              if (!rafHandle) rafHandle = requestAnimationFrame(flush);
            },
            onAssistantDelta: (d) => {
              agentAcc += d;
              if (!accRaf) accRaf = requestAnimationFrame(flushAcc);
            },
            onStreamReset: () => {
              // Transport retry — the half-streamed attempt's text is being
              // re-sent from scratch; drop it immediately (retries are rare,
              // no need to coalesce the reset).
              agentAcc = "";
              if (!ctrl.signal.aborted && isStreamConvActive())
                setStreaming("");
            },
            onStatusChange: (s) => {
              if (isStreamConvActive()) setAgentStatus(s);
            },
            onMetrics: (m) => {
              if (isStreamConvActive()) setAgentMetrics(m);
            },
            onCheckpoint: (turns) => {
              // Durable shadow record (item 4A). Best-effort + fire-and-forget:
              // a checkpoint IPC failure must never interrupt the live run.
              // Capture conv.id (not the live ref) so a mid-run conversation
              // switch still checkpoints under the originating conversation.
              api.agentRunCheckpoint(runId, conv.id, turns).catch((err) =>
                logDiag({
                  level: "warn",
                  source: "agent-loop",
                  message:
                    "agentRunCheckpoint failed — run state not durably saved this iteration",
                  detail: err,
                }),
              );
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
              api
                .addMessage(conv.id, "assistant", finalText, status.model)
                .catch((err) =>
                  logDiag({
                    level: "warn",
                    source: "agent-loop",
                    message: "background addMessage (stale conv) failed",
                    detail: err,
                  }),
                );
            } else {
              try {
                const id = await api.addMessage(
                  conv.id,
                  "assistant",
                  finalText,
                  status.model,
                );
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
                if (isStreamConvActive())
                  setErr(`Failed to save response: ${e}`);
              }
            }

            if (mode === "queue" || mode === "direct") {
              void extractAndSaveFacts(
                text,
                finalText,
                conv.id,
                mode,
                "agent-mode",
                () => onMemoriesChanged?.(),
                ctrl.signal,
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
            // The user's own controller did NOT abort (checked above), yet we
            // caught an abort — that means an INNER watchdog fired: the model
            // stream stalled (no bytes for the idle window) or never started in
            // the connect window. WKWebView masks our timeout reason as the
            // generic "AbortError: Fetch is aborted", so detect it by name and
            // show an actionable message instead of the cryptic abort.
            const isStall =
              (e instanceof Error && e.name === "AbortError") ||
              /\baborted\b/i.test(String(e));
            setErr(
              isStall
                ? "The model stream stalled and was stopped (no response for a while). Your message was kept — send again to retry. Cloud models can take a bit to start; a retry usually works."
                : `Agent run failed: ${e}. Your message was kept — send again to retry.`,
            );
          }
        } finally {
          // Item 3: end the run bracket on every exit path so the active-run
          // count + pinned root are released. Best-effort + idempotent-guarded.
          if (runBracketed) {
            runBracketed = false;
            void api.agentRunEnd().catch((err) =>
              logDiag({
                level: "warn",
                source: "agent-loop",
                message: "agentRunEnd failed — active-run count may be stale",
                detail: err,
              }),
            );
          }
          // Tear down the in-flight bubble on every exit path (done / error /
          // abort) — same gating as the plain-stream path's cleanup.
          if (accRaf) {
            cancelAnimationFrame(accRaf);
            accRaf = 0;
          }
          if (isStreamConvActive()) setStreaming(undefined);
          // Audit re-review HIGH (2026-05-28): only null out if this send's
          // controller is still the active one. Otherwise a second send
          // that already installed its own controller would lose its Stop
          // affordance — the first send's finally would wipe the second's
          // abortRef and the next Stop click would be a no-op.
          if (abortRef.current === ctrl) {
            abortRef.current = null;
            // `agentStatus` is ChatWindow-global, not per-conversation. Gating
            // this reset on isStreamConvActive() would strand it on
            // "thinking"/"tool" forever if the user switched conversations mid
            // run — freezing the composer (isWorking) on the now-displayed chat.
            // Always clear when THIS send's controller is the one tearing down.
            setAgentStatus("idle");
          }
        }
        return;
      }

      /* ── Regular streaming mode ── */
      if (isStreamConvActive()) setStreaming("");
      // Accumulate tokens in a buffer (O(1) push) and only materialize the full
      // string once per animation frame on flush — avoids growing/flattening a
      // string on every token at 100+ tok/s. `acc` holds the flushed-so-far text.
      let acc = "";
      const streamT0 = performance.now();
      let firstDeltaAt: number | null = null;
      let finalUsage: import("../lib/mlx-client").ReplyUsage | undefined;
      const pending: string[] = [];
      let accLen = 0;
      let aborted = false;
      let truncatedAtCap = false;
      const ACC_MAX = 262_144;
      // Coalesce streaming updates to one per animation frame. At 100+ tok/s
      // a setState per chunk thrashes the renderer; rAF caps it to ~60 Hz.
      let scheduled = 0;
      const flushStreaming = () => {
        scheduled = 0;
        if (pending.length) {
          acc += pending.join("");
          pending.length = 0;
        }
        if (isStreamConvActive()) setStreaming(acc);
      };
      // Perf review C3 (2026-06-09): the plain path used to ship the ENTIRE
      // history every send — unbounded growth, with pasted images re-inlined
      // as base64 forever (~1.5 MB each, every send, on the loopback path).
      // Two-step fit, mirroring what the agent path already does per
      // iteration: (1) strip images from all but the two most recent
      // image-carrying user turns — the token estimator can't see base64
      // weight, so images must be handled before budgeting; (2) run
      // applyContextBudget so a long chat collapses old turns instead of
      // having the backend silently truncate the prompt head. Operates on
      // copies; the displayed/persisted history is never touched.
      let plainHistory: Message[] = historyForApi;
      {
        let imageTurnsKept = 0;
        let stripped: Message[] | null = null;
        for (let i = plainHistory.length - 1; i >= 0; i--) {
          const m = plainHistory[i];
          if (m.role !== "user" || !m.images?.length) continue;
          if (imageTurnsKept < 2) {
            imageTurnsKept++;
            continue;
          }
          if (!stripped) stripped = plainHistory.slice();
          const { images: _dropped, ...withoutImages } = m;
          stripped[i] = withoutImages;
        }
        if (stripped) plainHistory = stripped;
        const budgeted = applyContextBudget(plainHistory, {
          model: effModel,
          contextTokens: sendCtx,
        });
        if (budgeted.trimmed) {
          logDiag({
            level: "info",
            source: "chat-send",
            message:
              `Context budget applied (plain chat): ${budgeted.estimatedBefore} → ` +
              `${budgeted.estimatedAfter} est. tokens (budget ${budgeted.budget})`,
          });
        }
        plainHistory = budgeted.messages;
      }
      // Item 1: gate local plain-chat inference through the global semaphore so
      // it shares the budget with agent-mode + subagent inference. Cloud routes
      // (openrouter / custom / :cloud) bypass. The permit spans the WHOLE stream
      // (acquire here, release in the finally below) — releasing only once the
      // stream is fully consumed or aborted, so a slow local decode holds the
      // device exclusively for its duration.
      const bypassPlainGate = shouldBypassInferenceGate(effModel, effBackend);
      let plainPermitHeld = false;
      if (!bypassPlainGate) {
        try {
          await inferenceGate.acquire(ctrl.signal);
          plainPermitHeld = true;
        } catch {
          // Aborted while queued — treat as a normal user abort and skip the
          // stream entirely (no permit was acquired, nothing to release).
          aborted = true;
        }
      }
      try {
        if (!bypassPlainGate && !plainPermitHeld) {
          // Acquisition was aborted above — don't open a stream.
          throw new DOMException("aborted", "AbortError");
        }
        // Backend dispatch. `custom` routes to a user-configured
        // OpenAI-compatible cloud endpoint; `status.model` carries the
        // CustomBackend id (the picker encodes it there for custom
        // selections). `native` is in-process mistralrs; everything else
        // is the MLX/Ollama OpenAI-compat loopback path.
        // Effective target for this turn — equals the active model unless the
        // router swapped it above. For ollama/mlx we pass a cloned status with
        // the effective model (ollama loads it on demand).
        const effStatus: ServerStatus = {
          ...status,
          model: effModel,
          backend: effBackend,
        };
        const stream =
          effBackend === "openrouter"
            ? // OpenRouter built-in: one backend id, effModel is the
              // picked catalogue model (passed as the per-call override).
              streamCustomChat("openrouter", plainHistory, {
                model: effModel,
                signal: ctrl.signal,
                temperature: chatParams.temperature ?? undefined,
                top_p: chatParams.top_p ?? undefined,
                maxTokens: chatParams.max_tokens ?? undefined,
              })
            : effBackend === "custom"
              ? streamCustomChat(effModel, plainHistory, {
                  signal: ctrl.signal,
                  temperature: chatParams.temperature ?? undefined,
                  top_p: chatParams.top_p ?? undefined,
                  maxTokens: chatParams.max_tokens ?? undefined,
                })
              : effBackend === "native"
                ? streamNativeChat(plainHistory, {
                    signal: ctrl.signal,
                    temperature: chatParams.temperature ?? undefined,
                    top_p: chatParams.top_p ?? undefined,
                    maxTokens: chatParams.max_tokens ?? undefined,
                  })
                : isLocalOllama
                  ? // Native /api/chat: the only Ollama endpoint that honors
                    // num_ctx (O2) — /v1 ignores it and the daemon default
                    // silently head-truncates long prompts.
                    streamOllamaPlain(
                      effStatus.host,
                      effStatus.port,
                      effModel,
                      plainHistory,
                      {
                        signal: ctrl.signal,
                        temperature: chatParams.temperature ?? undefined,
                        topP: chatParams.top_p ?? undefined,
                        maxTokens: chatParams.max_tokens ?? undefined,
                        numCtx: sendCtx,
                        keepAlive,
                      },
                    )
                  : streamChat(effStatus, plainHistory, {
                      signal: ctrl.signal,
                      temperature: chatParams.temperature ?? undefined,
                      topP: chatParams.top_p ?? undefined,
                      maxTokens: chatParams.max_tokens ?? undefined,
                    });
        for await (const chunk of stream) {
          if (chunk.done) {
            // /api/chat's done-frame carries exact token counts + decode
            // timings — the honest numbers for the perf footer + ledger.
            finalUsage =
              "usage" in chunk
                ? (chunk as import("../lib/mlx-client").ChatChunk).usage
                : undefined;
            break;
          }
          if (firstDeltaAt == null && chunk.delta) {
            firstDeltaAt = performance.now();
          }
          pending.push(chunk.delta);
          accLen += chunk.delta.length;
          if (accLen > ACC_MAX) {
            // Code review L2: previously truncated silently — surface it in
            // diagnostics so a user investigating a clipped reply has a
            // breadcrumb. The user-visible UI still gets the truncated
            // response; this is a developer / support hint.
            logDiag({
              level: "warn",
              source: "chat-send",
              message: `streaming response hit ACC_MAX (${ACC_MAX} bytes) — truncated`,
              detail: { backend: status.backend, model: status.model },
            });
            truncatedAtCap = true;
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
        // Item 1: release the inference permit once the stream is fully
        // consumed/aborted (every exit path lands here). Guarded so a bypassed
        // (cloud) route or an aborted-while-queued acquire never over-releases.
        if (plainPermitHeld) {
          inferenceGate.release();
          plainPermitHeld = false;
        }
        // Drain any tokens that arrived since the last frame flush so `acc` is
        // the complete reply for persistence below (the loop can break on `done`
        // with pending tokens unflushed).
        if (pending.length) {
          acc += pending.join("");
          pending.length = 0;
        }
        if (scheduled) cancelAnimationFrame(scheduled);
        // Only null out if this send's controller is still active. Audit
        // re-review HIGH (2026-05-28) — same race as the agent-path
        // finally above; second send's controller must survive the first's
        // teardown.
        if (abortRef.current === ctrl) abortRef.current = null;
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
        const displayContent = aborted
          ? acc +
            (truncatedAtCap
              ? "\n\n[Response truncated at the 256 KB limit — send a follow-up to continue.]"
              : "\n\n[stopped]")
          : acc;
        const asst: Message = {
          _tmpKey: tmpKey(),
          conversation_id: conv.id,
          role: "assistant",
          content: displayContent,
          model: effModel,
        };
        // Strict same-conv gate: if the user switched conversations mid-stream
        // the assistant turn STILL gets persisted under its original
        // conversation_id, but it must not be appended to the now-active
        // conversation's UI buffer. We persist fire-and-forget in that case.
        if (!sameConv()) {
          api.addMessage(conv.id, "assistant", acc, effModel).catch((err) =>
            logDiag({
              level: "warn",
              source: "chat-stream",
              message: "background addMessage (stale conv) failed",
              detail: err,
            }),
          );
        } else {
          try {
            const id = await api.addMessage(
              conv.id,
              "assistant",
              acc,
              effModel,
            );
            asst.id = id;
            // Per-reply perf stat (wave D): footer renders from the volatile
            // store; the durable per-model ledger row is fire-and-forget.
            const stat = buildReplyStat(
              effModel,
              streamT0,
              firstDeltaAt,
              performance.now(),
              finalUsage,
              acc.length,
            );
            setReplyStat(id, stat);
            if (stat.tokPerSec != null) {
              void api
                .modelPerfRecord({
                  model: effModel,
                  backend: effBackend,
                  ttft_ms: stat.ttftMs,
                  tok_per_sec: stat.tokPerSec,
                  completion_tokens: stat.completionTokens ?? 0,
                  cold_load: stat.coldLoad,
                })
                .catch(() => {});
            }
          } catch (e) {
            if (sameConv()) setErr(`Failed to save response: ${e}`);
          }
          if (sameConv()) setMessages((m) => [...m, asst]);
        }

        if (mode === "queue" || mode === "direct") {
          void extractAndSaveFacts(
            text,
            acc,
            conv.id,
            mode,
            "chat",
            () => onMemoriesChanged?.(),
            ctrl.signal,
          );
        }
      } else if (aborted) {
        const tombstone: Message = {
          _tmpKey: tmpKey(),
          conversation_id: conv.id,
          role: "assistant",
          content: "[stopped before response]",
          model: effModel,
        };
        if (!sameConv()) {
          api
            .addMessage(conv.id, "assistant", tombstone.content, effModel)
            .catch((err) =>
              logDiag({
                level: "warn",
                source: "chat-window",
                message: "background addMessage tombstone (stale conv) failed",
                detail: err,
              }),
            );
        } else {
          try {
            const id = await api.addMessage(
              conv.id,
              "assistant",
              tombstone.content,
              effModel,
            );
            tombstone.id = id;
          } catch (err) {
            logDiag({
              level: "warn",
              source: "chat-window",
              message:
                "failed to persist abort tombstone — message stays unsaved",
              detail: err,
            });
          }
          if (sameConv()) setMessages((m) => [...m, tombstone]);
        }
      }
    },
  );

  const send = useCallback(
    (text: string, images?: ChatImage[]) => runSend(text, images),
    [runSend],
  );
  const resend = useCallback(
    (text: string, priorHistory: Message[]) =>
      runSend(text, undefined, priorHistory),
    [runSend],
  );
  const abort = useCallback(() => {
    // Key cancelActiveShell by the current loop's AbortSignal so we cancel
    // THIS loop's shell, not whichever happened to be set last in a
    // module-singleton (the old race-prone behaviour).
    const sig = abortRef.current?.signal ?? null;
    void loadAgentLoop().then((m) => m.cancelActiveShell(sig));
    abortRef.current?.abort();
  }, []);

  return { send, resend, abort };
}
