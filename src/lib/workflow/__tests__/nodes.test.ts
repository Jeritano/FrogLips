import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "../../agent-loop/types";
import type { WorkflowCard } from "../../../types";

/**
 * Orchestration node handlers. `runAgentLoop` is mocked so each test drives
 * the control flow deterministically: the responder returns a string based on
 * the sub-run's model + last user message, letting us assert fan-out counts,
 * critic looping, cascade escalation, and route selection without a real LLM.
 */

const calls: AgentRunOptions[] = [];
let responder: (o: AgentRunOptions) => string = () => "ok";

vi.mock("../../agent-loop", () => ({
  runAgentLoop: vi.fn(async (o: AgentRunOptions) => {
    calls.push(o);
    return responder(o);
  }),
}));

let snap: { workflowId: number; entries: Record<string, unknown> } | null =
  null;
const clearAllMock = vi.fn(() => {
  snap = { workflowId: 1, entries: {} };
  return true;
});
vi.mock("../scratchpad", () => ({
  snapshot: () => snap,
  clearAll: () => clearAllMock(),
}));

/** Shell mock for the critic's verifyCmd path. Same responder pattern as the
 *  agent-loop mock above: tests set `shellResponder` to drive exit codes. */
interface ShellReply {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
}
const shellCalls: Array<{
  command: string;
  opts?: { cwd?: string; timeout_secs?: number };
}> = [];
let shellResponder: (cmd: string) => ShellReply = () => ({
  stdout: "",
  stderr: "",
  exit_code: 0,
  duration_ms: 1,
  timed_out: false,
});
vi.mock("../../tauri-api", () => ({
  api: {
    agentRunShell: vi.fn(
      async (
        command: string,
        opts?: { cwd?: string; timeout_secs?: number },
      ) => {
        shellCalls.push({ command, opts });
        return shellResponder(command);
      },
    ),
  },
}));

import {
  isOrchestratorNode,
  runWorkflowNode,
  type NodeRunContext,
} from "../nodes";

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
  snap = null;
  clearAllMock.mockClear();
  shellCalls.length = 0;
  shellResponder = () => ({
    stdout: "",
    stderr: "",
    exit_code: 0,
    duration_ms: 1,
    timed_out: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isOrchestratorNode", () => {
  it("is false for agent / absent, true otherwise", () => {
    expect(isOrchestratorNode({ nodeType: "agent" } as WorkflowCard)).toBe(
      false,
    );
    expect(isOrchestratorNode({} as WorkflowCard)).toBe(false);
    expect(isOrchestratorNode({ nodeType: "moa" } as WorkflowCard)).toBe(true);
  });
});

describe("MoA node", () => {
  it("runs N proposers in parallel then one synthesis pass", async () => {
    responder = (o) =>
      lastUser(o).includes("## Proposals") ? "SYNTH" : "prop";
    const out = await runWorkflowNode(
      ctx({ nodeType: "moa", nodeConfig: { members: 3 } }),
    );
    expect(out).toBe("SYNTH");
    expect(calls).toHaveLength(4); // 3 proposers + 1 synth
  });
});

