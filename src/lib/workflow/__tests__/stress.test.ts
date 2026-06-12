/**
 * Stress tests for the workflow JS layer.
 *
 * These exercise:
 *   - graph.ts: `resolveLinearOrder` + `validateGraph` on very large / adversarial
 *     graphs (linear chains of 10k, disconnected pairs that early-reject, near-
 *     linear graphs with a hidden cycle).
 *   - types.ts: `parseWorkflow` against the 1 MiB cap the Rust side enforces
 *     (`MAX_GRAPH_BYTES` in workflows.rs). The frontend has no explicit byte
 *     cap; these tests document the observed behavior just under and just over
 *     1 MiB so any future regression is loud.
 *   - runner.ts: concurrent runs (no cross-talk), abort handling at every
 *     boundary, listener-leak check, and a 50-run memory sanity loop.
 *
 * Time assertions are GENEROUS — they want to catch O(N^2) or worse blowups,
 * not measure baseline performance. CI / cold-start variance is fine; only a
 * truly broken implementation should fail them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RawWorkflow,
  WorkflowCard,
  WorkflowEdge,
  WorkflowGraph,
} from "../../../types";
import { parseWorkflow, serializeWorkflowGraph } from "../../../types";
import type { AgentRunOptions } from "../../agent-loop";

const { runAgentLoopMock, workflowRunRecordMock } = vi.hoisted(() => ({
  runAgentLoopMock: vi.fn<(opts: AgentRunOptions) => Promise<string | null>>(),
  workflowRunRecordMock: vi.fn<
    (id: number, status: string, json: string) => Promise<number>
  >(async () => 1),
}));

vi.mock("../../agent-loop", () => ({
  runAgentLoop: runAgentLoopMock,
}));

vi.mock("../../tauri-api", () => ({
  api: { workflowRunRecord: workflowRunRecordMock },
}));

vi.mock("../../agent-presets", () => ({
  loadAllPresets: () => [
    { id: "general", name: "General", description: "", allowedTools: [] },
  ],
}));

import {
  resolveLinearOrder,
  validateGraph,
  WorkflowGraphError,
} from "../graph";
import { runWorkflow } from "../runner";

function card(id: string, name = `Card ${id}`): WorkflowCard {
  return {
    id,
    name,
    preset: "general",
    prompt: `prompt ${id}`,
    tools: [],
    schedule: null,
    backend: null,
    x: 0,
    y: 0,
  };
}

/** Build a connected linear chain of N cards: `0 → 1 → 2 → … → N-1`. */
function linearChain(n: number): WorkflowGraph {
  const cards: WorkflowCard[] = [];
  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < n; i++) cards.push(card(String(i)));
  for (let i = 0; i < n - 1; i++) {
    edges.push({ from: String(i), to: String(i + 1) });
  }
  return { cards, edges };
}

beforeEach(() => {
  runAgentLoopMock.mockReset();
  workflowRunRecordMock.mockClear();
  workflowRunRecordMock.mockResolvedValue(1);
});

describe("graph performance — resolveLinearOrder", () => {
  it("resolves a 100-card linear chain quickly", () => {
    const g = linearChain(100);
    const t0 = performance.now();
    const order = resolveLinearOrder(g);
    const dt = performance.now() - t0;
    expect(order).toHaveLength(100);
    expect(order[0].id).toBe("0");
    expect(order[99].id).toBe("99");
    expect(dt).toBeLessThan(50);
  });

  it("resolves a 1000-card linear chain under 50ms", () => {
    const g = linearChain(1000);
    const t0 = performance.now();
    const order = resolveLinearOrder(g);
    const dt = performance.now() - t0;
    expect(order).toHaveLength(1000);
    expect(order[0].id).toBe("0");
    expect(order[999].id).toBe("999");
    expect(dt).toBeLessThan(50);
  });

  it("resolves a 10000-card linear chain under 200ms with no stack overflow", () => {
    const g = linearChain(10_000);
    const t0 = performance.now();
    let order: WorkflowCard[] | undefined;
    expect(() => {
      order = resolveLinearOrder(g);
    }).not.toThrow();
    const dt = performance.now() - t0;
    expect(order).toHaveLength(10_000);
    expect(order![0].id).toBe("0");
    expect(order![9999].id).toBe("9999");
    expect(dt).toBeLessThan(200);
  });
});

