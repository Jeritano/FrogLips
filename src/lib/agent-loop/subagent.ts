import type { AgentRunOptions } from "./types";
import { runAgentLoop } from "./runner";
import { cancelActiveShell } from "./dispatch";
import { fenceUntrustedData } from "./untrusted-fence";
import { logDiag } from "../diagnostics";

/**
 * A subagent's final answer is model-generated text that may have laundered an
 * injection payload from hostile web/MCP content the child processed. Before it
 * re-enters the PARENT loop as a tool result, strip role framing + wrap it in
 * the shared `<untrusted-data>` fence — the same defense workflow card handoff
 * uses. Empty answer → a plain marker (nothing to fence). Sec audit follow-up.
 */
function fenceSubagentAnswer(answer: string | null | undefined): string {
  return answer
    ? fenceUntrustedData(answer, "subagent")
    : "(subagent returned nothing)";
}

export const MAX_SUBAGENT_DEPTH = 3;

/**
 * Default global cap on subagents running concurrently across the WHOLE process
 * (all parents + all depths). The depth check bounds recursion DEPTH; this
 * bounds total BREADTH so a wide fan-out (a parent spawning many async
 * subagents, each of which fans out again) can't launch an unbounded number of
 * concurrent inference loops. Configurable via {@link setMaxConcurrentSubagents}
 * (wired from settings). Inference admission control (item 1) further serializes
 * the actual network calls, but this gate stops the loops from even starting.
 */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;

/** Current global concurrency budget. Mutable so settings can override it. */
let maxConcurrentSubagents = DEFAULT_MAX_CONCURRENT_SUBAGENTS;

/** Live count of subagents currently admitted (incremented at spawn, decremented
 *  when the run settles). Process-global on purpose — the budget is global. */
let runningSubagents = 0;

/**
 * Set the global concurrent-subagent budget (wired from the
 * `maxConcurrentSubagents` setting). Values < 1 are clamped to 1 so a
 * misconfiguration can never deadlock every subagent. No-op for non-finite.
 */
export function setMaxConcurrentSubagents(n: number): void {
  if (!Number.isFinite(n)) return;
  maxConcurrentSubagents = Math.max(1, Math.floor(n));
}

/** Current budget — exposed for tests / diagnostics. */
export function getMaxConcurrentSubagents(): number {
  return maxConcurrentSubagents;
}

/**
 * Try to admit one subagent against the global budget. Returns true (and
 * increments the running count) when there's room; false when at/over budget.
 * Each successful admit MUST be paired with exactly one {@link releaseSubagentSlot}.
 *
 * TODO (RAM-aware gate, out of scope here): additionally refuse admission when
 * free system RAM is below a model-sized threshold so a fan-out can't OOM the
 * machine. Hook point is here — check available memory before returning true.
 */
function tryAdmitSubagent(): boolean {
  if (runningSubagents >= maxConcurrentSubagents) return false;
  runningSubagents += 1;
  return true;
}

/** Release one admitted slot. Floored at 0 so a double-release can't drive the
 *  count negative and permanently inflate available capacity. */
function releaseSubagentSlot(): void {
  if (runningSubagents > 0) runningSubagents -= 1;
}

/** Structured over-budget rejection — mirrors the depth_exceeded shape so the
 *  runner's existing {ok:false} handling needs no new branch. */
function budgetExceededResult(): string {
  return JSON.stringify({
    ok: false,
    kind: "subagent_budget_exceeded",
    message: `concurrent subagent cap (${maxConcurrentSubagents}) reached — too many subagents are already running`,
  });
}

/** How long a finished/errored subagent stays visible to `list_subagents`. */
const COMPLETED_TTL_MS = 60_000;
/** Hard cap: any handle older than this is evicted regardless of status —
 * defends against a stuck "running" handle leaking memory across a session.
 * Maturity review P1 #33. */
const HARD_TTL_MS = 5 * 60_000;

