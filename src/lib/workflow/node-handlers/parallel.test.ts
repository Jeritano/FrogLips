import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "../../agent-loop/types";
import type { WorkflowCard } from "../../../types";

/**
 * Parallel fan-out handler. `runAgentLoop` is mocked (same pattern as
 * nodes.test.ts) so the test drives branch behavior deterministically: the
 * responder echoes the sub-run's last user message, letting us assert the
 * fan-out count, per-branch labeling, and the explicit-prompt path without a
 * real LLM.
 */

const calls: AgentRunOptions[] = [];
let responder: (o: AgentRunOptions) => string = () => "ok";

vi.mock("../../agent-loop", () => ({
  runAgentLoop: vi.fn(async (o: AgentRunOptions) => {
    calls.push(o);
    return responder(o);
  }),
}));

import { runParallel } from "./parallel";
import { parallelHandler } from "./parallel";
import { HANDLERS } from "./registry";
import type { NodeRunContext } from "./types";

function lastUser(o: AgentRunOptions): string {
  return (
    [...o.messages].reverse().find((m) => m.role === "user")?.content ?? ""
  );
}

function baseOpts(model = "local"): AgentRunOptions {
  return {
    model,
    messages: [
      { conversation_id: 0, role: "system", content: "SYS" },
      { conversation_id: 0, role: "user", content: "TASK" },
    ],
    conversationId: 0,
    workspaceRoot: null,
    backend: "ollama",
    serverStatus: null,
    onUpdate: () => {},
    onStatusChange: () => {},
    requestConfirmation: async () => ({ approve: false }),
    signal: new AbortController().signal,
  };
}

function ctx(card: Partial<WorkflowCard>, base = baseOpts()): NodeRunContext {
  return {
    card: {
      id: "c",
      name: "n",
      preset: "general",
      prompt: "TASK",
      tools: [],
      schedule: null,
      backend: null,
      x: 0,
      y: 0,
      nodeType: "parallel",
      ...card,
    } as WorkflowCard,
    base,
    presets: [],
    signal: base.signal,
    emit: () => {},
  };
}

beforeEach(() => {
  calls.length = 0;
  responder = () => "ok";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("parallel node", () => {
  it("is registered in the handler registry under its own type", () => {
    expect(HANDLERS.parallel).toBe(parallelHandler);
    expect(parallelHandler.type).toBe("parallel");
  });

  it("runs `members` identical branches and collects them labeled — no synthesis pass", async () => {
    let i = 0;
    responder = () => `out-${++i}`;
    const out = await runParallel(ctx({ nodeConfig: { members: 3 } }));
    // 3 branches, NO extra aggregation call.
    expect(calls).toHaveLength(3);
    // Each branch reuses the card task verbatim (no userContent override).
    expect(calls.every((c) => lastUser(c) === "TASK")).toBe(true);
    // Output is the per-branch labeled concatenation, ordered by branch index.
    expect(out).toContain("### Branch 1");
    expect(out).toContain("### Branch 3");
    expect(out).not.toContain("### Branch 4");
  });

  it("defaults to 3 branches when members is absent", async () => {
    responder = () => "x";
    await runParallel(ctx({ nodeConfig: {} }));
    expect(calls).toHaveLength(3);
  });

  it("uses explicit branchPrompts as distinct per-branch tasks (overriding members)", async () => {
    responder = (o) => `answer:${lastUser(o)}`;
    const out = await runParallel(
      ctx({
        nodeConfig: {
          members: 8, // ignored when branchPrompts is present
          branchPrompts: ["summarize the doc", "list the risks"],
        },
      }),
    );
    expect(calls).toHaveLength(2);
    const tasks = calls.map(lastUser).sort();
    expect(tasks).toEqual(["list the risks", "summarize the doc"]);
    // The label carries the branch's prompt first line for readability.
    expect(out).toContain("### Branch 1 — summarize the doc");
    expect(out).toContain("### Branch 2 — list the risks");
  });

  it("isolates a failed branch instead of failing the whole card", async () => {
    let i = 0;
    responder = () => {
      i += 1;
      if (i === 2) throw new Error("boom");
      return `ok-${i}`;
    };
    const out = await runParallel(ctx({ nodeConfig: { members: 3 } }));
    expect(calls).toHaveLength(3);
    expect(out).toContain("branch 2 failed: boom");
    // Surviving branches still contribute their output.
    expect(out).toContain("### Branch 1");
    expect(out).toContain("### Branch 3");
  });

  it("returns empty and never fans out when aborted up front", async () => {
    const ac = new AbortController();
    ac.abort();
    const base = baseOpts();
    (base as { signal: AbortSignal }).signal = ac.signal;
    const out = await runParallel(ctx({ nodeConfig: { members: 4 } }, base));
    expect(out).toBe("");
    expect(calls).toHaveLength(0); // aborted before any branch started
  });
});
