import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the runner so we can control the inner loop's resolution timing,
// without spinning up a real Ollama client or Tauri APIs.
const runAgentLoopMock = vi.fn();
vi.mock("../runner", () => ({
  runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args),
}));

// agent-presets is lazy-imported inside subagent.ts — return an empty list.
vi.mock("../../agent-presets", () => ({
  loadAllPresets: () => [],
}));

import {
  __resetSubagentRegistryForTests,
  awaitSubagents,
  listSubagents,
  spawnSubagentAsync,
} from "../subagent";
import type { AgentRunOptions } from "../types";

function makeParent(signal?: AbortSignal): AgentRunOptions {
  return {
    model: "test",
    messages: [],
    conversationId: 1,
    workspaceRoot: null,
    onUpdate: () => {},
    onStatusChange: () => {},
    requestConfirmation: async () => ({ approve: true }),
    signal: signal ?? new AbortController().signal,
  };
}

describe("async subagent spawn", () => {
  beforeEach(() => {
    runAgentLoopMock.mockReset();
    __resetSubagentRegistryForTests();
  });
  afterEach(() => {
    __resetSubagentRegistryForTests();
  });

  it("returns immediately with a subagent_id and status='running'", async () => {
    // Make the inner runAgentLoop hang until we release it.
    let release: (v: string) => void = () => {};
    runAgentLoopMock.mockImplementation(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );

    const t0 = Date.now();
    const raw = await spawnSubagentAsync({ prompt: "hello" }, makeParent());
    const elapsed = Date.now() - t0;

    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("running");
    expect(typeof parsed.subagent_id).toBe("string");
    expect(parsed.subagent_id.startsWith("sa_")).toBe(true);
    // Should not block on the (still-hanging) inner loop.
    expect(elapsed).toBeLessThan(150);

    // list_subagents should now show this one as running.
    const listing = JSON.parse(listSubagents());
    expect(listing.subagents.length).toBe(1);
    expect(listing.subagents[0].id).toBe(parsed.subagent_id);
    expect(listing.subagents[0].status).toBe("running");

    // Release the inner loop so the test doesn't leak a dangling promise.
    release("final-answer");
    // Give the microtask queue a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("await_subagents joins finished subagents and returns their results", async () => {
    runAgentLoopMock
      .mockImplementationOnce(async () => "answer-1")
      .mockImplementationOnce(async () => "answer-2");

    const a = JSON.parse(await spawnSubagentAsync({ prompt: "task A" }, makeParent()));
    const b = JSON.parse(await spawnSubagentAsync({ prompt: "task B" }, makeParent()));

    const joined = JSON.parse(await awaitSubagents([a.subagent_id, b.subagent_id], 5_000));
    expect(joined.ok).toBe(true);
    expect(joined.timed_out).toBe(false);
    expect(joined.results).toHaveLength(2);
    const byId = Object.fromEntries(
      joined.results.map((r: { id: string }) => [r.id, r]),
    ) as Record<string, { status: string; result: string }>;

    expect(byId[a.subagent_id].status).toBe("done");
    expect(byId[b.subagent_id].status).toBe("done");
    const aResult = JSON.parse(byId[a.subagent_id].result);
    // Subagent answers are now wrapped in the shared <untrusted-data> fence
    // before re-entering the parent loop (sec follow-up); the original text is
    // preserved inside.
    expect(aResult.answer).toContain("answer-1");
    expect(aResult.answer).toContain('<untrusted-data source="subagent">');
    const bResult = JSON.parse(byId[b.subagent_id].result);
    expect(bResult.answer).toContain("answer-2");
  });

  it("await_subagents returns partial on timeout: finished subagents include result, others marked 'timeout'", async () => {
    // First subagent finishes quickly; second hangs past our timeout.
    let releaseSlow: (v: string) => void = () => {};
    runAgentLoopMock
      .mockImplementationOnce(async () => "fast")
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => { releaseSlow = resolve; }),
      );

    const fast = JSON.parse(await spawnSubagentAsync({ prompt: "quick" }, makeParent()));
    const slow = JSON.parse(await spawnSubagentAsync({ prompt: "slow" }, makeParent()));

    // Let the fast one finish before we await.
    await new Promise((r) => setTimeout(r, 10));

    const joined = JSON.parse(await awaitSubagents([fast.subagent_id, slow.subagent_id], 50));
    expect(joined.timed_out).toBe(true);

    const byId = Object.fromEntries(
      joined.results.map((r: { id: string }) => [r.id, r]),
    ) as Record<string, { status: string; result: string }>;

    expect(byId[fast.subagent_id].status).toBe("done");
    expect(JSON.parse(byId[fast.subagent_id].result).answer).toContain("fast");
    expect(byId[slow.subagent_id].status).toBe("timeout");
    expect(JSON.parse(byId[slow.subagent_id].result).kind).toBe("timeout");

    // The slow one is still running in the registry.
    const stillThere = JSON.parse(listSubagents()).subagents.find(
      (s: { id: string }) => s.id === slow.subagent_id,
    );
    expect(stillThere.status).toBe("running");

    // Cleanup.
    releaseSlow("late");
    await new Promise((r) => setTimeout(r, 0));
  });

  it("enforces MAX_SUBAGENT_DEPTH (=3) on async spawns too", async () => {
    const parent = { ...makeParent(), _subagentDepth: 3 } as AgentRunOptions;
    const raw = await spawnSubagentAsync({ prompt: "too deep" }, parent);
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe("depth_exceeded");
    // runAgentLoop must NOT have been invoked.
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("aborting the parent signal cancels child subagents", async () => {
    let receivedSignal: AbortSignal | undefined;
    runAgentLoopMock.mockImplementation(async (opts: AgentRunOptions) => {
      receivedSignal = opts.signal;
      // Wait for abort.
      return new Promise<string>((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const ctrl = new AbortController();
    const sa = JSON.parse(await spawnSubagentAsync({ prompt: "long" }, makeParent(ctrl.signal)));

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
    ctrl.abort();
    expect(receivedSignal!.aborted).toBe(true);

    // The subagent should resolve into an error/cancelled state.
    const joined = JSON.parse(await awaitSubagents([sa.subagent_id], 500));
    const entry = joined.results[0];
    expect(["cancelled", "error"]).toContain(entry.status);
  });
});
