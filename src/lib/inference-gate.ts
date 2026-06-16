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
  /** Live count of granted-but-not-released permits. Tracked explicitly because
   *  a shrink (`setPermits` down) floors `permits` at 0 without preempting
   *  in-flight holders, so `capacity - permits` can UNDER-count true in-flight
   *  while the gate is transiently over-subscribed. `release()` consults this to
   *  avoid handing a permit to a waiter while still over capacity. */
  private inFlight = 0;
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
      this.inFlight += 1;
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
   * Release one permit. If a waiter is queued AND we're at/below capacity, the
   * permit is handed directly to the next FIFO waiter (no transient permit bump
   * that a barging caller could steal). Otherwise the free count increments
   * (capped at capacity).
   *
   * The over-capacity guard matters after a shrink: `setPermits` down never
   * preempts an in-flight holder, so the gate can be transiently over-subscribed
   * (more in-flight than capacity) with a waiter queued. Handing the freed slot
   * to that waiter would run it ALONGSIDE the still-in-flight over-capacity
   * holder, momentarily exceeding capacity and violating the serialize-local-
   * inference guarantee. Instead we drop the freed slot here (the over-capacity
   * drains) and leave the waiter queued; once in-flight falls below capacity a
   * later release hands off normally.
   */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    // Only hand off while NOT over-subscribed; otherwise let the excess drain.
    if (this.inFlight < this.capacity) {
      const next = this.queue.shift();
      if (next) {
        if (next.onAbort && next.signal) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        // Hand the permit straight over — do NOT bump `permits` first, so an
        // un-queued `acquire()` racing this release can't jump the FIFO line.
        this.inFlight += 1;
        next.resolve();
        return;
      }
    }
    if (this.permits < this.capacity) this.permits += 1;
  }

  /** Wake queued waiters up to the number of free permits (used after a grow).
   *  Mirrors `release()`'s over-capacity guard: never grant past `capacity`.
   *  A shrink floors `permits` at 0 without preempting in-flight holders, so a
   *  later grow can set `permits > 0` while `inFlight` is still >= `capacity`
   *  (transiently over-subscribed). Draining unconditionally on `permits` alone
   *  would then wake a waiter alongside the over-capacity holders, pushing
   *  `inFlight` past `capacity` and breaking the serialize-local-inference
   *  guarantee. Gating on `inFlight < capacity` too keeps the counter bounded. */
  private drain(): void {
    while (
      this.permits > 0 &&
      this.inFlight < this.capacity &&
      this.queue.length > 0
    ) {
      const next = this.queue.shift()!;
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      this.permits -= 1;
      this.inFlight += 1;
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
 * Whether a host (from a custom backend's `base_url`) points at a LOCAL inference
 * server — loopback, RFC1918 / CGNAT private space, link-local, or an mDNS
 * `.local` name. Such endpoints run on the very local GPU/CPU the gate exists to
 * protect (self-hosted vLLM / LM Studio / llama.cpp / a LAN box are a primary
 * supported custom-backend config — see custom_backend.rs `reject_ssrf_base`,
 * which deliberately ALLOWS these ranges), so they must be GATED, not bypassed.
 *
 * Mirrors the host classes Rust treats as private (the inverse of the genuinely-
 * remote case). Unparseable / hostless inputs are treated as local (conservative
 * — gate rather than risk thrashing the local device).
 */
function isLocalInferenceHost(baseUrl: string | undefined | null): boolean {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return true;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return true; // can't classify → gate
  }
  // Normalize: drop a trailing FQDN dot and the surrounding brackets of an IPv6
  // literal. (Despite the spec, this runtime's `URL.hostname` KEEPS the brackets
  // for `http://[::1]…` → "[::1]", which made loopback IPv6 fall through to the
  // IPv4 regex and classify as REMOTE — bypassing the gate for a localhost
  // backend. Strip them so the `::1`/`fc`/`fd` checks below match.)
  const h = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (h === "" || h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true; // mDNS / Bonjour LAN names
  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 ULA
  // IPv4 (incl. IPv4-mapped IPv6 like ::ffff:127.0.0.1).
  const v4 = h.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map((n) => Number(n));
    if (o.some((n) => n > 255)) return false; // not a real IPv4 → treat as remote
    const [a, b] = o;
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // RFC1918 10/8
    if (a === 192 && b === 168) return true; // RFC1918 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 169 && b === 254) return true; // link-local 169.254/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false; // any other IPv4 literal is genuinely remote
  }
  return false; // a non-private hostname (resolves at the remote provider)
}

/**
 * Whether a given model/backend should BYPASS the inference gate (run un-gated).
 * CLOUD routes run on the provider's infra — there's no local device to protect:
 * Ollama `:cloud` tags and the built-in OpenRouter backend always bypass.
 *
 * The `custom` backend is a user-configured OpenAI-compatible endpoint whose
 * `base_url` may legitimately point at a LOCAL model server (vLLM / LM Studio /
 * llama.cpp / a second Ollama on a custom port / a LAN box). In that case the
 * request hits the very local device the gate protects, so it MUST be gated.
 * We therefore decide a custom backend's bypass from its resolved `base_url`
 * host (when supplied): bypass only genuinely-remote hosts; gate local/private
 * ones. With no `baseUrl` we gate conservatively (protect the local device).
 */
export function shouldBypassInferenceGate(
  model: string | undefined | null,
  backend: string | undefined | null,
  baseUrl?: string | null,
): boolean {
  if (backend === "openrouter") return true;
  if (backend === "custom") {
    // For a custom backend `model` carries the CustomBackend id; resolve its
    // base_url from the registry (populated from settings) when the caller did
    // not pass one, so a REMOTE custom endpoint bypasses the local-slot gate
    // (parallel fan-out) while a LOCALHOST custom endpoint is gated like any
    // other local backend. Unknown host → gate (the safe default).
    const url = baseUrl ?? customBackendHosts.get(model ?? "") ?? null;
    return !isLocalInferenceHost(url);
  }
  if (typeof model === "string" && model.endsWith(":cloud")) return true;
  return false;
}

/**
 * id → base_url for the user's configured custom backends, so the gate can
 * classify a custom backend's host WITHOUT threading base_url through every
 * call site. Populated from settings on load + on `settings-changed`.
 */
const customBackendHosts = new Map<string, string>();

export function registerCustomBackendHosts(
  backends: ReadonlyArray<{ id?: string; base_url?: string }> | null | undefined,
): void {
  customBackendHosts.clear();
  for (const b of backends ?? []) {
    if (b && typeof b.id === "string" && typeof b.base_url === "string") {
      customBackendHosts.set(b.id, b.base_url);
    }
  }
}

/** The process-wide inference gate. Local routes share this single instance so
 *  the budget is global across chat-agent, flows, and all subagents. */
export const inferenceGate = new InferenceGate(resolveSlots());