export type SubagentStatus = "running" | "done" | "error" | "cancelled";

export interface SubagentHandle {
  id: string;
  status: SubagentStatus;
  promise: Promise<string>;
  result?: string;
  started_at: number;
  finished_at?: number;
  prompt_preview: string;
  abortController: AbortController;
  /** Depth at which this subagent was spawned — used by registry inspection. */
  depth: number;
}

/** Module-level registry of all spawned-async subagents (in-memory only). */
const registry = new Map<string, SubagentHandle>();

/** Subagents waiting in the registry that should be GC'd after their TTL. */
function pruneOldHandles(): void {
  const now = Date.now();
  for (const [id, h] of registry) {
    // Two eviction triggers.
    //   1) Finished handle past its COMPLETED_TTL_MS — original behavior.
    //   2) ANY handle (running OR stuck "error"/"done" without finished_at)
    //      older than HARD_TTL_MS — covers the case the maturity review
    //      called out: a subagent that crashed before recording its
    //      finished_at, or one whose await never resolved, otherwise
    //      lived in the map forever.
    const finishedExpired =
      h.status !== "running" &&
      h.finished_at != null &&
      now - h.finished_at > COMPLETED_TTL_MS;
    const hardExpired = now - h.started_at > HARD_TTL_MS;
    if (finishedExpired || hardExpired) {
      registry.delete(id);
    }
  }
}

function makeId(): string {
  // Short, URL-safe id; first segment of a UUID for collision-resistance.
  return `sa_${crypto.randomUUID().slice(0, 8)}`;
}

/** Build the AgentRunOptions used by the actual subagent run. */
function buildSubOpts(
  parent: AgentRunOptions,
  prompt: string,
  presetSystemPromptOverride: string | undefined,
  presetAllowedTools: string[] | undefined,
  /**
   * True when the caller explicitly chose a preset. An explicit preset owns
   * its tool scope: an empty `allowedTools` then means "all tools" (e.g. the
   * `general` preset) — NOT "inherit the parent's restriction".
   */
  presetChosen: boolean,
  depth: number,
  childSignal: AbortSignal,
): AgentRunOptions {
  // Explicit preset → its allowlist, but NEVER broader than the parent's grant.
  // Sec audit round 5 (least privilege): previously a chosen preset REPLACED
  // the parent's allowlist, so a parent restricted to e.g. ["read_file"] could
  // spawn_subagent(preset:"general") and the child got EVERY tool. Intersect
  // instead. Empty list = "no ceiling" on that side (matches the runner's
  // empty=all semantics). No preset → inherit the parent's allowlist verbatim.
  const intersectAllow = (
    parentList: string[],
    presetList: string[],
  ): string[] => {
    if (presetList.length === 0) return parentList; // preset = all → bounded by parent
    if (parentList.length === 0) return presetList; // parent = all → preset is the ceiling
    const parentSet = new Set(parentList);
    return presetList.filter((t) => parentSet.has(t));
  };
  const toolAllowlist = presetChosen
    ? intersectAllow(parent.toolAllowlist ?? [], presetAllowedTools ?? [])
    : parent.toolAllowlist;
  return {
    model: parent.model,
    messages: [
      { conversation_id: parent.conversationId, role: "user", content: prompt },
    ],
    conversationId: parent.conversationId,
    workspaceRoot: parent.workspaceRoot,
    backend: parent.backend,
    serverStatus: parent.serverStatus,
    systemPromptOverride:
      presetSystemPromptOverride ?? parent.systemPromptOverride,
    toolAllowlist,
    // Do NOT propagate blanket session approvals into subagents: a subagent's
    // prompt can be attacker-influenced, so dangerous tool calls inside it must
    // require fresh confirmation rather than inherit the parent's grants.
    approveAllShell: false,
    approveAllWrite: false,
    dryRun: parent.dryRun,
    approvedShellPrefixes: [],
    // I2: don't inherit the parent's "remember this shell prefix" callback — a
    // subagent modal is attacker-influenceable, so a "remember" click there must
    // not persist a prefix into the parent's global config.
    onApproveShellPrefix: undefined,
    // Suppress UI noise: subagent runs are background work; parent's
    // metrics + UI shouldn't see every intermediate step.
    onUpdate: () => {},
    onStatusChange: () => {},
    onMetrics: () => {},
    requestConfirmation: parent.requestConfirmation,
    signal: childSignal,
    _subagentDepth: depth,
  };
}