describe("Self-consistency node", () => {
  it("synth mode samples N times then aggregates", async () => {
    responder = (o) => (lastUser(o).includes("## Samples") ? "MERGED" : "s");
    const out = await runWorkflowNode(
      ctx({
        nodeType: "consistency",
        nodeConfig: { members: 4, voteMode: "synth" },
      }),
    );
    expect(out).toBe("MERGED");
    expect(calls).toHaveLength(5); // 4 samples + 1 aggregate
  });

  it("vote mode returns the modal answer without an aggregator call when samples agree", async () => {
    responder = (o) =>
      lastUser(o).includes("## Samples") ? "AGG" : "same answer";
    const out = await runWorkflowNode(
      ctx({
        nodeType: "consistency",
        nodeConfig: { members: 4, voteMode: "vote" },
      }),
    );
    expect(out).toBe("same answer"); // 4/4 agree → modal, returned verbatim
    expect(calls).toHaveLength(4); // 4 samples, NO aggregate
  });

  it("vote mode falls back to synthesis when there is no majority", async () => {
    let i = 0;
    responder = (o) => {
      if (lastUser(o).includes("## Samples")) return "SYNTH";
      i += 1;
      return `distinct-${i}`; // all different → no majority
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "consistency",
        nodeConfig: { members: 3, voteMode: "vote" },
      }),
    );
    expect(out).toBe("SYNTH");
    expect(calls).toHaveLength(4); // 3 samples + 1 synth
  });

  it("varies the sampling temperature across the N samples so they're independent", async () => {
    responder = (o) => (lastUser(o).includes("## Samples") ? "MERGED" : "s");
    await runWorkflowNode(
      ctx({
        nodeType: "consistency",
        nodeConfig: { members: 4, voteMode: "synth" },
      }),
    );
    // The synth pass is the last call; the first N are the samples.
    const sampleTemps = calls.slice(0, 4).map((c) => c.params?.temperature);
    // All defined, spread across a sensible 0.5..0.9 range, and strictly
    // increasing per member index (deterministic, not random).
    for (const t of sampleTemps) {
      expect(typeof t).toBe("number");
      expect(t!).toBeGreaterThanOrEqual(0.5);
      expect(t!).toBeLessThanOrEqual(0.9);
    }
    expect(new Set(sampleTemps).size).toBe(4); // genuinely distinct draws
    expect(sampleTemps[0]).toBe(0.5); // first member → range floor
    expect(sampleTemps[3]).toBe(0.9); // last member → range ceiling
    for (let i = 1; i < sampleTemps.length; i++)
      expect(sampleTemps[i]!).toBeGreaterThan(sampleTemps[i - 1]!);
  });

  it("derives the sample temperatures deterministically (same across runs)", async () => {
    responder = (o) => (lastUser(o).includes("## Samples") ? "M" : "s");
    const run = async () => {
      calls.length = 0;
      await runWorkflowNode(
        ctx({
          nodeType: "consistency",
          nodeConfig: { members: 5, voteMode: "synth" },
        }),
      );
      return calls.slice(0, 5).map((c) => c.params?.temperature);
    };
    expect(await run()).toEqual(await run());
  });

  it("vote mode finds a majority on a shared structured verdict line despite differing prose", async () => {
    // Samples agree on the FAULT: verdict but wrap it in different reasoning —
    // exact-string equality would miss the majority; the structured-key compare
    // catches it and returns the modal answer WITHOUT an aggregator call.
    const samples = [
      "Looking at the trace, the lock is dropped early.\nFAULT: race condition",
      "After review I believe two threads collide here.\nFAULT: Race Condition.",
      "It's clearly a memory leak in the allocator.\nFAULT: memory leak",
    ];
    let i = 0;
    responder = (o) => {
      if (lastUser(o).includes("## Samples")) return "SYNTH";
      return samples[i++];
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "consistency",
        nodeConfig: { members: 3, voteMode: "vote" },
      }),
    );
    expect(out).toBe(samples[0].trim()); // 2/3 share FAULT: race condition
    expect(calls).toHaveLength(3); // 3 samples, NO aggregator
  });

  it("vote mode falls through to synth when structured verdicts all differ", async () => {
    const samples = [
      "reasoning a\nVERDICT: APPROVE",
      "reasoning b\nVERDICT: REJECT",
      "reasoning c\nVERDICT: ESCALATE",
    ];
    let i = 0;
    responder = (o) => {
      if (lastUser(o).includes("## Samples")) return "SYNTH";
      return samples[i++];
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "consistency",
        nodeConfig: { members: 3, voteMode: "vote" },
      }),
    );
    expect(out).toBe("SYNTH");
    expect(calls).toHaveLength(4); // 3 samples + 1 synth
  });
});

