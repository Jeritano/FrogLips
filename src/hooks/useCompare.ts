import { useCallback, useRef, useState } from "react";
import { streamChat } from "../lib/mlx-client";
import { streamOllamaPlain } from "../lib/ollama-plain-client";
import { streamNativeChat } from "../lib/native-client";
import { streamCustomChat } from "../lib/custom-client";
import {
  inferenceGate,
  shouldBypassInferenceGate,
} from "../lib/inference-gate";
import type { ReplyUsage } from "../lib/mlx-client";
import { buildReplyStat, type ReplyStat } from "../lib/reply-stats";
import { logDiag } from "../lib/diagnostics";
import type { Message, ServerStatus } from "../types";

/**
 * SIDE-BY-SIDE multi-model COMPARE (W5B-COMPARE).
 *
 * The user picks 2–3 already-installed models, types ONE prompt, and each model
 * streams its answer into its own column. This is an EXPLORATORY surface: nothing
 * here is persisted to the conversation (it never calls `api.addMessage`), so the
 * normal single-model chat history is never corrupted.
 *
 * The streaming itself reuses the SAME per-backend clients the normal plain-chat
 * path uses (`streamChat` / `streamOllamaPlain` / `streamNativeChat` /
 * `streamCustomChat`) — no new inference path is introduced. Columns run
 * CONCURRENTLY (independent async generators), but each LOCAL column still
 * acquires a permit from the shared {@link inferenceGate} before it opens its
 * stream, so a 2-model local compare serializes the actual device work (one
 * Ollama daemon / one MLX server / one GPU) instead of thrashing it. Cloud
 * routes (`:cloud`, openrouter, remote custom) bypass the gate and truly run in
 * parallel — exactly the policy the normal send respects.
 */

/** A single model selected for comparison. Carries enough to dispatch the same
 *  way the plain-chat path does: backend decides the client, `model` is the
 *  effective model id (for custom this is the CustomBackend id, with
 *  `customModel` the catalogue model used only for the footer label). */
export interface CompareTarget {
  /** Stable key for React + the column map (unique per slot). */
  key: string;
  /** Backend: "mlx" | "ollama" | "native" | "custom" | "openrouter". */
  backend: string;
  /** Effective model id passed to the client (CustomBackend id for "custom"). */
  model: string;
  /** Human-facing label for the column header + footer. */
  label: string;
  /** OpenRouter / custom catalogue model override, when distinct from `model`. */
  customModel?: string;
}

/** Live state of one comparison column. */
export interface CompareColumn {
  key: string;
  label: string;
  model: string;
  backend: string;
  /** Accumulated streamed text so far. */
  text: string;
  /** Per-stream lifecycle. */
  state: "streaming" | "done" | "error" | "aborted";
  /** Set when `state === "error"`. */
  error?: string;
  /** tok/s + TTFT footer, populated on completion (reuses reply-stats). */
  stat?: ReplyStat;
}

export interface CompareParams {
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
}

export interface UseCompare {
  /** Live, ordered columns (one per target). Empty before the first run. */
  columns: CompareColumn[];
  /** True while at least one column is still streaming. */
  running: boolean;
  /** Run the prompt against every target concurrently. Replaces prior columns.
   *  `status` is the running backend's live status — its host/port resolve the
   *  loopback address for the mlx/ollama clients (cloud/custom ignore it). */
  run: (
    prompt: string,
    targets: CompareTarget[],
    history: Message[],
    params: CompareParams,
    status: ServerStatus,
  ) => Promise<void>;
  /** Abort every in-flight column. */
  abort: () => void;
}

/** Per-frame coalesced text setter for one column — avoids a setState per token
 *  across N concurrent streams (which would be N×60 Hz of churn). */
function makeColumnFlusher(
  key: string,
  setColumns: React.Dispatch<React.SetStateAction<CompareColumn[]>>,
) {
  let pending = "";
  let raf = 0;
  const flush = () => {
    raf = 0;
    const add = pending;
    pending = "";
    if (!add) return;
    setColumns((cols) =>
      cols.map((c) => (c.key === key ? { ...c, text: c.text + add } : c)),
    );
  };
  return {
    push(delta: string) {
      pending += delta;
      if (!raf) raf = requestAnimationFrame(flush);
    },
    /** Force any buffered text out (call before marking the column terminal). */
    drain() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flush();
    },
  };
}

/**
 * Build the streaming generator for ONE target, mirroring the backend dispatch
 * in `useChatSend`'s plain-streaming path so behavior is identical per backend.
 * `status` supplies host/port for the loopback (mlx/ollama) backends.
 */
