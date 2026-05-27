// Dispatch coverage for the five `workflow_*_skill` agent tool arms in
// dispatch.ts. The skill family is procedural memory — a card saves a
// sequence of tool calls under a name, later runs replay it via
// workflow_invoke_skill. Coverage here:
//
//   - save: routes to api.workflowSkillSave with the snapshot's workflow_id
//   - save: client-side rejects steps using forbidden tools
//   - list/get/delete: route correctly
//   - invoke: walks each step through executeTool, aborts on first failure
//   - invoke: shallow-merges args_override into each step
//   - invoke: records invocation count on success
//   - invoke: returns not_in_workflow when no scratchpad snapshot
//   - invoke: returns rate_limit_hit on the 11th call to the same skill
//   - invoke: emits skill_invocation_start + skill_invocation_end audit rows

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────
// vi.hoisted runs before any `vi.mock` factories so the same vi.fn refs
// flow into both the api mock and the assertions.
const mocks = vi.hoisted(() => ({
  workflowSkillSave: vi.fn<
    (id: number, name: string, desc: string, stepsJson: string, overwrite?: boolean) => Promise<number>
  >(async () => 42),
  workflowSkillList: vi.fn(async () => [] as Array<Record<string, unknown>>),
  workflowSkillGet: vi.fn(async (_id: number, _name: string) => null as Record<string, unknown> | null),
  workflowSkillDelete: vi.fn(async () => undefined),
  workflowSkillRecordInvocation: vi.fn(async () => undefined),
  agentAuditRecord: vi.fn<(entry: { tool_name: string }) => Promise<void>>(async () => undefined),
  // Snapshot mock — flipped between null and an active workflow per test.
  scratchpadSnapshot: vi.fn(() => ({ workflowId: 7, entries: {} }) as { workflowId: number; entries: Record<string, unknown> } | null),
}));

vi.mock("../../tauri-api", () => ({
  api: {
    workflowSkillSave: mocks.workflowSkillSave,
    workflowSkillList: mocks.workflowSkillList,
    workflowSkillGet: mocks.workflowSkillGet,
    workflowSkillDelete: mocks.workflowSkillDelete,
    workflowSkillRecordInvocation: mocks.workflowSkillRecordInvocation,
    agentAuditRecord: mocks.agentAuditRecord,
    // Stubbed inner tool — invoked when steps replay via executeTool.
    // We use `read_file` as the canonical replayed step in tests because
    // it's a no-approval read path and its arm routes to a single api
    // method we can spy on.
    agentReadFile: vi.fn(async (path: string) => ({ path, content: "x", bytes_read: 1, total_bytes: 1, truncated: false, binary: false })),
    agentListDir: vi.fn(async (path: string) => ({ path, entries: [], truncated: false })),
  },
}));

vi.mock("../../workflow/scratchpad", () => ({
  snapshot: mocks.scratchpadSnapshot,
}));

// Real skill-invocations module — we want the actual counter behaviour
// for the rate-limit test, just with manual lifecycle control.
import {
  __resetForTests as __resetSkillInvocations,
  beginSkillRun,
  endSkillRun,
} from "../../workflow/skill-invocations";

import { api } from "../../tauri-api";
import { executeTool } from "../dispatch";

beforeEach(() => {
  mocks.workflowSkillSave.mockClear();
  mocks.workflowSkillSave.mockResolvedValue(42);
  mocks.workflowSkillList.mockClear();
  mocks.workflowSkillList.mockResolvedValue([]);
  mocks.workflowSkillGet.mockClear();
  mocks.workflowSkillGet.mockResolvedValue(null);
  mocks.workflowSkillDelete.mockClear();
  mocks.workflowSkillRecordInvocation.mockClear();
  mocks.agentAuditRecord.mockClear();
  mocks.scratchpadSnapshot.mockReset();
  mocks.scratchpadSnapshot.mockReturnValue({ workflowId: 7, entries: {} });
  __resetSkillInvocations();
  (api.agentReadFile as ReturnType<typeof vi.fn>).mockClear();
});