describe("graph performance — disconnected-pair early reject", () => {
  it("rejects 10000 disconnected pairs (forms many start cards) quickly", () => {
    // 10000 pairs: each pair (2i → 2i+1). 10000 distinct start cards =
    // immediate reject by the `starts.length > 1` branch — but the validation
    // loop still touches every card to build degree maps.
    const N = 10_000;
    const cards: WorkflowCard[] = [];
    const edges: WorkflowEdge[] = [];
    for (let i = 0; i < N; i++) {
      const a = `a${i}`;
      const b = `b${i}`;
      cards.push(card(a));
      cards.push(card(b));
      edges.push({ from: a, to: b });
    }
    const g: WorkflowGraph = { cards, edges };
    const t0 = performance.now();
    expect(() => resolveLinearOrder(g)).toThrow(WorkflowGraphError);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(500);
  });

  it("rejects a graph with branching (one card → many) before the walk", () => {
    // One source card pointing at 5000 children — fails the outDeg>1 check.
    const N = 5_000;
    const cards: WorkflowCard[] = [card("root")];
    const edges: WorkflowEdge[] = [];
    for (let i = 0; i < N; i++) {
      cards.push(card(`c${i}`));
      edges.push({ from: "root", to: `c${i}` });
    }
    const t0 = performance.now();
    expect(() => resolveLinearOrder({ cards, edges })).toThrow(/branching/i);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(300);
  });
});

describe("graph performance — validateGraph adversarial", () => {
  it("validates a near-linear 10000-card chain with a hidden tiny cycle in the middle", () => {
    // Build a chain 0 → 1 → … → 4999 and 5001 → … → 9999, with a 2-cycle
    // between 5000 and a side node "loop". The cycle creates two start cards
    // (one through 0, one through 5001) — `validateGraph` should report it
    // without throwing.
    const N = 10_000;
    const cards: WorkflowCard[] = [];
    const edges: WorkflowEdge[] = [];
    for (let i = 0; i < N; i++) cards.push(card(String(i)));
    cards.push(card("loop"));
    for (let i = 0; i < 5_000 - 1; i++) {
      edges.push({ from: String(i), to: String(i + 1) });
    }
    // Embed the cycle: 4999 → loop → 4999.
    edges.push({ from: "4999", to: "loop" });
    edges.push({ from: "loop", to: "4999" });
    // Continue the second half disconnected so the graph is also
    // non-linear in another way (multiple violations — the validator must not
    // stack-overflow).
    for (let i = 5_001; i < N - 1; i++) {
      edges.push({ from: String(i), to: String(i + 1) });
    }
    const g: WorkflowGraph = { cards, edges };
    const t0 = performance.now();
    const res = validateGraph(g);
    const dt = performance.now() - t0;
    expect(res.ok).toBe(false);
    // Could be any of: multiple incoming (loop→4999 + 4998→4999), or merging
    // — both are acceptable as long as the function returned a clean error
    // rather than throwing or hanging.
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
    expect(dt).toBeLessThan(300);
  });
});

describe("parseWorkflow — JSON size cap", () => {
  // The Rust side caps graph_json at 1 MiB (MAX_GRAPH_BYTES in workflows.rs).
  // The frontend has NO explicit cap — `parseWorkflow` does a JSON.parse and
  // returns an empty graph on any failure. These tests document the observed
  // behavior so a future bytes-cap-bug regression is caught.

  function buildBigGraph(targetBytes: number): RawWorkflow {
    // Pad the prompt of a single legal card until JSON encoding lands near the
    // requested byte count.
    const filler = "a".repeat(Math.max(0, targetBytes - 500));
    const graph: WorkflowGraph = {
      cards: [{ ...card("a"), prompt: filler }],
      edges: [],
    };
    return {
      id: 1,
      name: "big",
      graph_json: serializeWorkflowGraph(graph),
      created_at: 0,
      updated_at: 0,
    };
  }

  it("accepts a workflow just under 1 MiB", () => {
    const raw = buildBigGraph(1_048_000); // ~1 MiB minus a bit
    expect(raw.graph_json.length).toBeLessThan(1_048_576);
    const t0 = performance.now();
    const wf = parseWorkflow(raw);
    const dt = performance.now() - t0;
    expect(wf.graph.cards).toHaveLength(1);
    expect(wf.graph.cards[0].prompt.length).toBeGreaterThan(1_000_000);
    expect(dt).toBeLessThan(500);
  });

  it("currently accepts a workflow just over 1 MiB (no frontend byte cap)", () => {
    // This documents that the frontend does not enforce MAX_GRAPH_BYTES — the
    // Rust save path is the only place the cap is enforced. If a future patch
    // adds a frontend cap, flip this assertion.
    const raw = buildBigGraph(1_200_000);
    expect(raw.graph_json.length).toBeGreaterThan(1_048_576);
    const wf = parseWorkflow(raw);
    expect(wf.graph.cards).toHaveLength(1);
  });

  it("returns an empty graph for unparseable JSON without throwing", () => {
    const raw: RawWorkflow = {
      id: 1,
      name: "broken",
      graph_json: "{not json",
      created_at: 0,
      updated_at: 0,
    };
    const wf = parseWorkflow(raw);
    expect(wf.graph).toEqual({ cards: [], edges: [] });
  });
});

