/* ── Local-inference admission control (item 1) ─────────────────────────────
 *
 * A small FIFO semaphore that bounds how many LOCAL inference network calls run
 * concurrently. The problem it solves: with subagents (item 2) and flows, many
 * agent loops can be in flight at once, each issuing a streaming chat request to
 * the SAME local backend (one Ollama daemon / one MLX server / one GPU). Firing
 * them all at once thrashes the single device — KV cache churn, context reloads,
 * and wildly variable latency. Serializing the actual network calls (default
 * permits = 1) keeps local decode fast and predictable while the agent loops
 * still interleave their non-inference work (tool calls, file IO) freely.
 *
 * CLOUD routes bypass the gate entirely — they run on the provider's infra, so
 * there's no local device to protect and gating them would needlessly serialize
 * independent cloud requests. Bypass is decided at the CALL SITE (see
 * `shouldBypassInferenceGate`), which runs the network call un-gated.
 *
 * ── Deadlock safety (the critical correctness property) ──────────────────────
 * A permit is acquired ONLY around a single network call — NEVER held across a
 * full `runAgentLoop`. A parent agent loop releases its permit between turns
 * (the gate wraps the per-attempt dispatch, not the loop), so when the parent
 * spawns a child subagent and awaits it, the parent is NOT holding a permit at
 * that point. The child's own turns can therefore acquire the permit and make
 * progress. With permits = 1 and the permit scoped to the bare network call,
 * there is no parent→child hold-and-wait: the only place a permit is held is
 * inside `withInferenceSlot(fn)`, and `fn` is always just the dispatch, which
 * does not itself await a child loop. This invariant is enforced by placement,
 * not by the gate — keep the two chokepoints scoped to the network call only.
 */

/** Default local-inference permits — serialize local inference by default so a
 *  fan-out doesn't thrash one GPU/CPU. */
export const DEFAULT_INFERENCE_PERMITS = 1;

/** Module-init slot count. Settings are async (IPC), so this is the static
 *  default; `inferenceGate.setPermits(...)` reconfigures it once settings load
 *  (wired from `inference_permits` in useChatSend, like the subagent budget). */
export function resolveSlots(): number {
  return DEFAULT_INFERENCE_PERMITS;
}

/**
 * FIFO counting semaphore with abort-aware acquisition. `permits >= 1`. Waiters
 * are served strictly in arrival order; a waiter whose AbortSignal fires while
 * queued is removed and its acquire rejects, so a cancelled run never holds up
 * the queue or later squats a permit.
 */
export class InferenceGate {
  private permits: number;
  private capacity: number;
  /** Pending waiters in arrival order. Each entry can be `settle`d (granted) or
   *  removed (aborted). */
  private queue: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
    onAbort?: () => void;
    signal?: AbortSignal;
  }> = [];

  constructor(permits: number = DEFAULT_INFERENCE_PERMITS) {
    const p = Number.isFinite(permits) ? Math.max(1, Math.floor(permits)) : 1;
    this.permits = p;
    this.capacity = p;
  }

  /** Current free permits — exposed for tests / diagnostics. */
  available(): number {
    return this.permits;
  }

  /** Number of queued waiters — exposed for tests / diagnostics. */
  waiting(): number {
    return this.queue.length;
  }

  /**
   * Reconfigure the permit count (from settings). Grows/shrinks capacity; when
   * growing, any newly-available permits immediately wake queued waiters in FIFO
   * order. Shrinking never preempts an in-flight holder — it just lowers future
   * capacity (free permits floor at 0). No-op for non-finite values.
   */
  setPermits(next: number): void {
    if (!Number.isFinite(next)) return;
    const target = Math.max(1, Math.floor(next));
    const delta = target - this.capacity;
    this.capacity = target;
    this.permits = Math.max(0, this.permits + delta);
    // Wake as many FIFO waiters as we now have permits for.
    this.drain();
  }

  /**
   * Acquire one permit. Resolves immediately if a permit is free; otherwise
   * queues FIFO and resolves when granted. If `signal` is already aborted, or
   * aborts WHILE queued, the returned promise rejects with the abort reason and
   * the waiter is removed from the queue (it never later squats a permit).
   *
   * IMPORTANT: a fulfilled acquire MUST be paired with exactly one `release()`.
   * Prefer `withInferenceSlot`, which pairs them for you on every exit path.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void;
        reject: (e: unknown) => void;
        onAbort?: () => void;
        signal?: AbortSignal;
      } = { resolve, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          // Remove this waiter from the queue and reject. A permit is NOT
          // consumed — the abort happened while still queued.
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          signal.removeEventListener("abort", entry.onAbort!);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  /**
   * Release one permit. If a waiter is queued, the permit is handed directly to
   * the next FIFO waiter (no transient permit bump that a barging caller could
   * steal). Otherwise the free count increments (capped at capacity).
   */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      // Hand the permit straight over — do NOT bump `permits` first, so an
      // un-queued `acquire()` racing this release can't jump the FIFO line.
      next.resolve();
      return;
    }
    if (this.permits < this.capacity) this.permits += 1;
  }

  /** Wake queued waiters up to the number of free permits (used after a grow). */
  private drain(): void {
    while (this.permits > 0 && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      this.permits -= 1;
      next.resolve();
    }
  }
}

/**
 * Run `fn` while holding exactly one inference permit. Acquires (abort-aware,
 * FIFO), runs `fn`, and releases on EVERY exit path (resolve, reject, or an
 * abort that fires during acquisition). If the signal aborts while queued, `fn`
 * never runs and no permit is leaked.
 *
 * Scope `fn` to the bare network call only — never wrap a full `runAgentLoop`
 * (see the deadlock-safety note at the top of this file).
 */
export async function withInferenceSlot<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  gate: InferenceGate = inferenceGate,
): Promise<T> {
  await gate.acquire(signal); // throws if aborted while queued — no permit held
  try {
    return await fn();
  } finally {
    gate.release();
  }
}

/** Abort reason as a thrown value, preferring the signal's own reason. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
}

/**
 * Whether a given model/backend should BYPASS the inference gate (run un-gated).
 * Cloud routes run on the provider's infra — there's no local device to protect.
 * Covers: Ollama `:cloud` tags, the custom (user OpenAI-compatible endpoint)
 * backend, and the built-in OpenRouter backend.
 */
export function shouldBypassInferenceGate(
  model: string | undefined | null,
  backend: string | undefined | null,
): boolean {
  if (backend === "custom" || backend === "openrouter") return true;
  if (typeof model === "string" && model.endsWith(":cloud")) return true;
  return false;
}

/** The process-wide inference gate. Local routes share this single instance so
 *  the budget is global across chat-agent, flows, and all subagents. */
export const inferenceGate = new InferenceGate(resolveSlots());
