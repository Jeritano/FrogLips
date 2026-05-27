import { afterEach, describe, expect, it } from "vitest";

import {
  PER_RUN_SKILL_INVOCATION_CAP,
  __resetForTests,
  beginSkillRun,
  endSkillRun,
  recordSkillInvocation,
} from "../skill-invocations";

afterEach(() => {
  __resetForTests();
});

describe("recordSkillInvocation — cap accounting", () => {
  it("returns ok up to the cap, then ok:false on cap+1", () => {
    beginSkillRun();
    for (let i = 0; i < PER_RUN_SKILL_INVOCATION_CAP; i++) {
      expect(recordSkillInvocation("s").ok).toBe(true);
    }
    const trip = recordSkillInvocation("s");
    expect(trip.ok).toBe(false);
    if (trip.ok === false) {
      expect(trip.count).toBe(PER_RUN_SKILL_INVOCATION_CAP);
      expect(trip.cap).toBe(PER_RUN_SKILL_INVOCATION_CAP);
    }
    endSkillRun();
  });

  it("counters are per-skill-name (different names don't share quota)", () => {
    beginSkillRun();
    for (let i = 0; i < PER_RUN_SKILL_INVOCATION_CAP; i++) {
      expect(recordSkillInvocation("a").ok).toBe(true);
    }
    // "a" is at cap; "b" is fresh.
    expect(recordSkillInvocation("a").ok).toBe(false);
    expect(recordSkillInvocation("b").ok).toBe(true);
    endSkillRun();
  });

  it("beginSkillRun resets the counter from a previous run", () => {
    beginSkillRun();
    for (let i = 0; i < PER_RUN_SKILL_INVOCATION_CAP; i++) {
      recordSkillInvocation("s");
    }
    expect(recordSkillInvocation("s").ok).toBe(false);
    endSkillRun();

    // New run — same skill name — should start fresh.
    beginSkillRun();
    expect(recordSkillInvocation("s").ok).toBe(true);
    endSkillRun();
  });

  it("endSkillRun clears state so a stray call outside a run is a no-op ok", () => {
    beginSkillRun();
    recordSkillInvocation("s");
    endSkillRun();
    // Outside a run the function returns ok:true unconditionally — the
    // surrounding workflow-context guard is the authoritative gate.
    expect(recordSkillInvocation("s").ok).toBe(true);
  });

  it("outside an active run, returns ok:true without tracking counts", () => {
    expect(recordSkillInvocation("anything").ok).toBe(true);
    // Confirm: 1000 calls without beginSkillRun never trip the cap.
    for (let i = 0; i < 1000; i++) {
      expect(recordSkillInvocation("anything").ok).toBe(true);
    }
  });
});