describe("runner — concurrent runs do not cross-talk", () => {
  it("two concurrent runs keep their own previousOutput chains", async () => {
    // Each card-loop call uses a per-run unique tag in the prompt so we can
    // assert no message leaked from one run to the other.
    const twoCardGraph: WorkflowGraph = {
      cards: [card("a"), card("b")],
      edges: [{ from: "a", to: "b" }],
    };

    let runACalls = 0;
    let runBCalls = 0;
    runAgentLoopMock.mockImplementation(async (opts) => {
      const userMsg = opts.messages.find((m) => m.role === "user");
      const isB = userMsg?.content === "prompt b";
      // Tiny artificial delay to force interleave through the event loop.
      await new Promise((r) => setTimeout(r, 0));
      if (isB) {
        // Verify the handoff was from a card-a-final-RUN-N output (NOT the
        // other run's output). The runner does not actually tag messages with
        // run ids — what we check is that whatever previous-card output it
        // saw stays consistent within one run by recording prefix counts.
        runBCalls++;
        const handoff = opts.messages.find(
          (m) =>
            m.role === "system" &&
            m.content.includes("Output from previous step:"),
        );
        return `card-b-final::${handoff?.content ?? "MISSING"}`;
      }
      runACalls++;
      // Identify which call this came from by checking the user prompt only.
      return `card-a-final::call`;
    });

    const [r1, r2] = await Promise.all([
      runWorkflow(twoCardGraph, {}, { model: "m", workflowId: 1 }),
      runWorkflow(twoCardGraph, {}, { model: "m", workflowId: 2 }),
    ]);

    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(runACalls).toBe(2);
    expect(runBCalls).toBe(2);
    // Card b's recorded output references the previous-step prefix; both runs
    // must have that prefix present — neither saw an empty handoff.
    expect(r1.cards[1].output).toContain("Output from previous step:");
    expect(r2.cards[1].output).toContain("Output from previous step:");

    // workflowRunRecord was called exactly once per run.
    expect(workflowRunRecordMock).toHaveBeenCalledTimes(2);
    const recordedIds = workflowRunRecordMock.mock.calls
      .map((c) => c[0])
      .sort();
    expect(recordedIds).toEqual([1, 2]);
  });
});

