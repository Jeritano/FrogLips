/**
 * Run-scoped rate limit for `workflow_invoke_skill` agent tool calls.
 *
 * A skill is a saved sequence of tool calls a card can replay by name.
 * Without a guard, a confused or adversarial model can loop a skill that
 * itself invokes another skill (or even — once a future iteration lifts the
 * client-side forbidden-tools check — invokes itself) and burn through
 * tool quota with no upper bound.
 *
 * Lifecycle mirrors {@link ./scratchpad.ts}: `beginSkillRun` is called by
 * `runWorkflow` before any card runs; `endSkillRun` clears state at the
 * end of the workflow regardless of success/failure. Outside that
 * window, `recordSkillInvocation` is a no-op that always returns ok —
 * the caller should already have failed the call with `not_in_workflow`
 * via the scratchpad snapshot guard. We don't want this module to lie
 * about the cap when it can't observe the surrounding run.
 *
 * Cap is per-skill-name, not aggregate: the model can usefully invoke 9
 * different skills in a row without tripping; what it can't do is hammer
 * the same skill 11 times.
 */

/** Maximum times the same skill name may be invoked within a single workflow run. */
export const PER_RUN_SKILL_INVOCATION_CAP = 10;

interface ActiveSkillRun {
  /** Per-skill-name invocation count for the current workflow run. */
  counts: Map<string, number>;
}

let active: ActiveSkillRun | null = null;

/** Called by the workflow runner before any card runs. */
export function beginSkillRun(): void {
  active = { counts: new Map() };
}

/** Called by the workflow runner when the run terminates. */
export function endSkillRun(): void {
  active = null;
}

/**
 * Record one invocation of `name`. Returns `{ok:true}` when the call
 * fits within the cap (and bumps the counter), or `{ok:false, count, cap}`
 * when the call would be the (cap+1)th — the counter is NOT bumped past
 * the cap so a runaway loop stays observably stuck at the cap value.
 *
 * Outside an active run (`beginSkillRun` not called) this returns ok:true
 * unconditionally — the surrounding workflow-context check is the real
 * gate; this module only adds the per-skill ceiling.
 */
export function recordSkillInvocation(
  name: string,
): { ok: true } | { ok: false; count: number; cap: number } {
  if (!active) return { ok: true };
  const prev = active.counts.get(name) ?? 0;
  if (prev >= PER_RUN_SKILL_INVOCATION_CAP) {
    return { ok: false, count: prev, cap: PER_RUN_SKILL_INVOCATION_CAP };
  }
  active.counts.set(name, prev + 1);
  return { ok: true };
}

/** Test-only escape hatch — clears in-process state. */
export function __resetForTests(): void {
  active = null;
}
