/**
 * Workflow scratchpad: a per-run shared blob that cards can write to + read
 * from. Solves the "I want to pass structured state between cards without
 * stuffing it into the prose handoff" pain point.
 *
 * Lifetime: one workflow run. Runner sets the active scratchpad on `start`,
 * clears it on `end`. Between those points, the `workflow_set` /
 * `workflow_get` / `workflow_keys` tools dispatch through this module.
 *
 * Why not pass via AgentRunOptions: the workflow runner already constructs
 * per-card `AgentRunOptions`; threading the same scratchpad reference
 * through dispatch (which is keyed on tool name, not run identity) would
 * require a bigger refactor of the dispatch signature. Module-local
 * singleton is acceptable because JS is single-threaded and only one
 * workflow run is in flight at a time (provider enforces that).
 *
 * Cap: 64 KiB total JSON size. Cards that exceed it get an error result;
 * UX surface is a console diag + the tool returns ok:false so the model
 * sees the failure.
 */

import { logDiag } from "../diagnostics";

export const SCRATCHPAD_MAX_BYTES = 64 * 1024;

/** Internal shape — kept narrow so the keys/values remain JSON-roundtrip-safe. */
type ScratchValue = string | number | boolean | null | ScratchObj | ScratchValue[];
interface ScratchObj {
  [k: string]: ScratchValue;
}

interface ActiveScratchpad {
  workflowId: number;
  runStartedAt: number;
  data: Record<string, ScratchValue>;
}

let active: ActiveScratchpad | null = null;

/** Called by the workflow runner before any card runs. Initializes an
 *  empty scratchpad scoped to this run. Safe to call repeatedly — last
 *  call wins, the previous run's scratchpad is discarded. */
export function beginRun(workflowId: number): void {
  active = {
    workflowId,
    runStartedAt: Date.now(),
    data: {},
  };
}

/** Called by the workflow runner when the run terminates (success,
 *  failure, abort). Releases the scratchpad so subsequent chat-mode
 *  calls to the workflow_* tools return "not in workflow". */
export function endRun(): void {
  active = null;
}

/** True when a workflow run is in flight; the workflow_* tools are
 *  only meaningful in this window. */
export function isActive(): boolean {
  return active !== null;
}

/** Serialized size estimate. JSON.stringify is a cheap upper bound
 *  (whitespace minimal). Used to enforce SCRATCHPAD_MAX_BYTES on
 *  every `set`. */
function approxBytes(d: Record<string, ScratchValue>): number {
  try {
    return JSON.stringify(d).length;
  } catch {
    return 0;
  }
}

/** Set a scratchpad entry. Returns ok:false when no run is active OR
 *  when the new size would exceed the cap. */
export function setEntry(key: string, value: ScratchValue): {
  ok: boolean;
  kind?: string;
  message?: string;
} {
  if (!active) {
    return { ok: false, kind: "not_in_workflow", message: "workflow_set is only callable during a workflow run." };
  }
  if (!key || typeof key !== "string") {
    return { ok: false, kind: "bad_key", message: "key must be a non-empty string." };
  }
  // Cheap structural validation — reject Date / RegExp / Symbol / function
  // by round-tripping through JSON. Any value that survives this is a
  // safe ScratchValue.
  let normalized: ScratchValue;
  try {
    normalized = JSON.parse(JSON.stringify(value));
  } catch {
    return { ok: false, kind: "bad_value", message: "value must be JSON-serializable." };
  }
  const next = { ...active.data, [key]: normalized };
  const size = approxBytes(next);
  if (size > SCRATCHPAD_MAX_BYTES) {
    return {
      ok: false,
      kind: "size_cap",
      message: `scratchpad would exceed ${SCRATCHPAD_MAX_BYTES} bytes (would be ${size}).`,
    };
  }
  active.data = next;
  return { ok: true };
}

/** Read a scratchpad entry by key. Returns ok:false on missing key OR
 *  when no run is active. Distinct kinds so the model can disambiguate. */
export function getEntry(key: string): {
  ok: boolean;
  value?: ScratchValue;
  kind?: string;
  message?: string;
} {
  if (!active) {
    return { ok: false, kind: "not_in_workflow" };
  }
  if (!(key in active.data)) {
    return { ok: false, kind: "missing_key", message: `no entry for "${key}".` };
  }
  return { ok: true, value: active.data[key] };
}

/** List the current scratchpad's keys. */
export function listKeys(): { ok: boolean; keys?: string[]; kind?: string } {
  if (!active) return { ok: false, kind: "not_in_workflow" };
  return { ok: true, keys: Object.keys(active.data) };
}

/** Test-only escape hatch. The endRun path is the supported way to
 *  clear; this is for unit tests that run setEntry/getEntry without a
 *  surrounding runner. Module exports it under a `__` prefix so the
 *  intent stays loud. */
export function __resetForTests(): void {
  active = null;
}

/** Debug snapshot. NOT exposed via tools — internal use (e.g. UI panel
 *  showing the live scratchpad). Returns a structural clone so a caller
 *  can't mutate live state. */
export function snapshot(): { workflowId: number; entries: Record<string, ScratchValue> } | null {
  if (!active) return null;
  try {
    return {
      workflowId: active.workflowId,
      entries: JSON.parse(JSON.stringify(active.data)),
    };
  } catch (e) {
    logDiag({
      level: "warn",
      source: "workflow-scratchpad",
      message: "snapshot serialization failed",
      detail: e,
    });
    return null;
  }
}