/**
 * Wires a child AbortController to the parent's signal so that cancellation
 * propagates from parent → all live subagents. The returned `release` MUST be
 * called once the subagent has resolved/rejected: otherwise the parent's
 * AbortSignal accumulates a stale listener for every spawn, leaking memory
 * across a long-lived session.
 */
function makeChildAbort(parent: AgentRunOptions): {
  controller: AbortController;
  release: () => void;
} {
  const child = new AbortController();
  if (parent.signal.aborted) {
    child.abort();
    return { controller: child, release: () => {} };
  }
  const onAbort = () => child.abort();
  parent.signal.addEventListener("abort", onAbort, { once: true });
  // When the child aborts (parent Stop propagates, or the subagent's own
  // timeout fires), cancel any run_shell in flight under the child's signal
  // key. The top-level Stop only cancels the PARENT loop's shell; without
  // this the subagent's shell process orphans until its own 30-600s timeout.
  child.signal.addEventListener(
    "abort",
    () => cancelActiveShell(child.signal),
    { once: true },
  );
  return {
    controller: child,
    release: () => {
      // Listener was registered with `once: true`, so it auto-removes if the
      // parent ever aborts. If the subagent finishes first, we must remove
      // it explicitly — once:true does not GC unfired listeners.
      parent.signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Synchronous (default, back-compat) subagent run — awaits the inner
 * runAgentLoop and returns the JSON string the runner will hand to the LLM.
 */
export async function runSubagent(
  args: Record<string, unknown>,
  parent: AgentRunOptions,
): Promise<string> {
  const depth = (parent._subagentDepth ?? 0) + 1;
  if (depth > MAX_SUBAGENT_DEPTH) {
    return JSON.stringify({
      ok: false,
      kind: "depth_exceeded",
      message: `spawn_subagent depth cap (${MAX_SUBAGENT_DEPTH}) reached`,
    });
  }
  const prompt = String(args.prompt ?? "");
  if (!prompt.trim()) {
    return JSON.stringify({
      ok: false,
      kind: "invalid_argument",
      message: "prompt is empty",
    });
  }
  // Global concurrency budget (item 2). Gate AFTER the cheap depth/arg checks so
  // an invalid call never squats a slot. Over budget → structured rejection
  // mirroring depth_exceeded (the runner already handles {ok:false}).
  if (!tryAdmitSubagent()) {
    return budgetExceededResult();
  }
  // The releasing finally must cover the WHOLE post-admit region, not just the
  // runAgentLoop call: the setup below (dynamic import of agent-presets,
  // makeChildAbort, buildSubOpts) can throw, and if the release lived only
  // around runAgentLoop a throw here would leak the global slot — leaks
  // accumulate until the process-global cap is hit and every future subagent is
  // permanently rejected with subagent_budget_exceeded. `release` (the
  // parent-abort listener cleanup) is initialized to a no-op so the finally is
  // safe even if makeChildAbort never runs.
  let release: () => void = () => {};
  try {
    const presetId = args.preset ? String(args.preset) : null;

    // Lazy-load presets to avoid a static cycle.
    const { loadAllPresets } = await import("../agent-presets");
    const presets = loadAllPresets();
    const chosen = presetId
      ? presets.find((p) => p.id === presetId)
      : undefined;

    const childAbort = makeChildAbort(parent);
    release = childAbort.release;
    const subOpts = buildSubOpts(
      parent,
      prompt,
      chosen?.systemPromptOverride,
      chosen?.allowedTools,
      chosen != null,
      depth,
      childAbort.controller.signal,
    );
    const final = await runAgentLoop(subOpts);
    return JSON.stringify({
      ok: true,
      depth,
      preset: presetId,
      answer: fenceSubagentAnswer(final),
    });
  } finally {
    release();
    // Release the global slot once the run has settled (success/error/abort) OR
    // if any of the setup above threw before the run even started.
    releaseSubagentSlot();
  }
}

/**
 * Async fan-out: returns immediately with a subagent_id and runs the work
 * in the background. The parent's loop can later call `awaitSubagents` to
 * join, or `listSubagents` to inspect status.
 */
export async function spawnSubagentAsync(
  args: Record<string, unknown>,
  parent: AgentRunOptions,
): Promise<string> {
  const depth = (parent._subagentDepth ?? 0) + 1;
  if (depth > MAX_SUBAGENT_DEPTH) {
    return JSON.stringify({
      ok: false,
      kind: "depth_exceeded",
      message: `spawn_subagent depth cap (${MAX_SUBAGENT_DEPTH}) reached`,
    });
  }
  const prompt = String(args.prompt ?? "");
  if (!prompt.trim()) {
    return JSON.stringify({
      ok: false,
      kind: "invalid_argument",
      message: "prompt is empty",
    });
  }
  // Global concurrency budget (item 2). Admit before registering the handle so
  // an over-budget async spawn returns the structured rejection without
  // creating a registry entry. The slot is released when the background run
  // settles (the promise's finally, below).
  if (!tryAdmitSubagent()) {
    return budgetExceededResult();
  }
  // The slot is normally released in the background promise's finally (below),
  // but that promise isn't constructed until the synchronous setup here
  // succeeds. If setup throws first (dynamic import of agent-presets,
  // makeChildAbort, buildSubOpts), there is no finally to run, so we must
  // release the slot in a catch — otherwise the leak accumulates until the
  // process-global cap is hit and every future subagent is permanently
  // rejected with subagent_budget_exceeded.
  const presetId = args.preset ? String(args.preset) : null;
  let id: string;
  let childAbort: AbortController;
  let release: () => void;
  let subOpts: AgentRunOptions;
  try {
    const { loadAllPresets } = await import("../agent-presets");
    const presets = loadAllPresets();
    const chosen = presetId
      ? presets.find((p) => p.id === presetId)
      : undefined;

    id = makeId();
    const childAbortBundle = makeChildAbort(parent);
    childAbort = childAbortBundle.controller;
    release = childAbortBundle.release;
    subOpts = buildSubOpts(
      parent,
      prompt,
      chosen?.systemPromptOverride,
      chosen?.allowedTools,
      chosen != null,
      depth,
      childAbort.signal,
    );
  } catch (e) {
    // Setup failed before the background run was created — release the slot we
    // admitted and surface a structured error (no registry entry was made).
    releaseSubagentSlot();
    return JSON.stringify({
      ok: false,
      kind: "subagent_error",
      message: String((e as { message?: string })?.message ?? e),
    });
  }

  const startedAt = Date.now();
  const promise = (async (): Promise<string> => {
    try {
      try {
        const final = await runAgentLoop(subOpts);
        const payload = JSON.stringify({
          ok: true,
          depth,
          preset: presetId,
          answer: fenceSubagentAnswer(final),
        });
        const h = registry.get(id);
        if (h) {
          h.status = childAbort.signal.aborted ? "cancelled" : "done";
          h.result = payload;
          h.finished_at = Date.now();
        }
        return payload;
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? e);
        const payload = JSON.stringify({
          ok: false,
          kind: childAbort.signal.aborted ? "cancelled" : "subagent_error",
          message: msg,
        });
        const h = registry.get(id);
        if (h) {
          h.status = childAbort.signal.aborted ? "cancelled" : "error";
          h.result = payload;
          h.finished_at = Date.now();
        }
        return payload;
      }
    } finally {
      // Remove the parent-abort listener now that this subagent is settled.
      release();
      // Release the global concurrency slot admitted above.
      releaseSubagentSlot();
    }
  })();

  const handle: SubagentHandle = {
    id,
    status: "running",
    promise,
    started_at: startedAt,
    prompt_preview: prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt,
    abortController: childAbort,
    depth,
  };
  registry.set(id, handle);
  pruneOldHandles();

  return JSON.stringify({
    ok: true,
    subagent_id: id,
    status: "running",
    depth,
  });
}

export interface AwaitResultEntry {
  id: string;
  status: "done" | "error" | "timeout" | "cancelled" | "unknown";
  result: string;
}

/**
 * Block until all listed subagents finish, or until timeoutMs elapses.
 * Returns a per-id status entry. Finished agents always include their
 * full result string; timed-out ones keep running in the background.
 */
export async function awaitSubagents(
  ids: string[],
  timeoutMs: number,
): Promise<string> {
  pruneOldHandles();
  if (!Array.isArray(ids) || ids.length === 0) {
    return JSON.stringify({ ok: true, results: [] });
  }
  const handles = ids.map((id) => ({ id, handle: registry.get(id) }));

  let timeoutHit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timeoutHit = true;
      resolve();
    }, timeoutMs);
  });

  const allDone = Promise.all(
    handles.map(({ handle, id }) =>
      handle
        ? handle.promise.catch((err) => {
            logDiag({
              level: "warn",
              source: "agent-subagent",
              message: `awaitSubagents: subagent ${id} promise rejected (status surfaced in result entry)`,
              detail: err,
            });
          })
        : Promise.resolve(),
    ),
  ).then(() => {});

  await Promise.race([allDone, timeoutPromise]);
  if (timer != null) clearTimeout(timer);

  const results: AwaitResultEntry[] = handles.map(({ id, handle }) => {
    if (!handle) {
      return {
        id,
        status: "unknown",
        result: JSON.stringify({
          ok: false,
          kind: "unknown_subagent",
          message: `no subagent with id ${id}`,
        }),
      };
    }
    if (handle.status === "running") {
      // Only possible if we hit the timeout path.
      return {
        id,
        status: "timeout",
        result: JSON.stringify({
          ok: false,
          kind: "timeout",
          message: `subagent still running after ${timeoutMs}ms`,
        }),
      };
    }
    return {
      id,
      status:
        handle.status === "done"
          ? "done"
          : handle.status === "cancelled"
            ? "cancelled"
            : "error",
      result: handle.result ?? "",
    };
  });

  return JSON.stringify({ ok: true, results, timed_out: timeoutHit });
}

export interface SubagentSnapshot {
  id: string;
  status: SubagentStatus;
  started_at: number;
  prompt_preview: string;
  depth: number;
}

/** Snapshot of every currently-tracked subagent (running + recent). */
export function listSubagents(): string {
  pruneOldHandles();
  const items: SubagentSnapshot[] = [];
  for (const h of registry.values()) {
    items.push({
      id: h.id,
      status: h.status,
      started_at: h.started_at,
      prompt_preview: h.prompt_preview,
      depth: h.depth,
    });
  }
  return JSON.stringify({ ok: true, subagents: items });
}

/** Test-only: drop all registered subagents AND reset the concurrency budget +
 *  running count so each test starts from a clean global state. */
export function __resetSubagentRegistryForTests(): void {
  for (const h of registry.values()) {
    try {
      h.abortController.abort();
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-subagent",
        message: `__resetSubagentRegistryForTests: abort on ${h.id} threw`,
        detail: err,
      });
    }
  }
  registry.clear();
  runningSubagents = 0;
  maxConcurrentSubagents = DEFAULT_MAX_CONCURRENT_SUBAGENTS;
}
