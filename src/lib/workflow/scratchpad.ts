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
/** Hard cap on key count — prevents a runaway card from filling the pad
 *  with tens of thousands of tiny entries even when byte count stays low.
 *  Audit M10 (2026-05-27). */
export const SCRATCHPAD_MAX_KEYS = 256;

/** Internal shape — kept narrow so the keys/values remain JSON-roundtrip-safe. */
type ScratchValue = string | number | boolean | null | ScratchObj | ScratchValue[];
interface ScratchObj {
  [k: string]: ScratchValue;
}

interface ActiveScratchpad {
  workflowId: number;
  runStartedAt: number;
  data: Record<string, ScratchValue>;
  /** Cached byte total. Maintained incrementally so setEntry doesn't
   *  re-stringify the entire pad on every write (was O(n²) over a card
   *  that writes many keys — audit M10). Updated by recomputing only
   *  the changed key's contribution. */
  bytesUsed: number;
}

let active: ActiveScratchpad | null = null;

/** Called by the workflow runner before any card runs. Initializes an
 *  empty scratchpad scoped to this run.
 *
 *  Audit M9 (2026-05-27): previously last-call-wins silently. Two
 *  scheduled triggers firing during an in-flight run would overwrite
 *  the live scratchpad mid-flight. Now refuses if a run is already
 *  active and logs a diag — the caller is expected to dedupe before
 *  reaching here (handleWorkflowTrigger). */
export function beginRun(workflowId: number): boolean {
  if (active !== null) {
    logDiag({
      level: "warn",
      source: "workflow-scratchpad",
      message: "beginRun refused: a workflow run is already active",
      detail: { existingWorkflowId: active.workflowId, requestedWorkflowId: workflowId },
    });
    return false;
  }
  active = {
    workflowId,
    runStartedAt: Date.now(),
    data: {},
    bytesUsed: 2, // "{}" baseline
  };
  return true;
}

/** Called by the workflow runner when the run terminates (success,
 *  failure, abort). Releases the scratchpad so subsequent chat-mode
 *  calls to the workflow_* tools return "not in workflow". */
export function endRun(): void {
  active = null;
}

/** Empty the active scratchpad WITHOUT ending the run. Used by the
 *  `blackboard` orchestration node's "clear" op so downstream cards start
 *  from a clean shared state. No-op when no run is active. Returns true if a
 *  pad was cleared. */
export function clearAll(): boolean {
  if (!active) return false;
  active.data = {};
  active.bytesUsed = 2; // "{}" baseline
  return true;
}

/** Bytes a single key:value pair contributes to the JSON object form,
 *  including the leading comma when not the first key. Stringify of the
 *  KEY and VALUE only — no whole-pad rescan. (Audit M10.) */
function pairBytes(key: string, value: ScratchValue, isFirst: boolean): number {
  // `"key":<value>` plus the comma separator if not first.
  return (
    JSON.stringify(key).length
    + 1 // ':'
    + JSON.stringify(value).length
    + (isFirst ? 0 : 1) // ','
  );
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
  // Key-count cap (audit M10) — defends against runaway cards that fill
  // the pad with tiny entries even when byte count stays under the
  // overall cap.
  const replacingExisting = Object.prototype.hasOwnProperty.call(active.data, key);
  const nextKeyCount = active.data
    ? Object.keys(active.data).length + (replacingExisting ? 0 : 1)
    : 1;
  if (nextKeyCount > SCRATCHPAD_MAX_KEYS) {
    return {
      ok: false,
      kind: "key_cap",
      message: `scratchpad would exceed ${SCRATCHPAD_MAX_KEYS} keys.`,
    };
  }
  // Incremental byte accounting (audit M10) — previously O(n²) due to
  // full-pad stringify per write. Now subtract old contribution + add
  // new contribution and compare against the cap. JSON-object form is
  // `{` + key1pair + ',' + key2pair + ... + `}`, so we account for the
  // 2-byte `{}` frame in `bytesUsed` initial value and per-pair commas
  // via `pairBytes(isFirst)`.
  const keysBefore = Object.keys(active.data).length;
  const oldContribution = replacingExisting
    ? pairBytes(key, active.data[key], false)
    : 0;
  // The new pair is "not first" if there are already other keys present
  // (i.e. keys_before > 1 when replacing, or keys_before > 0 when adding).
  const otherKeyCount = replacingExisting ? keysBefore - 1 : keysBefore;
  const newContribution = pairBytes(key, normalized, otherKeyCount === 0);
  const nextBytes = active.bytesUsed - oldContribution + newContribution;
  if (nextBytes > SCRATCHPAD_MAX_BYTES) {
    return {
      ok: false,
      kind: "size_cap",
      message: `scratchpad would exceed ${SCRATCHPAD_MAX_BYTES} bytes (would be ${nextBytes}).`,
    };
  }
  active.data[key] = normalized;
  active.bytesUsed = nextBytes;
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
