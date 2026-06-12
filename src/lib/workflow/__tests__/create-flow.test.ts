import { describe, expect, it } from "vitest";
import {
  ADVANCED_FORBIDDEN_TOOLS,
  ALLOWED_FLOW_ROLES,
  CURATED_TOOLS_FOR_ROLE,
  MAX_FLOW_STEPS,
  assertFlowSafe,
  assertFlowSafeAdvanced,
  buildAdvancedFlow,
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
    const r = buildLinearFlow("My Flow", [
      step("coder", 1),
      step("critic", 2),
      step("summarizer", 3),
    ]);
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
      for (const banned of [
        "web_fetch",
        "web_search",
        "http_request",
        "run_shell",
        "run_code",
        "write_file",
        "edit_file",
        "delete_path",
      ]) {
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
    const many = Array.from({ length: MAX_FLOW_STEPS + 1 }, (_, i) =>
      step("coder", i),
    );
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
    const r = buildLinearFlow("F", [
      { title: "T", role: "coder", instructions: "   " },
    ]);
    expect(r.ok).toBe(false);
  });

  it("does not spread the model's step object (no field injection)", () => {
    const r = buildLinearFlow("F", [
      {
        title: "T",
        role: "coder",
        instructions: "x",
        unattended: true,
        schedule: "every 1m",
        nodeType: "moa",
      } as unknown,
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
        expect([
          "web_fetch",
          "web_search",
          "http_request",
          "run_shell",
          "run_code",
          "write_file",
          "edit_file",
          "delete_path",
        ]).not.toContain(t);
      }
    }
  });
});

