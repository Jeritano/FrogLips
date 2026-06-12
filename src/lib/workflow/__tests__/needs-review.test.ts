import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawWorkflow, WorkflowCard, WorkflowGraph } from "../../../types";
import type { AgentRunOptions } from "../../agent-loop";

// Mocks mirror runner.test.ts so the runner drives its real code path with a
// stubbed agent loop. `workflowGet` is added because the scheduler glue
// (handleWorkflowTrigger) loads the workflow row through it.
const {
  runAgentLoopMock,
  workflowRunRecordMock,
  workflowGetMock,
  logDiagMock,
} = vi.hoisted(() => ({
  runAgentLoopMock: vi.fn<(opts: AgentRunOptions) => Promise<string | null>>(),
  workflowRunRecordMock: vi.fn<
    (id: number, status: string, json: string) => Promise<number>
  >(async () => 1),
  workflowGetMock: vi.fn<(id: number) => Promise<RawWorkflow | null>>(),
  logDiagMock: vi.fn(),
}));

vi.mock("../../agent-loop", () => ({
  runAgentLoop: runAgentLoopMock,
}));

vi.mock("../../tauri-api", () => ({
  api: {
    workflowRunRecord: workflowRunRecordMock,
    workflowGet: workflowGetMock,
  },
}));

vi.mock("../../agent-presets", () => ({
  loadAllPresets: () => [
    { id: "general", name: "General", description: "", allowedTools: [] },
  ],
}));

// Spy on the diagnostics ring buffer so the scheduled-refusal path can be
// asserted without depending on localStorage. The runner imports `logDiag`
// from the same module.
vi.mock("../../diagnostics", () => ({
  logDiag: logDiagMock,
}));

import { runWorkflow } from "../runner";
import { handleWorkflowTrigger } from "../schedule";

function card(id: string, needsReview = false): WorkflowCard {
  return {
    id,
    name: `Card ${id}`,
    preset: "general",
    prompt: `prompt ${id}`,
    tools: [],
    schedule: null,
    backend: null,
    x: 0,
    y: 0,
    needsReview,
  };
}

/** Wrap a graph in the persisted-row shape `parseWorkflow` consumes. */
function row(id: number, graph: WorkflowGraph): RawWorkflow {
  return {
    id,
    name: `wf-${id}`,
    graph_json: JSON.stringify(graph),
    created_at: 0,
    updated_at: 0,
  };
}

beforeEach(() => {
  runAgentLoopMock.mockReset();
  workflowRunRecordMock.mockClear();
  workflowRunRecordMock.mockResolvedValue(1);
  workflowGetMock.mockReset();
  logDiagMock.mockClear();
});

describe("needsReview gate — manual run", () => {
  it("refuses to run when a reachable card is unreviewed, naming it", async () => {
    runAgentLoopMock.mockResolvedValue("out");
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b", true)],
      edges: [{ from: "a", to: "b" }],
    };

    await expect(runWorkflow(graph, {}, { model: "m" })).rejects.toThrow(
      /Card "Card b" needs review/,
    );

    // Fail-fast: NO card executed — not even the reviewed first card.
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("names every unreviewed card when more than one is unarmed", async () => {
    runAgentLoopMock.mockResolvedValue("out");
    const graph: WorkflowGraph = {
      cards: [card("a", true), card("b", true)],
      edges: [{ from: "a", to: "b" }],
    };

    await expect(runWorkflow(graph, {}, { model: "m" })).rejects.toThrow(
      /"Card a", "Card b"/,
    );
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("runs normally when every card is armed (needsReview all false)", async () => {
    runAgentLoopMock.mockResolvedValue("out");
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b")],
      edges: [{ from: "a", to: "b" }],
    };

    const result = await runWorkflow(graph, {}, { model: "m" });

    expect(result.status).toBe("ok");
    expect(result.cards.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
  });
});

describe("needsReview gate — scheduled trigger", () => {
  const payload = (workflowId: number, cardId: string) => ({
    workflow_id: workflowId,
    card_id: cardId,
  });

  it("does not execute an unreviewed flow — silent no-op with a diagnostic", async () => {
    const graph: WorkflowGraph = {
      cards: [card("a", true), card("b")],
      edges: [{ from: "a", to: "b" }],
    };
    workflowGetMock.mockResolvedValue(row(5, graph));
    runAgentLoopMock.mockResolvedValue("out");

    const result = await handleWorkflowTrigger(
      payload(5, "a"),
      {},
      {
        model: "m",
      },
    );

    // Clean no-op result: nothing ran, nothing failed.
    expect(result.status).toBe("ok");
    expect(result.cards).toEqual([]);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    // The refusal surfaces only through the diagnostic ring buffer.
    expect(logDiagMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "workflow-schedule",
        message: expect.stringContaining("needs review"),
      }),
    );
  });

  it("ignores an unreviewed card UPSTREAM of the triggered start card", async () => {
    // Card a is unreviewed but the trigger starts at b — only cards the run
    // would execute (b onward) gate the trigger, so this one proceeds.
    const graph: WorkflowGraph = {
      cards: [card("a", true), card("b")],
      edges: [{ from: "a", to: "b" }],
    };
    workflowGetMock.mockResolvedValue(row(6, graph));
    runAgentLoopMock.mockResolvedValue("out");

    const result = await handleWorkflowTrigger(
      payload(6, "b"),
      {},
      {
        model: "m",
      },
    );

    expect(result.status).toBe("ok");
    expect(result.cards.map((c) => c.status)).toEqual(["ok"]);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(logDiagMock).not.toHaveBeenCalled();
  });

  it("runs a fully-armed scheduled flow normally", async () => {
    const graph: WorkflowGraph = {
      cards: [card("a"), card("b")],
      edges: [{ from: "a", to: "b" }],
    };
    workflowGetMock.mockResolvedValue(row(7, graph));
    runAgentLoopMock.mockResolvedValue("out");

    const result = await handleWorkflowTrigger(
      payload(7, "a"),
      {},
      {
        model: "m",
      },
    );

    expect(result.status).toBe("ok");
    expect(result.cards.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
  });
});