describe("Critic node", () => {
  it("stops as soon as the score passes the threshold", async () => {
    responder = (o) => {
      const u = lastUser(o);
      if (u.includes("Candidate answer")) return "SCORE: 95 looks good";
      return "draft1";
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "critic",
        nodeConfig: { passThreshold: 80, maxIters: 3 },
      }),
    );
    expect(out).toBe("draft1");
    expect(calls).toHaveLength(2); // draft + one critique (passed)
  });

  it("revises when the score is below threshold", async () => {
    let critiques = 0;
    responder = (o) => {
      const u = lastUser(o);
      if (u.includes("Candidate answer")) {
        critiques += 1;
        return critiques === 1 ? "SCORE: 10 weak" : "SCORE: 90 fixed";
      }
      if (u.includes("Revise your answer")) return "draft2";
      return "draft1";
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "critic",
        nodeConfig: { passThreshold: 80, maxIters: 3 },
      }),
    );
    expect(out).toBe("draft2");
    expect(calls).toHaveLength(4); // draft, critique(10), revise, critique(90)
  });
});

describe("Critic node — execution-grounded verification (verifyCmd)", () => {
  it("runs verifyCmd and injects exit code + output into the critique prompt", async () => {
    shellResponder = () => ({
      stdout: "all 42 tests passed",
      stderr: "",
      exit_code: 0,
      duration_ms: 5,
      timed_out: false,
    });
    responder = (o) =>
      lastUser(o).includes("Candidate answer") ? "SCORE: 95 fine" : "draft1";
    const out = await runWorkflowNode(
      ctx({
        nodeType: "critic",
        nodeConfig: { verifyCmd: "npm test", maxIters: 3 },
      }),
    );
    expect(out).toBe("draft1");
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0].command).toBe("npm test");
    const critique = calls.find((c) =>
      lastUser(c).includes("Candidate answer"),
    )!;
    const u = lastUser(critique);
    expect(u).toContain("VERIFICATION RESULT");
    expect(u).toContain("exit code: 0");
    expect(u).toContain("all 42 tests passed");
    // Exit-0 rule encoded into the critic instruction.
    expect(u).toContain("score at least 80");
  });

  it("encodes the nonzero-exit rule and truncates to the ~2000-char output tail", async () => {
    const noise = "x".repeat(5000) + "FINAL ERROR LINE";
    shellResponder = () => ({
      stdout: noise,
      stderr: "boom",
      exit_code: 2,
      duration_ms: 5,
      timed_out: false,
    });
    responder = (o) =>
      lastUser(o).includes("Candidate answer") ? "SCORE: 95" : "draft1";
    await runWorkflowNode(
      ctx({ nodeType: "critic", nodeConfig: { verifyCmd: "make check" } }),
    );
    const u = lastUser(
      calls.find((c) => lastUser(c).includes("Candidate answer"))!,
    );
    expect(u).toContain("exit code: 2");
    expect(u).toContain("FINAL ERROR LINE");
    expect(u).toContain("boom");
    expect(u).not.toContain("x".repeat(3001)); // only the ~2000-char tail survives
    expect(u).toContain("score at most 40");
  });

  it("re-runs verifyCmd before EVERY critique iteration", async () => {
    let critiques = 0;
    responder = (o) => {
      const u = lastUser(o);
      if (u.includes("Candidate answer")) {
        critiques += 1;
        return critiques === 1 ? "SCORE: 10 weak" : "SCORE: 90 fixed";
      }
      if (u.includes("Revise your answer")) return "draft2";
      return "draft1";
    };
    await runWorkflowNode(
      ctx({
        nodeType: "critic",
        nodeConfig: { verifyCmd: "npm test", maxIters: 3 },
      }),
    );
    expect(shellCalls).toHaveLength(2); // one verification per critique pass
  });

  it("does not touch the shell when verifyCmd is unset", async () => {
    responder = (o) =>
      lastUser(o).includes("Candidate answer") ? "SCORE: 95" : "draft1";
    await runWorkflowNode(ctx({ nodeType: "critic", nodeConfig: {} }));
    expect(shellCalls).toHaveLength(0);
  });

  it("skips the verify run on the terminal iteration (its score is discarded)", async () => {
    // maxIters:1 → the sole iteration IS the terminal one; the loop exits right
    // after scoring it, so paying for a build/test run there is pure waste.
    responder = (o) =>
      lastUser(o).includes("Candidate answer") ? "SCORE: 10 weak" : "draft1";
    await runWorkflowNode(
      ctx({
        nodeType: "critic",
        nodeConfig: { verifyCmd: "npm test", maxIters: 1 },
      }),
    );
    expect(shellCalls).toHaveLength(0); // terminal iteration → no verify
  });

  it("runs verify on non-terminal iterations but not the final one", async () => {
    // maxIters:2, both critiques score low → the loop reaches its terminal
    // iteration. Verify should fire on iteration 0 only, not the discarded last.
    let critiques = 0;
    responder = (o) => {
      const u = lastUser(o);
      if (u.includes("Candidate answer")) {
        critiques += 1;
        return "SCORE: 10 still weak"; // never passes → exhausts iterations
      }
      if (u.includes("Revise your answer")) return "draft2";
      return "draft1";
    };
    await runWorkflowNode(
      ctx({
        nodeType: "critic",
        nodeConfig: { verifyCmd: "npm test", maxIters: 2 },
      }),
    );
    expect(critiques).toBe(2); // both iterations critiqued
    expect(shellCalls).toHaveLength(1); // verify only on the non-terminal pass
  });
});