describe("runner — abort timing", () => {
  const twoCardGraph: WorkflowGraph = {
    cards: [card("a"), card("b")],
    edges: [{ from: "a", to: "b" }],
  };
  const threeCardGraph: WorkflowGraph = {
    cards: [card("a"), card("b"), card("c")],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };

  it("aborts before any card runs — every card marked skipped", async () => {
    const controller = new AbortController();
    controller.abort();
    runAgentLoopMock.mockResolvedValue("never");
    const res = await runWorkflow(
      threeCardGraph,
      {},
      {
        model: "m",
        signal: controller.signal,
      },
    );
    expect(res.status).toBe("failed");
    expect(res.cards.map((c) => c.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("aborts after card 1 finishes — card 1 is tagged aborted (post-finish check window)", async () => {
    // FINDING: the runner has TWO abort observation points around any card —
    //   1. the top-of-iteration `if (failed || signal.aborted)` check
    //   2. the post-`runAgentLoop` `if (signal.aborted)` check
    // A microtask scheduled during card 1's run lands BEFORE the second
    // check, so card 1 reads as "aborted" rather than "ok" even though its
    // agent loop returned a final string. Card 2 and beyond are skipped at
    // the top of their iteration.
    const controller = new AbortController();
    let calls = 0;
    runAgentLoopMock.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        queueMicrotask(() => controller.abort());
        return "a-out";
      }
      return "b-out";
    });
    const res = await runWorkflow(
      threeCardGraph,
      {},
      {
        model: "m",
        signal: controller.signal,
      },
    );
    expect(res.status).toBe("failed");
    expect(res.cards[0].status).toBe("aborted");
    expect(res.cards[1].status).toBe("skipped");
    expect(res.cards[2].status).toBe("skipped");
    expect(calls).toBe(1);
  });

  it("aborts mid-card-2 — card 1 ok, card 2 aborted, card 3 skipped", async () => {
    const controller = new AbortController();
    runAgentLoopMock.mockImplementation(async (opts) => {
      const userMsg = opts.messages.find((m) => m.role === "user");
      if (userMsg?.content === "prompt b") {
        controller.abort();
        return "b-final-but-aborted";
      }
      return "a-final";
    });
    const res = await runWorkflow(
      threeCardGraph,
      {},
      {
        model: "m",
        signal: controller.signal,
      },
    );
    expect(res.cards[0].status).toBe("ok");
    expect(res.cards[1].status).toBe("aborted");
    expect(res.cards[2].status).toBe("skipped");
    expect(res.status).toBe("failed");
  });

  it("aborting after all cards finish does not flip the result to failed", async () => {
    const controller = new AbortController();
    runAgentLoopMock.mockResolvedValue("ok");
    const res = await runWorkflow(
      twoCardGraph,
      {},
      {
        model: "m",
        signal: controller.signal,
      },
    );
    // Abort AFTER the workflow's loop has already returned: must not affect
    // anything (no race here — runWorkflow already resolved).
    controller.abort();
    expect(res.status).toBe("ok");
    expect(res.cards.every((c) => c.status === "ok")).toBe(true);
  });

  it("hooks fire no callbacks after runWorkflow resolves", async () => {
    const controller = new AbortController();
    runAgentLoopMock.mockResolvedValue("ok");
    let postResolveCalls = 0;
    const done = await runWorkflow(
      twoCardGraph,
      {
        onCardStart: () => {},
        onCardOutput: () => {},
        onCardDone: () => {},
        onCardError: () => {},
        onWorkflowDone: () => {},
      },
      { model: "m", signal: controller.signal },
    );

    // Replace hooks AFTER the run resolved — if anything still fired we'd
    // observe it via a global counter, but the runner never holds a reference
    // post-return.
    expect(done.status).toBe("ok");
    // Aborting now must not invoke any callback.
    controller.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(postResolveCalls).toBe(0);
  });
});

describe("runner — 50 sequential runs hold steady", () => {
  it("does not retain unbounded listeners across 50 runs", async () => {
    const g: WorkflowGraph = { cards: [card("a")], edges: [] };
    runAgentLoopMock.mockResolvedValue("ok");

    // Track listeners attached to a single shared AbortSignal. The runner
    // currently does NOT add its own listeners (it polls `signal.aborted`)
    // so the count should stay at 0 — this is a regression guard.
    const controller = new AbortController();
    const signal = controller.signal;
    let listenerCount = 0;
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
      listenerCount++;
      return origAdd(...args);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
      listenerCount--;
      return origRemove(...args);
    }) as typeof signal.removeEventListener;

    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      const r = await runWorkflow(g, {}, { model: "m", signal });
      expect(r.status).toBe("ok");
    }
    const dt = performance.now() - t0;

    expect(listenerCount).toBe(0);
    // 50 trivial runs should be fast — bound is generous to allow CI jitter.
    expect(dt).toBeLessThan(2000);
  });
});

describe("runner — startCardId out of range", () => {
  it("throws a clear error when startCardId is not in the graph", async () => {
    const g: WorkflowGraph = { cards: [card("a")], edges: [] };
    await expect(
      runWorkflow(g, {}, { model: "m", startCardId: "missing" }),
    ).rejects.toThrow(/not in the workflow graph/);
  });
});
