import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowCard, WorkflowGraph } from "../../../types";
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

import { runWorkflow } from "../runner";

function card(id: string): WorkflowCard {
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
  };
}

const twoCardGraph: WorkflowGraph = {
  cards: [card("a"), card("b")],
  edges: [{ from: "a", to: "b" }],
};

beforeEach(() => {
  runAgentLoopMock.mockReset();
  workflowRunRecordMock.mockClear();
  workflowRunRecordMock.mockResolvedValue(1);
});

describe("runWorkflow — handoff", () => {
  it("passes card 1's output as context into card 2", async () => {
    const seenMessages: AgentRunOptions["messages"][] = [];
    runAgentLoopMock.mockImplementation(async (opts) => {
      seenMessages.push(opts.messages);
      return opts.messages.some((m) => m.content.includes("prompt b"))
        ? "card-b-final"
        : "card-a-final";
    });

    const result = await runWorkflow(twoCardGraph, {}, {
      model: "m",
      workflowId: 7,
    });

    expect(result.status).toBe("ok");
    expect(result.cards.map((c) => c.status)).toEqual(["ok", "ok"]);

    // Card 1 ran with only its own prompt.
    expect(seenMessages[0]).toHaveLength(1);
    expect(seenMessages[0][0].content).toBe("prompt a");

    // Card 2 received card 1's output injected ahead of its own prompt.
    expect(seenMessages[1]).toHaveLength(2);
    expect(seenMessages[1][0].content).toContain("Output from previous step:");
    expect(seenMessages[1][0].content).toContain("card-a-final");
    expect(seenMessages[1][1].content).toBe("prompt b");

    // The run was recorded as ok.
    expect(workflowRunRecordMock).toHaveBeenCalledWith(7, "ok", expect.any(String));
  });

  it("emits per-card lifecycle hooks", async () => {
    runAgentLoopMock.mockResolvedValue("out");
    const events: string[] = [];
    await runWorkflow(twoCardGraph, {
      onCardStart: (id) => events.push(`start:${id}`),
      onCardDone: (id) => events.push(`done:${id}`),
      onWorkflowDone: () => events.push("workflow-done"),
    }, { model: "m" });

    expect(events).toEqual([
      "start:a", "done:a", "start:b", "done:b", "workflow-done",
    ]);
  });
});

describe("runWorkflow — failure", () => {
  it("stops the chain, skips remaining cards, records failed", async () => {
    runAgentLoopMock.mockImplementation(async (opts) => {
      if (opts.messages.some((m) => m.content.includes("prompt a"))) {
        throw new Error("card a blew up");
      }
      return "unreachable";
    });

    const result = await runWorkflow(twoCardGraph, {}, {
      model: "m",
      workflowId: 9,
    });

    expect(result.status).toBe("failed");
    expect(result.cards[0].status).toBe("error");
    expect(result.cards[0].error).toMatch(/blew up/);
    expect(result.cards[1].status).toBe("skipped");
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(workflowRunRecordMock).toHaveBeenCalledWith(9, "failed", expect.any(String));
  });
});

describe("runWorkflow — abort", () => {
  it("stops mid-run when the signal aborts, marking the rest skipped", async () => {
    const controller = new AbortController();
    runAgentLoopMock.mockImplementation(async (opts) => {
      if (opts.messages.some((m) => m.content.includes("prompt a"))) {
        controller.abort();
        return "card-a-final";
      }
      return "card-b-final";
    });

    const result = await runWorkflow(twoCardGraph, {}, {
      model: "m",
      signal: controller.signal,
    });

    expect(result.status).toBe("failed");
    // Card a's run was aborted right after returning → marked error.
    expect(result.cards[0].status).toBe("error");
    expect(result.cards[1].status).toBe("skipped");
    // Card b's agent loop never ran.
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

  it("skips every card when aborted before the run starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkflow(twoCardGraph, {}, {
      model: "m",
      signal: controller.signal,
    });
    expect(result.status).toBe("failed");
    expect(result.cards.every((c) => c.status === "skipped")).toBe(true);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });
});

describe("runWorkflow — unattended opt-in", () => {
  function unattendedCard(): WorkflowCard {
    return { ...card("u"), tools: ["read_file"], unattended: true };
  }
  const single = (c: WorkflowCard): WorkflowGraph => ({ cards: [c], edges: [] });

  it("auto-approves only listed tools for an unattended card on a scheduled run", async () => {
    let gate: AgentRunOptions["requestConfirmation"] | undefined;
    runAgentLoopMock.mockImplementation(async (opts) => {
      gate = opts.requestConfirmation;
      return "ok";
    });

    await runWorkflow(single(unattendedCard()), {}, { model: "m", scheduled: true });

    expect(gate).toBeDefined();
    // A tool in the card's allowlist is auto-approved.
    expect(await gate!("read_file", {}, "normal")).toEqual({ approve: true });
    // A tool NOT in the allowlist falls through to the deny-all default gate.
    expect(await gate!("run_shell", {}, "destructive")).toEqual({ approve: false });
  });

  it("uses the normal gate for an unattended card on a MANUAL run", async () => {
    let gate: AgentRunOptions["requestConfirmation"] | undefined;
    runAgentLoopMock.mockImplementation(async (opts) => {
      gate = opts.requestConfirmation;
      return "ok";
    });

    // scheduled omitted → manual run; unattended must NOT auto-approve.
    await runWorkflow(single(unattendedCard()), {}, { model: "m" });

    expect(await gate!("read_file", {}, "normal")).toEqual({ approve: false });
  });

  it("still denies for a non-unattended card on a scheduled run", async () => {
    let gate: AgentRunOptions["requestConfirmation"] | undefined;
    runAgentLoopMock.mockImplementation(async (opts) => {
      gate = opts.requestConfirmation;
      return "ok";
    });

    const plain = { ...card("p"), tools: ["read_file"], unattended: false };
    await runWorkflow(single(plain), {}, { model: "m", scheduled: true });

    expect(await gate!("read_file", {}, "normal")).toEqual({ approve: false });
  });
});

describe("runWorkflow — per-card model pin", () => {
  const single = (c: WorkflowCard): WorkflowGraph => ({ cards: [c], edges: [] });

  it("uses the run default model when the card pins none", async () => {
    let seen: string | undefined;
    runAgentLoopMock.mockImplementation(async (opts) => {
      seen = opts.model;
      return "ok";
    });

    await runWorkflow(single(card("a")), {}, { model: "default-m" });
    expect(seen).toBe("default-m");
  });

  it("overrides with the card's pinned model when set", async () => {
    let seen: string | undefined;
    runAgentLoopMock.mockImplementation(async (opts) => {
      seen = opts.model;
      return "ok";
    });

    const pinned = { ...card("a"), model: "pinned-m" };
    await runWorkflow(single(pinned), {}, { model: "default-m" });
    expect(seen).toBe("pinned-m");
  });
});