describe("Critic node — criticSystemPrompt", () => {
  it("uses criticSystemPrompt for the critique pass only", async () => {
    responder = (o) =>
      lastUser(o).includes("Candidate answer") ? "SCORE: 95" : "draft1";
    await runWorkflowNode(
      ctx({
        nodeType: "critic",
        nodeConfig: { criticSystemPrompt: "You are a hostile reviewer." },
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].systemPromptOverride).toBeUndefined(); // generator: card default
    expect(calls[1].systemPromptOverride).toBe("You are a hostile reviewer.");
  });

  it("inherits the card persona for the critique when unset (default unchanged)", async () => {
    const base = baseOpts();
    base.systemPromptOverride = "CARD PERSONA";
    responder = (o) =>
      lastUser(o).includes("Candidate answer") ? "SCORE: 95" : "draft1";
    await runWorkflowNode(ctx({ nodeType: "critic", nodeConfig: {} }, base));
    expect(calls[1].systemPromptOverride).toBe("CARD PERSONA");
  });
});

describe("Universal budget (non-budget node types)", () => {
  it("applies the token ceiling to every sub-run of a consistency node", async () => {
    responder = (o) => (lastUser(o).includes("## Samples") ? "MERGED" : "s");
    await runWorkflowNode(
      ctx({
        nodeType: "consistency",
        nodeConfig: { members: 3, voteMode: "synth", maxTokens: 80 },
      }),
    );
    expect(calls).toHaveLength(4); // 3 samples + 1 synth — all capped
    for (const c of calls) expect(c.params?.max_tokens).toBe(80);
  });

  it("aborts a critic node at the time ceiling and returns best effort", async () => {
    // Sub-run hangs until the budget wrapper's child signal aborts it.
    responder = ((o: AgentRunOptions) =>
      new Promise<string>((resolve) => {
        if (o.signal?.aborted) {
          resolve("late");
          return;
        }
        o.signal?.addEventListener("abort", () => resolve("slow-draft"), {
          once: true,
        });
      })) as unknown as typeof responder;
    const out = await runWorkflowNode(
      ctx({ nodeType: "critic", nodeConfig: { maxMs: 40, onExceed: "best" } }),
    );
    expect(out).toBe("slow-draft"); // the draft that survived the abort
  });

  it("fails the card at the time ceiling when onExceed is 'stop'", async () => {
    responder = ((o: AgentRunOptions) =>
      new Promise<string>((resolve) => {
        if (o.signal?.aborted) {
          resolve("late");
          return;
        }
        o.signal?.addEventListener("abort", () => resolve("partial"), {
          once: true,
        });
      })) as unknown as typeof responder;
    await expect(
      runWorkflowNode(
        ctx({
          nodeType: "critic",
          nodeConfig: { maxMs: 30, onExceed: "stop" },
        }),
      ),
    ).rejects.toThrow(/time ceiling/i);
  });
});

describe("Cascade node", () => {
  it("escalates to the stronger model when the base scores low", async () => {
    responder = (o) => {
      if (o.model === "big") return "BIG";
      if (lastUser(o).includes("## Answer")) return "SCORE: 20 weak";
      return "baseans";
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "cascade",
        nodeConfig: { passThreshold: 70, escalateModel: "big" },
      }),
    );
    expect(out).toBe("BIG");
  });

  it("keeps the base answer when it scores high enough", async () => {
    responder = (o) => {
      if (o.model === "big") return "BIG";
      if (lastUser(o).includes("## Answer")) return "SCORE: 95 great";
      return "baseans";
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "cascade",
        nodeConfig: { passThreshold: 70, escalateModel: "big" },
      }),
    );
    expect(out).toBe("baseans");
    expect(calls.some((c) => c.model === "big")).toBe(false);
  });

  it("refines on escalation — hands the strong model the base draft + critique, not a fresh restart", async () => {
    responder = (o) => {
      if (o.model === "big") return "BIG";
      if (lastUser(o).includes("## Answer")) return "SCORE: 20 missing X";
      return "baseans";
    };
    await runWorkflowNode(
      ctx({
        nodeType: "cascade",
        nodeConfig: { passThreshold: 70, escalateModel: "big" },
      }),
    );
    const esc = calls.find((c) => c.model === "big")!;
    const u = lastUser(esc);
    // The escalation prompt carries the prior draft + the critique reason so the
    // strong model refines rather than re-solving from scratch.
    expect(u).toContain("## Previous draft");
    expect(u).toContain("baseans");
    expect(u).toContain("## Critique");
    expect(u).toContain("SCORE: 20 missing X");
    expect(u).toContain("## Task");
    expect(u).toContain("TASK");
  });
});

