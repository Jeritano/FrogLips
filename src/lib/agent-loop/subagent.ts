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
  return answer ? fenceUntrustedData(answer, "subagent") : "(subagent returned nothing)";
}

export const MAX_SUBAGENT_DEPTH = 3;

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
  const intersectAllow = (parentList: string[], presetList: string[]): string[] => {
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
    systemPromptOverride: presetSystemPromptOverride ?? parent.systemPromptOverride,
    toolAllowlist,
    // Do NOT propagate blanket session approvals into subagents: a subagent's
    // prompt can be attacker-influenced, so dangerous tool calls inside it must
    // require fresh confirmation rather than inherit the parent's grants.
    approveAllShell: false,
    approveAllWrite: false,
    dryRun: parent.dryRun,
    approvedShellPrefixes: [],
    onApproveShellPrefix: parent.onApproveShellPrefix,
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
function makeChildAbort(parent: AgentRunOptions): { controller: AbortController; release: () => void } {
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
  child.signal.addEventListener("abort", () => cancelActiveShell(child.signal), { once: true });
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
    return JSON.stringify({ ok: false, kind: "invalid_argument", message: "prompt is empty" });
  }
  const presetId = args.preset ? String(args.preset) : null;

  // Lazy-load presets to avoid a static cycle.
  const { loadAllPresets } = await import("../agent-presets");
  const presets = loadAllPresets();
  const chosen = presetId ? presets.find((p) => p.id === presetId) : undefined;

  const { controller: childAbort, release } = makeChildAbort(parent);
  const subOpts = buildSubOpts(
    parent,
    prompt,
    chosen?.systemPromptOverride,
    chosen?.allowedTools,
    chosen != null,
    depth,
    childAbort.signal,
  );
  try {
    const final = await runAgentLoop(subOpts);
    return JSON.stringify({
      ok: true,
      depth,
      preset: presetId,
      answer: fenceSubagentAnswer(final),
    });
  } finally {
    release();
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
    return JSON.stringify({ ok: false, kind: "invalid_argument", message: "prompt is empty" });
  }
  const presetId = args.preset ? String(args.preset) : null;

  const { loadAllPresets } = await import("../agent-presets");
  const presets = loadAllPresets();
  const chosen = presetId ? presets.find((p) => p.id === presetId) : undefined;

  const id = makeId();
  const { controller: childAbort, release } = makeChildAbort(parent);
  const subOpts = buildSubOpts(
    parent,
    prompt,
    chosen?.systemPromptOverride,
    chosen?.allowedTools,
    chosen != null,
    depth,
    childAbort.signal,
  );

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
      return { id, status: "unknown", result: JSON.stringify({ ok: false, kind: "unknown_subagent", message: `no subagent with id ${id}` }) };
    }
    if (handle.status === "running") {
      // Only possible if we hit the timeout path.
      return {
        id,
        status: "timeout",
        result: JSON.stringify({ ok: false, kind: "timeout", message: `subagent still running after ${timeoutMs}ms` }),
      };
    }
    return {
      id,
      status: handle.status === "done" ? "done" : handle.status === "cancelled" ? "cancelled" : "error",
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

/** Test-only: drop all registered subagents. */
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
}