function openStream(
  target: CompareTarget,
  history: Message[],
  status: ServerStatus,
  params: CompareParams,
  sendCtx: number | undefined,
  keepAlive: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<{ delta: string; done: boolean; usage?: ReplyUsage }> {
  const { backend, model } = target;
  const temperature = params.temperature ?? undefined;
  const top_p = params.top_p ?? undefined;
  const maxTokens = params.max_tokens ?? undefined;
  const isLocalOllama = backend === "ollama" && !model.endsWith(":cloud");

  if (backend === "openrouter") {
    return streamCustomChat("openrouter", history, {
      model: target.customModel ?? model,
      signal,
      temperature,
      top_p,
      maxTokens,
    });
  }
  if (backend === "custom") {
    return streamCustomChat(model, history, {
      signal,
      temperature,
      top_p,
      maxTokens,
    });
  }
  if (backend === "native") {
    return streamNativeChat(history, { signal, temperature, top_p, maxTokens });
  }
  if (isLocalOllama) {
    // Native /api/chat — the only Ollama endpoint that honors num_ctx (matches
    // the plain-chat path; /v1 silently head-truncates long prompts).
    return streamOllamaPlain(status.host, status.port, model, history, {
      signal,
      temperature,
      topP: top_p,
      maxTokens,
      numCtx: sendCtx,
      keepAlive,
    });
  }
  // MLX loopback / `:cloud` ollama (the OpenAI-compat /v1 path).
  const effStatus: ServerStatus = { ...status, model, backend };
  return streamChat(effStatus, history, {
    signal,
    temperature,
    topP: top_p,
    maxTokens,
  });
}

/**
 * Drive one column to completion: acquire an inference permit (local only),
 * stream tokens through the per-frame flusher, then mark the column terminal
 * with a tok/s footer. Never throws — failures land as `state: "error"` on the
 * column so one model's failure never sinks the others.
 */
async function runColumn(
  target: CompareTarget,
  history: Message[],
  status: ServerStatus,
  params: CompareParams,
  sendCtx: number | undefined,
  keepAlive: string | undefined,
  signal: AbortSignal,
  setColumns: React.Dispatch<React.SetStateAction<CompareColumn[]>>,
): Promise<void> {
  const flusher = makeColumnFlusher(target.key, setColumns);
  const setState = (patch: Partial<CompareColumn>) =>
    setColumns((cols) =>
      cols.map((c) => (c.key === target.key ? { ...c, ...patch } : c)),
    );

  // Same admission policy as the normal send: gate LOCAL inference through the
  // shared semaphore (so a 2-model local compare serializes device work), let
  // cloud routes bypass and run truly parallel.
  const bypass = shouldBypassInferenceGate(target.model, target.backend);
  let permitHeld = false;
  if (!bypass) {
    try {
      await inferenceGate.acquire(signal);
      permitHeld = true;
    } catch {
      // Aborted while queued — treat as a user abort; nothing to release.
      flusher.drain();
      setState({ state: "aborted" });
      return;
    }
  }

  const t0 = performance.now();
  let firstDeltaAt: number | null = null;
  let usage: ReplyUsage | undefined;
  let charCount = 0;
  try {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const stream = openStream(
      target,
      history,
      status,
      params,
      sendCtx,
      keepAlive,
      signal,
    );
    for await (const chunk of stream) {
      if (chunk.done) {
        usage = chunk.usage;
        break;
      }
      if (firstDeltaAt == null && chunk.delta) firstDeltaAt = performance.now();
      charCount += chunk.delta.length;
      flusher.push(chunk.delta);
    }
    flusher.drain();
    const stat = buildReplyStat(
      target.label,
      t0,
      firstDeltaAt,
      performance.now(),
      usage,
      charCount,
    );
    setState({ state: signal.aborted ? "aborted" : "done", stat });
  } catch (e) {
    flusher.drain();
    if (e instanceof DOMException && e.name === "AbortError") {
      setState({ state: "aborted" });
    } else {
      logDiag({
        level: "warn",
        source: "compare",
        message: `compare column failed (${target.label})`,
        detail: e,
      });
      setState({ state: "error", error: String(e) });
    }
  } finally {
    if (permitHeld) inferenceGate.release();
  }
}

/**
 * Owns the side-by-side compare run. Concurrent per-column streams sharing the
 * inference gate; nothing is persisted (exploratory surface).
 */
export function useCompare(): UseCompare {
  const [columns, setColumns] = useState<CompareColumn[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback<UseCompare["run"]>(
    async (prompt, targets, history, params, status) => {
      if (!prompt.trim() || targets.length === 0) return;
      // Abort any previous compare run before starting a new one.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Seed one column per target up front so the grid lays out immediately.
      setColumns(
        targets.map((t) => ({
          key: t.key,
          label: t.label,
          model: t.model,
          backend: t.backend,
          text: "",
          state: "streaming" as const,
        })),
      );
      setRunning(true);

      // One shared user turn for every model — the exploratory prompt. The
      // compare history is the supplied chat history plus this prompt; we do NOT
      // mutate or persist the caller's list.
      const userTurn: Message = {
        conversation_id: 0,
        role: "user",
        content: prompt,
      };
      const compareHistory: Message[] = [...history, userTurn];

      // host/port come from the live running status (loopback backends need the
      // real mlx/ollama address). Context budgeting is intentionally skipped —
      // compare is short and exploratory, and reusing applyContextBudget would
      // add a per-column dependency for little gain. Long histories still
      // stream; the daemon truncates as it would for any over-budget prompt.
      const sendCtx = undefined;
      const keepAlive = "30m";

      try {
        await Promise.all(
          targets.map((t) =>
            runColumn(
              t,
              compareHistory,
              status,
              params,
              sendCtx,
              keepAlive,
              ctrl.signal,
              setColumns,
            ),
          ),
        );
      } finally {
        // Only clear if THIS run's controller is still the active one (a newer
        // run may have installed its own).
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    },
    [],
  );

  return { columns, running, run, abort };
}