describe("Router node", () => {
  it("runs the route the classifier selects", async () => {
    responder = (o) => {
      if (lastUser(o).includes("## Routes")) return "2";
      if (o.model === "mb") return "ROUTED-B";
      return "?";
    };
    const out = await runWorkflowNode(
      ctx({
        nodeType: "router",
        nodeConfig: {
          routes: [
            { label: "a", when: "x", model: "ma" },
            { label: "b", when: "y", model: "mb" },
          ],
        },
      }),
    );
    expect(out).toBe("ROUTED-B");
  });
});

describe("Budget node", () => {
  it("applies the token cap to the sub-run", async () => {
    responder = () => "capped";
    const out = await runWorkflowNode(
      ctx({ nodeType: "budget", nodeConfig: { maxTokens: 100 } }),
    );
    expect(out).toBe("capped");
    expect(calls[0].params?.max_tokens).toBe(100);
  });

  it("never lets a sub-run cap exceed a tighter inherited ceiling", async () => {
    // Base params already cap at 50; the node asks for 100 — the smaller wins so
    // the budget ceiling reaches even a sub-run that overrides max_tokens.
    const base = baseOpts();
    base.params = { temperature: null, top_p: null, max_tokens: 50 };
    responder = () => "capped";
    await runWorkflowNode(
      ctx({ nodeType: "budget", nodeConfig: { maxTokens: 100 } }, base),
    );
    expect(calls[0].params?.max_tokens).toBe(50);
  });
});

describe("Blackboard node", () => {
  it("snapshots the shared scratchpad as JSON", async () => {
    snap = { workflowId: 1, entries: { k: "v" } };
    const out = await runWorkflowNode(
      ctx({ nodeType: "blackboard", nodeConfig: { blackboardOp: "snapshot" } }),
    );
    expect(out).toContain("```json");
    expect(out).toContain('"k": "v"');
    expect(calls).toHaveLength(0); // no LLM call for a snapshot
  });

  it("clears the scratchpad", async () => {
    snap = { workflowId: 1, entries: { k: "v" } };
    const out = await runWorkflowNode(
      ctx({ nodeType: "blackboard", nodeConfig: { blackboardOp: "clear" } }),
    );
    expect(out).toBe("Blackboard cleared.");
    expect(clearAllMock).toHaveBeenCalledOnce();
  });
});