describe("workflow_save_skill", () => {
  it("routes to api.workflowSkillSave with the snapshot's workflow_id", async () => {
    const steps = [{ tool: "read_file", args: { path: "/a" } }];
    const out = await executeTool("workflow_save_skill", {
      name: "my-skill",
      description: "does a thing",
      steps,
    });
    expect(api.workflowSkillSave).toHaveBeenCalledWith(
      7,
      "my-skill",
      "does a thing",
      JSON.stringify(steps),
      false,
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(42);
    expect(parsed.name).toBe("my-skill");
  });

  it("forwards overwrite=true", async () => {
    await executeTool("workflow_save_skill", {
      name: "s",
      description: "d",
      steps: [{ tool: "read_file", args: { path: "/x" } }],
      overwrite: true,
    });
    expect(api.workflowSkillSave).toHaveBeenCalledWith(7, "s", "d", expect.any(String), true);
  });

  it("returns not_in_workflow when no scratchpad snapshot", async () => {
    mocks.scratchpadSnapshot.mockReturnValue(null);
    const out = await executeTool("workflow_save_skill", {
      name: "s", description: "d", steps: [],
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("not_in_workflow");
    expect(api.workflowSkillSave).not.toHaveBeenCalled();
  });

  it.each([
    "workflow_invoke_skill",
    "workflow_save_skill",
    "workflow_delete_skill",
    "spawn_subagent",
    "await_subagents",
  ])("client-side rejects forbidden step tool %s before round-tripping", async (forbidden) => {
    const out = await executeTool("workflow_save_skill", {
      name: "s",
      description: "d",
      steps: [{ tool: forbidden, args: {} }],
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("forbidden_step_tool");
    expect(api.workflowSkillSave).not.toHaveBeenCalled();
  });

  it("rejects empty name without round-tripping", async () => {
    const out = await executeTool("workflow_save_skill", { name: "", description: "d", steps: [] });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("bad_args");
    expect(api.workflowSkillSave).not.toHaveBeenCalled();
  });

  it("rejects non-array steps", async () => {
    const out = await executeTool("workflow_save_skill", {
      name: "s",
      description: "d",
      steps: "oops" as unknown as unknown[],
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("bad_args");
  });
});

describe("workflow_list_skills", () => {
  it("routes to api.workflowSkillList with the snapshot's workflow_id", async () => {
    mocks.workflowSkillList.mockResolvedValue([
      { id: 1, name: "a", description: "", last_used_at: null, invocation_count: 0 },
    ]);
    const out = await executeTool("workflow_list_skills", {});
    expect(api.workflowSkillList).toHaveBeenCalledWith(7);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.skills).toHaveLength(1);
  });

  it("returns not_in_workflow when no snapshot", async () => {
    mocks.scratchpadSnapshot.mockReturnValue(null);
    const out = await executeTool("workflow_list_skills", {});
    expect(JSON.parse(out).kind).toBe("not_in_workflow");
    expect(api.workflowSkillList).not.toHaveBeenCalled();
  });
});

describe("workflow_get_skill", () => {
  it("routes to api.workflowSkillGet and returns the skill", async () => {
    mocks.workflowSkillGet.mockResolvedValue({
      id: 1, name: "s", description: "d", last_used_at: null, invocation_count: 0,
      workflow_id: 7, steps_json: "[]", created_at: 1,
    });
    const out = await executeTool("workflow_get_skill", { name: "s" });
    expect(api.workflowSkillGet).toHaveBeenCalledWith(7, "s");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.skill.name).toBe("s");
  });

  it("returns not_found when the api returns null", async () => {
    mocks.workflowSkillGet.mockResolvedValue(null);
    const out = await executeTool("workflow_get_skill", { name: "nope" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("not_found");
  });
});

describe("workflow_delete_skill", () => {
  it("routes to api.workflowSkillDelete", async () => {
    const out = await executeTool("workflow_delete_skill", { name: "s" });
    expect(api.workflowSkillDelete).toHaveBeenCalledWith(7, "s");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe("s");
  });

  it("returns not_in_workflow when no snapshot", async () => {
    mocks.scratchpadSnapshot.mockReturnValue(null);
    const out = await executeTool("workflow_delete_skill", { name: "s" });
    expect(JSON.parse(out).kind).toBe("not_in_workflow");
    expect(api.workflowSkillDelete).not.toHaveBeenCalled();
  });
});

describe("workflow_invoke_skill", () => {
  function skillWith(stepsJson: string) {
    return {
      id: 1,
      name: "s",
      description: "d",
      last_used_at: null,
      invocation_count: 0,
      workflow_id: 7,
      steps_json: stepsJson,
      created_at: 1,
    };
  }

  it("fetches skill, replays each step via executeTool, records invocation", async () => {
    mocks.workflowSkillGet.mockResolvedValue(
      skillWith(JSON.stringify([
        { tool: "read_file", args: { path: "/a" } },
        { tool: "read_file", args: { path: "/b" } },
      ])),
    );
    const out = await executeTool("workflow_invoke_skill", { name: "s" });
    expect(api.workflowSkillGet).toHaveBeenCalledWith(7, "s");
    expect(api.agentReadFile).toHaveBeenNthCalledWith(1, "/a", undefined, undefined);
    expect(api.agentReadFile).toHaveBeenNthCalledWith(2, "/b", undefined, undefined);
    expect(api.workflowSkillRecordInvocation).toHaveBeenCalledWith(7, "s");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.skill).toBe("s");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].tool).toBe("read_file");
  });

  it("shallow-merges args_override into each step's args", async () => {
    mocks.workflowSkillGet.mockResolvedValue(
      skillWith(JSON.stringify([
        { tool: "read_file", args: { path: "/orig", offset: 0 } },
      ])),
    );
    await executeTool("workflow_invoke_skill", {
      name: "s",
      args_override: { path: "/override", limit: 256 },
    });
    expect(api.agentReadFile).toHaveBeenCalledWith("/override", 0, 256);
  });

  it("aborts on the first step that returns ok:false", async () => {
    // First step routes to read_file which we make return a synthetic
    // ok:false payload by stubbing the api to throw a JSON-encoded error.
    // Simpler approach: use a step whose result the dispatch arm wraps in
    // an ok:false because the tool itself is unknown.
    mocks.workflowSkillGet.mockResolvedValue(
      skillWith(JSON.stringify([
        { tool: "definitely_not_a_real_tool", args: {} },
        { tool: "read_file", args: { path: "/should-not-run" } },
      ])),
    );
    const out = await executeTool("workflow_invoke_skill", { name: "s" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].kind).toBe("unknown_tool");
    expect(api.agentReadFile).not.toHaveBeenCalled();
  });

  it("returns not_in_workflow when no scratchpad snapshot", async () => {
    mocks.scratchpadSnapshot.mockReturnValue(null);
    const out = await executeTool("workflow_invoke_skill", { name: "s" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("not_in_workflow");
    expect(api.workflowSkillGet).not.toHaveBeenCalled();
  });

  it("returns not_found when the skill doesn't exist", async () => {
    mocks.workflowSkillGet.mockResolvedValue(null);
    const out = await executeTool("workflow_invoke_skill", { name: "ghost" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("not_found");
  });

  it("returns corrupt_steps on bad JSON", async () => {
    mocks.workflowSkillGet.mockResolvedValue(skillWith("not json {"));
    const out = await executeTool("workflow_invoke_skill", { name: "s" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("corrupt_steps");
  });

  it("returns rate_limit_hit on the 11th call to the same skill within a run", async () => {
    beginSkillRun();
    mocks.workflowSkillGet.mockResolvedValue(
      skillWith(JSON.stringify([{ tool: "read_file", args: { path: "/a" } }])),
    );
    // 10 successful calls fit within the cap.
    for (let i = 0; i < 10; i++) {
      const out = await executeTool("workflow_invoke_skill", { name: "s" });
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(true);
    }
    // 11th call must trip the rate limit BEFORE fetching the skill.
    mocks.workflowSkillGet.mockClear();
    const out = await executeTool("workflow_invoke_skill", { name: "s" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("rate_limit_hit");
    expect(parsed.cap).toBe(10);
    expect(api.workflowSkillGet).not.toHaveBeenCalled();
    endSkillRun();
  });

  it("emits skill_invocation_start + skill_invocation_end audit rows", async () => {
    mocks.workflowSkillGet.mockResolvedValue(
      skillWith(JSON.stringify([{ tool: "read_file", args: { path: "/a" } }])),
    );
    await executeTool("workflow_invoke_skill", { name: "s" });
    const calls = mocks.agentAuditRecord.mock.calls.map((c) => c[0].tool_name);
    expect(calls).toContain("skill_invocation_start");
    expect(calls).toContain("skill_invocation_end");
  });
});
