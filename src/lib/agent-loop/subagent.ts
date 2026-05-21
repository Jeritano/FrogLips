import type { AgentRunOptions } from "./types";
import { runAgentLoop } from "./runner";
import { logDiag } from "../diagnostics";

export const MAX_SUBAGENT_DEPTH = 3;

/** How long a finished/errored subagent stays visible to `list_subagents`. */
const COMPLETED_TTL_MS = 60_000;

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
    if (h.status !== "running" && h.finished_at != null && now - h.finished_at > COMPLETED_TTL_MS) {
      registry.delete(id);
    }
  }
}

function makeId(): string {
  // Short, URL-safe id distinct from task_create's UUIDs.
  const rand = Math.random().toString(36).slice(2, 10);
  return `sa_${rand}`;
}

/** Build the AgentRunOptions used by the actual subagent run. */
function buildSubOpts(
  parent: AgentRunOptions,
  prompt: string,
  presetSystemPromptOverride: string | undefined,
  presetAllowedTools: string[] | undefined,
  depth: number,
  childSignal: AbortSignal,
): AgentRunOptions {
  return {
    model: parent.model,
    messages: [
      { conversation_id: parent.conversationId, role: "user", content: prompt },
    ],
    conversationId: parent.conversationId,
    workspaceRoot: parent.workspaceRoot,
    systemPromptOverride: presetSystemPromptOverride ?? parent.systemPromptOverride,
    toolAllowlist: presetAllowedTools && presetAllowedTools.length
      ? presetAllowedTools
      : parent.toolAllowlist,
    approveAllShell: parent.approveAllShell,
    approveAllWrite: parent.approveAllWrite,
    dryRun: parent.dryRun,
    approvedShellPrefixes: parent.approvedShellPrefixes,
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
 * propagates from parent → all live subagents.
 */
function makeChildAbort(parent: AgentRunOptions): AbortController {
  const child = new AbortController();
  if (parent.signal.aborted) {
    child.abort();
  } else {
    const onAbort = () => child.abort();
    parent.signal.addEventListener("abort", onAbort, { once: true });
  }
  return child;
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

  const childAbort = makeChildAbort(parent);
  const subOpts = buildSubOpts(
    parent,
    prompt,
    chosen?.systemPromptOverride,
    chosen?.allowedTools,
    depth,
    childAbort.signal,
  );
  const final = await runAgentLoop(subOpts);
  return JSON.stringify({
    ok: true,
    depth,
    preset: presetId,
    answer: final ?? "(subagent returned nothing)",
  });
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
  const childAbort = makeChildAbort(parent);
  const subOpts = buildSubOpts(
    parent,
    prompt,
    chosen?.systemPromptOverride,
    chosen?.allowedTools,
    depth,
    childAbort.signal,
  );

  const startedAt = Date.now();
  const promise = (async (): Promise<string> => {
    try {
      const final = await runAgentLoop(subOpts);
      const payload = JSON.stringify({
        ok: true,
        depth,
        preset: presetId,
        answer: final ?? "(subagent returned nothing)",
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