describe("buildAdvancedFlow — elevated authoring", () => {
  it("produces needsReview cards with the requested nodeType + intersected tools", () => {
    const r = buildAdvancedFlow("Adv", [
      {
        title: "Build",
        role: "general",
        instructions: "edit + verify",
        nodeType: "critic",
        verifyCmd: "npm test",
        // includes one forbidden (delete_path) + one off-allowlist (read_pdf is
        // fine; bogus is not) + valid wider tools
        tools: ["edit_file", "run_shell", "web_fetch", "delete_path", "bogus"],
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.graph.cards[0];
    expect(c.needsReview).toBe(true);
    expect(c.unattended).toBe(false);
    expect(c.schedule).toBeNull();
    expect(c.nodeType).toBe("critic");
    // intersected — forbidden + off-allowlist stripped, valid kept
    expect(c.tools).toContain("edit_file");
    expect(c.tools).toContain("run_shell");
    expect(c.tools).toContain("web_fetch");
    expect(c.tools).not.toContain("delete_path");
    expect(c.tools).not.toContain("bogus");
    // critic config carries verifyCmd + loop fields
    expect(c.nodeConfig?.verifyCmd).toBe("npm test");
    expect(c.nodeConfig?.maxIters).toBeGreaterThan(0);
    expect(c.nodeConfig?.passThreshold).toBeGreaterThan(0);
    expect(assertFlowSafeAdvanced(r.graph)).toBeNull();
  });

  it("allows the expanded role set (researcher/general) in advanced mode only", () => {
    for (const role of ["researcher", "general"]) {
      const r = buildAdvancedFlow("F", [
        { title: "T", role, instructions: "x" },
      ]);
      expect(r.ok, role).toBe(true);
      // ...but those roles are still rejected by the safe builder
      expect(
        buildLinearFlow("F", [{ title: "T", role, instructions: "x" }]).ok,
      ).toBe(false);
    }
  });

  it("rejects a forbidden / non-advanced nodeType (router/blackboard/budget)", () => {
    for (const nodeType of ["router", "blackboard", "budget", "bogus"]) {
      const r = buildAdvancedFlow("F", [
        { title: "T", role: "coder", instructions: "x", nodeType } as unknown,
      ]);
      expect(r.ok, nodeType).toBe(false);
      if (!r.ok) expect(r.kind).toBe("bad_node_type");
    }
  });

  it("strips a forbidden tool (delete_path) from the intersection", () => {
    const r = buildAdvancedFlow("F", [
      {
        title: "T",
        role: "general",
        instructions: "x",
        tools: ["read_file", "delete_path", "kill_process", "applescript_run"],
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.graph.cards[0];
    expect(c.tools).toEqual(["read_file"]);
    for (const banned of ADVANCED_FORBIDDEN_TOOLS) {
      expect(c.tools).not.toContain(banned);
    }
  });

  it("falls back to a read-only floor when the intersection wipes every tool", () => {
    const r = buildAdvancedFlow("F", [
      {
        title: "T",
        role: "general",
        instructions: "x",
        tools: ["delete_path", "kill_process", "bogus"],
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.cards[0].tools.length).toBeGreaterThan(0);
    expect(r.graph.cards[0].tools).toContain("read_file");
  });

  it("does not let the model smuggle unattended/schedule/needsReview:false via step fields", () => {
    const r = buildAdvancedFlow("F", [
      {
        title: "T",
        role: "general",
        instructions: "x",
        nodeType: "cascade",
        unattended: true,
        schedule: "every 1m",
        needsReview: false,
      } as unknown,
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.graph.cards[0];
    expect(c.unattended).toBe(false);
    expect(c.schedule).toBeNull();
    expect(c.needsReview).toBe(true);
    expect(assertFlowSafeAdvanced(r.graph)).toBeNull();
  });

  it("validateGraph accepts the advanced graph + keeps a linear edge chain", () => {
    const r = buildAdvancedFlow("F", [
      { title: "A", role: "general", instructions: "x", nodeType: "moa" },
      { title: "B", role: "coder", instructions: "y", nodeType: "consistency" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.edges).toEqual([
      { from: r.graph.cards[0].id, to: r.graph.cards[1].id },
    ]);
    expect(validateGraph(r.graph).ok).toBe(true);
  });

  it("a plain advanced agent on curated tools needs no review (not elevated)", () => {
    const r = buildAdvancedFlow("F", [
      { title: "T", role: "coder", instructions: "x" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // It's still flagged true by the builder (advanced cards are conservative),
    // but assertFlowSafeAdvanced must not reject it.
    expect(assertFlowSafeAdvanced(r.graph)).toBeNull();
  });
});

describe("assertFlowSafeAdvanced", () => {
  it("passes a freshly-built advanced flow", () => {
    const r = buildAdvancedFlow("F", [
      {
        title: "T",
        role: "general",
        instructions: "x",
        nodeType: "critic",
        tools: ["edit_file", "run_shell"],
      },
    ]);
    if (!r.ok) throw new Error("build failed");
    expect(assertFlowSafeAdvanced(r.graph)).toBeNull();
  });

  it("rejects a hand-mutated unattended card", () => {
    const r = buildAdvancedFlow("F", [
      { title: "T", role: "general", instructions: "x", nodeType: "critic" },
    ]);
    if (!r.ok) throw new Error("build failed");
    r.graph.cards[0].unattended = true;
    expect(assertFlowSafeAdvanced(r.graph)).toMatch(/unattended/);
  });

  it("rejects an elevated card whose needsReview was cleared", () => {
    const r = buildAdvancedFlow("F", [
      {
        title: "T",
        role: "general",
        instructions: "x",
        nodeType: "critic",
        tools: ["edit_file"],
      },
    ]);
    if (!r.ok) throw new Error("build failed");
    r.graph.cards[0].needsReview = false;
    expect(assertFlowSafeAdvanced(r.graph)).toMatch(/needsReview/);
  });

  it("rejects a forbidden tool smuggled in post-build", () => {
    const r = buildAdvancedFlow("F", [
      { title: "T", role: "general", instructions: "x", nodeType: "agent" },
    ]);
    if (!r.ok) throw new Error("build failed");
    r.graph.cards[0].tools = ["read_file", "delete_path"];
    expect(assertFlowSafeAdvanced(r.graph)).toMatch(/forbidden/);
  });

  it("rejects a tool outside the advanced allowlist", () => {
    const r = buildAdvancedFlow("F", [
      { title: "T", role: "general", instructions: "x", nodeType: "agent" },
    ]);
    if (!r.ok) throw new Error("build failed");
    r.graph.cards[0].tools = ["read_file", "open_app"];
    // open_app is both forbidden AND off-allowlist — forbidden check fires first
    expect(assertFlowSafeAdvanced(r.graph)).toMatch(/forbidden/);
  });

  it("rejects a scheduled advanced card", () => {
    const r = buildAdvancedFlow("F", [
      { title: "T", role: "general", instructions: "x", nodeType: "critic" },
    ]);
    if (!r.ok) throw new Error("build failed");
    r.graph.cards[0].schedule = "0 9 * * *";
    expect(assertFlowSafeAdvanced(r.graph)).toMatch(/schedule/);
  });
});
