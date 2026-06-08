import { describe, expect, it } from "vitest";
import {
  ALLOWED_FLOW_ROLES,
  CURATED_TOOLS_FOR_ROLE,
  MAX_FLOW_STEPS,
  assertFlowSafe,
  buildLinearFlow,
} from "../create-flow";
import { validateGraph } from "../graph";

const step = (role: string, n = 1) => ({
  title: `Step ${n}`,
  role,
  instructions: `Do work ${n}`,
});

describe("buildLinearFlow — happy path", () => {
  it("builds a valid linear graph with chained edges", () => {
    const r = buildLinearFlow("My Flow", [step("coder", 1), step("critic", 2), step("summarizer", 3)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("My Flow");
    expect(r.graph.cards).toHaveLength(3);
    expect(r.graph.edges).toEqual([
      { from: r.graph.cards[0].id, to: r.graph.cards[1].id },
      { from: r.graph.cards[1].id, to: r.graph.cards[2].id },
    ]);
    expect(validateGraph(r.graph).ok).toBe(true);
  });

  it("forces every security invariant on every card", () => {
    const r = buildLinearFlow("F", [step("coder"), step("editor", 2)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const c of r.graph.cards) {
      expect(c.unattended).toBe(false);
      expect(c.schedule).toBeNull();
      expect(c.nodeType).toBe("agent");
      expect(c.nodeConfig).toBeNull();
      expect(c.model).toBeNull();
      expect(c.backend).toBeNull();
      expect(c.placed).toBe(true);
      expect(c.tools.length).toBeGreaterThan(0);
      expect(c.id.startsWith("card-")).toBe(true);
      // no egress / mutation tool in any card
      for (const banned of ["web_fetch", "web_search", "http_request", "run_shell", "run_code", "write_file", "edit_file", "delete_path"]) {
        expect(c.tools).not.toContain(banned);
      }
    }
  });

  it("clamps oversized name / title / instructions", () => {
    const r = buildLinearFlow("N".repeat(200), [
      { title: "T".repeat(200), role: "coder", instructions: "I".repeat(9000) },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name.length).toBe(80);
    expect(r.graph.cards[0].name.length).toBe(60);
    expect(r.graph.cards[0].prompt.length).toBe(4000);
  });
});

describe("buildLinearFlow — rejects", () => {
  it("empty name / steps", () => {
    expect(buildLinearFlow("", [step("coder")]).ok).toBe(false);
    expect(buildLinearFlow("F", []).ok).toBe(false);
    expect(buildLinearFlow("F", "nope" as unknown).ok).toBe(false);
  });

  it("too many steps", () => {
    const many = Array.from({ length: MAX_FLOW_STEPS + 1 }, (_, i) => step("coder", i));
    const r = buildLinearFlow("F", many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("too_many_steps");
  });

  it("excluded / unknown roles (researcher, skeptic, general, bogus)", () => {
    for (const role of ["researcher", "skeptic", "general", "bogus"]) {
      const r = buildLinearFlow("F", [step(role)]);
      expect(r.ok, role).toBe(false);
      if (!r.ok) expect(r.kind).toBe("unknown_role");
    }
    expect(ALLOWED_FLOW_ROLES.has("researcher")).toBe(false);
    expect(ALLOWED_FLOW_ROLES.has("general")).toBe(false);
  });

  it("empty instructions", () => {
    const r = buildLinearFlow("F", [{ title: "T", role: "coder", instructions: "   " }]);
    expect(r.ok).toBe(false);
  });

  it("does not spread the model's step object (no field injection)", () => {
    const r = buildLinearFlow("F", [
      { title: "T", role: "coder", instructions: "x", unattended: true, schedule: "every 1m", nodeType: "moa" } as unknown,
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.cards[0].unattended).toBe(false);
    expect(r.graph.cards[0].schedule).toBeNull();
    expect(r.graph.cards[0].nodeType).toBe("agent");
  });
});

describe("assertFlowSafe", () => {
  it("passes a freshly-built flow", () => {
    const r = buildLinearFlow("F", [step("coder"), step("critic", 2)]);
    if (!r.ok) throw new Error("build failed");
    expect(assertFlowSafe(r.graph)).toBeNull();
  });

  it("catches a tampered unattended card", () => {
    const r = buildLinearFlow("F", [step("coder")]);
    if (!r.ok) throw new Error("build failed");
    r.graph.cards[0].unattended = true;
    expect(assertFlowSafe(r.graph)).toMatch(/unattended/);
  });

  it("catches a non-curated (egress) tool", () => {
    const r = buildLinearFlow("F", [step("coder")]);
    if (!r.ok) throw new Error("build failed");
    r.graph.cards[0].tools = ["read_file", "run_shell"];
    expect(assertFlowSafe(r.graph)).toMatch(/non-curated/);
  });

  it("every curated role's tools are egress-free", () => {
    for (const tools of Object.values(CURATED_TOOLS_FOR_ROLE)) {
      for (const t of tools) {
        expect(["web_fetch", "web_search", "http_request", "run_shell", "run_code", "write_file", "edit_file", "delete_path"]).not.toContain(t);
      }
    }
  });
});
