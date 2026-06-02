// Runner-level coverage for the Claude-Skills system-message injection
// that happens at the top of `runAgentLoop`. Verifies:
//
//   - 0 enabled skills → no stub or pinned bodies injected
//   - N enabled non-pinned skills → single stub mentioning every name
//   - M pinned skills → M skill bodies injected in enabled-list order,
//     each preceded by the `--- Claude Skill: <name> ---` separator
//   - claude_skill_list IPC failure at chat start does not crash the
//     run; one normal turn completes with no skill messages
//
// Mocking follows the same `vi.hoisted` + module-mock pattern as
// runner-integration.test.ts. We script a single fetch that resolves to
// a final text reply so the loop completes in one iteration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../types";
import type { AgentMetrics } from "../types";

const {
  claudeSkillListMock,
  claudeSkillGetMock,
  auditMock,
  metricsMock,
} = vi.hoisted(() => ({
  claudeSkillListMock: vi.fn(async (_enabledOnly?: boolean) =>
    [] as Array<Record<string, unknown>>),
  claudeSkillGetMock: vi.fn(async (_name: string) =>
    null as Record<string, unknown> | null),
  auditMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
  metricsMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock("../../tauri-api", () => ({
  api: {
    claudeSkillList: claudeSkillListMock,
    claudeSkillGet: claudeSkillGetMock,
    agentClassifyShell: vi.fn(async () => "normal"),
    agentClassifyApplescript: vi.fn(async () => "normal"),
    agentClassifyHttp: vi.fn(async () => "normal"),
    agentCancelShell: vi.fn(async () => {}),
    agentAuditRecord: auditMock,
    agentSessionMetricsRecord: metricsMock,
  },
}));

import { runAgentLoop } from "../runner";
import type { AgentRunOptions } from "../types";

function ollamaFinal(text: string) {
  return { message: { content: text }, prompt_eval_count: 5, eval_count: 9 };
}

/** A single-turn fetch mock — returns final text, no tool calls. */
function singleTurnFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify(ollamaFinal("done")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function baseOpts(collected: Message[][], metrics: { last: AgentMetrics | null }): AgentRunOptions {
  return {
    model: "test",
    messages: [{ conversation_id: 1, role: "user", content: "hi" }],
    conversationId: 1,
    workspaceRoot: null,
    onUpdate: (m) => collected.push([...m]),
    onStatusChange: () => {},
    onMetrics: (m) => { metrics.last = { ...m }; },
    requestConfirmation: async () => ({ approve: true }),
    signal: new AbortController().signal,
  };
}

/** Pull every `role === "system"` message from the final snapshot. */
function systemMsgs(collected: Message[][]): Message[] {
  const last = collected[collected.length - 1] ?? [];
  return last.filter((m) => m.role === "system");
}

beforeEach(() => {
  vi.restoreAllMocks();
  claudeSkillListMock.mockReset();
  claudeSkillListMock.mockResolvedValue([]);
  claudeSkillGetMock.mockReset();
  claudeSkillGetMock.mockResolvedValue(null);
  auditMock.mockClear();
  metricsMock.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("runAgentLoop — Claude Skills injection", () => {
  it("does not inject any stub when there are zero enabled skills", async () => {
    claudeSkillListMock.mockResolvedValue([]);
    vi.stubGlobal("fetch", singleTurnFetch());

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(baseOpts(collected, metrics));

    expect(result).toBe("done");
    const sys = systemMsgs(collected);
    // Only the canonical system prompt — no Claude-Skills add-on.
    expect(sys.length).toBe(1);
    expect(sys[0].content).not.toContain("Claude Skills");
    expect(claudeSkillGetMock).not.toHaveBeenCalled();
  });

  it("injects a single stub mentioning every enabled non-pinned skill", async () => {
    claudeSkillListMock.mockResolvedValue([
      { id: 1, name: "pdf-extractor", description: "Extract PDF tables", source_path: "/sk/pdf", enabled: true, pinned: false },
      { id: 2, name: "react-helper", description: "React patterns reference", source_path: "/sk/react", enabled: true, pinned: false },
      { id: 3, name: "yaml-linter", description: "Lint YAML configs", source_path: "/sk/yaml", enabled: true, pinned: false },
    ]);
    vi.stubGlobal("fetch", singleTurnFetch());

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    await runAgentLoop(baseOpts(collected, metrics));

    const sys = systemMsgs(collected);
    // Canonical system prompt + one stub system message.
    expect(sys.length).toBe(2);
    const stub = sys.find((m) => m.content.includes("imported Claude Skills"));
    expect(stub).toBeDefined();
    expect(stub!.content).toContain("Tool-name translation");
    expect(stub!.content).toContain("Read → read_file");
    expect(stub!.content).toContain("Bash → run_shell");
    expect(stub!.content).toContain("- pdf-extractor: Extract PDF tables");
    expect(stub!.content).toContain("- react-helper: React patterns reference");
    expect(stub!.content).toContain("- yaml-linter: Lint YAML configs");
    // The stub is a single message, not one per skill.
    expect(systemMsgs(collected).filter((m) => m.content.includes("imported Claude Skills"))).toHaveLength(1);
    // Pinned-body get path was never invoked.
    expect(claudeSkillGetMock).not.toHaveBeenCalled();
  });

  it("injects M pinned-skill bodies in enabled-list order, each with a separator", async () => {
    claudeSkillListMock.mockResolvedValue([
      { id: 1, name: "alpha", description: "first pinned", source_path: "/a", enabled: true, pinned: true },
      { id: 2, name: "beta", description: "second pinned", source_path: "/b", enabled: true, pinned: true },
    ]);
    claudeSkillGetMock.mockImplementation(async (name: string) => {
      if (name === "alpha") {
        return { id: 1, name: "alpha", description: "first pinned", source_path: "/a", enabled: true, pinned: true, body_md: "ALPHA-BODY-CONTENT", allowed_tools_json: null, imported_at: 1 };
      }
      if (name === "beta") {
        return { id: 2, name: "beta", description: "second pinned", source_path: "/b", enabled: true, pinned: true, body_md: "BETA-BODY-CONTENT", allowed_tools_json: null, imported_at: 2 };
      }
      return null;
    });
    vi.stubGlobal("fetch", singleTurnFetch());

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    await runAgentLoop(baseOpts(collected, metrics));

    const sys = systemMsgs(collected);
    // Canonical system + pinned-bodies combined message. No non-pinned
    // stub because every enabled skill is pinned.
    expect(sys.length).toBe(2);
    const pinnedMsg = sys.find((m) => m.content.includes("--- Claude Skill: alpha ---"));
    expect(pinnedMsg).toBeDefined();
    expect(pinnedMsg!.content).toContain("ALPHA-BODY-CONTENT");
    expect(pinnedMsg!.content).toContain("--- Claude Skill: beta ---");
    expect(pinnedMsg!.content).toContain("BETA-BODY-CONTENT");
    // Order preserved: alpha precedes beta in the rendered content.
    const idxAlpha = pinnedMsg!.content.indexOf("--- Claude Skill: alpha ---");
    const idxBeta = pinnedMsg!.content.indexOf("--- Claude Skill: beta ---");
    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxBeta).toBeGreaterThan(idxAlpha);
    expect(claudeSkillGetMock).toHaveBeenCalledTimes(2);
  });

  it("emits both stub and pinned bodies when the enabled set contains a mix", async () => {
    claudeSkillListMock.mockResolvedValue([
      { id: 1, name: "alpha", description: "pinned one", source_path: "/a", enabled: true, pinned: true },
      { id: 2, name: "gamma", description: "non-pinned helper", source_path: "/g", enabled: true, pinned: false },
    ]);
    claudeSkillGetMock.mockResolvedValue({
      id: 1, name: "alpha", description: "pinned one", source_path: "/a",
      enabled: true, pinned: true, body_md: "ALPHA-BODY", allowed_tools_json: null, imported_at: 1,
    });
    vi.stubGlobal("fetch", singleTurnFetch());

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    await runAgentLoop(baseOpts(collected, metrics));

    const sys = systemMsgs(collected);
    // Canonical + stub + pinned-bodies = 3.
    expect(sys.length).toBe(3);
    expect(sys.some((m) => m.content.includes("- gamma: non-pinned helper"))).toBe(true);
    expect(sys.some((m) => m.content.includes("ALPHA-BODY"))).toBe(true);
    // Pinned-body get was called only for the pinned skill.
    expect(claudeSkillGetMock).toHaveBeenCalledWith("alpha");
    expect(claudeSkillGetMock).toHaveBeenCalledTimes(1);
  });

  it("does not crash when claude_skill_list throws — completes one normal turn with no skill context", async () => {
    claudeSkillListMock.mockRejectedValue(new Error("ipc unavailable"));
    vi.stubGlobal("fetch", singleTurnFetch());

    const collected: Message[][] = [];
    const metrics = { last: null as AgentMetrics | null };
    const result = await runAgentLoop(baseOpts(collected, metrics));

    expect(result).toBe("done");
    const sys = systemMsgs(collected);
    // Only the canonical system prompt — no Claude-Skills add-on.
    expect(sys.length).toBe(1);
    expect(sys[0].content).not.toContain("imported Claude Skills");
    expect(claudeSkillGetMock).not.toHaveBeenCalled();
  });
});
