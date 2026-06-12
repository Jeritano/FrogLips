import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cosineSim,
  createConfig,
  deleteConfig,
  duplicateConfig,
  getActiveConfigId,
  loadConfigs,
  loadRoutes,
  routeMessage,
  setActiveConfigId,
  updateConfig,
  type ChatRoute,
} from "../chat-router";

/**
 * Router decision logic. `classify` is injected so the pipeline is tested
 * deterministically without a real model.
 */

const ROUTES: ChatRoute[] = [
  {
    id: "code",
    label: "Coder",
    whenToUse: "programming, debugging",
    keywords: ["```", "stack trace"],
    model: "qwen3-coder",
    backend: "ollama",
    preset: "coder",
  },
  {
    id: "web",
    label: "Web",
    whenToUse: "current events, look something up",
    model: "llama3",
    backend: "ollama",
  },
  {
    id: "reason",
    label: "Reasoner",
    whenToUse: "hard math and logic",
    model: "deepseek-r1:cloud",
    backend: "ollama",
    isDefault: true,
  },
];

describe("routeMessage", () => {
  it("returns null when there are no routes", async () => {
    const d = await routeMessage("hi", [], { classify: async () => "1" });
    expect(d).toBeNull();
  });

  it("takes the keyword fast-path without calling the classifier", async () => {
    const classify = vi.fn(async () => "2");
    const d = await routeMessage("here is a ``` code block", ROUTES, {
      classify,
    });
    expect(d?.routeId).toBe("code");
    expect(d?.method).toBe("keyword");
    expect(classify).not.toHaveBeenCalled();
  });

  it("uses the classifier's pick when no keyword matches", async () => {
    const d = await routeMessage("what happened in the news today", ROUTES, {
      classify: async () => "2 — looks like a lookup",
    });
    expect(d?.routeId).toBe("web");
    expect(d?.method).toBe("classifier");
    expect(d?.reason).toContain("lookup");
  });

  it("marks the decision sticky when the classifier keeps the current route", async () => {
    const d = await routeMessage("more about that", ROUTES, {
      stickyRouteId: "web",
      classify: async () => "2",
    });
    expect(d?.routeId).toBe("web");
    expect(d?.method).toBe("sticky");
  });

  it("falls back to the default route when the classifier is unparseable", async () => {
    const d = await routeMessage("ambiguous thing", ROUTES, {
      classify: async () => "no idea",
    });
    expect(d?.routeId).toBe("reason"); // isDefault
    expect(d?.method).toBe("default");
  });

  it("falls back to default when the classifier throws", async () => {
    const d = await routeMessage("ambiguous thing", ROUTES, {
      classify: async () => {
        throw new Error("model down");
      },
    });
    expect(d?.routeId).toBe("reason");
    expect(d?.method).toBe("default");
  });

  it("clamps an out-of-range classifier number to default", async () => {
    const d = await routeMessage("thing", ROUTES, {
      classify: async () => "99",
    });
    expect(d?.method).toBe("default");
  });

  it("ignores numbers inside reasoning <think> blocks (picks the final answer)", async () => {
    // A reasoning model that streams its chain-of-thought inline: the '2' and
    // '3' are inside <think>; the real answer is '1' after it.
    const d = await routeMessage("debug my code", ROUTES, {
      classify: async () =>
        "<think>could be 2 (web) or 3 (reason)...</think>\n1",
    });
    expect(d?.routeId).toBe("code");
    expect(d?.method).toBe("classifier");
  });

  it("handles an unclosed trailing <think> by falling back to default", async () => {
    const d = await routeMessage("x", ROUTES, {
      classify: async () => "<think>hmm 2 then 3 then",
    });
    expect(d?.method).toBe("default"); // no parseable answer outside the think block
  });
});

describe("cosineSim", () => {
  it("is 1 for identical, 0 for orthogonal", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("is 0 when a vector is all-zero", () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});

describe("routeMessage — semantic stage (Stage 2)", () => {
  const prototypes = new Map<string, number[]>([
    ["code", [1, 0]],
    ["web", [0, 1]],
  ]);
  const classify = vi.fn(async () => "2"); // would pick web if reached

  it("picks the nearest prototype above threshold + margin, no classifier call", async () => {
    classify.mockClear();
    const d = await routeMessage("debug this", ROUTES, {
      classify,
      embedQuery: async () => [1, 0.02], // ~code
      prototypes,
    });
    expect(d?.routeId).toBe("code");
    expect(d?.method).toBe("semantic");
    expect(d?.score).toBeGreaterThan(0.9);
    expect(classify).not.toHaveBeenCalled();
  });

  it("falls through to the classifier when the match is ambiguous (margin too small)", async () => {
    classify.mockClear();
    const d = await routeMessage("ambiguous", ROUTES, {
      classify,
      embedQuery: async () => [1, 1], // equidistant → margin ~0
      prototypes,
    });
    expect(classify).toHaveBeenCalled();
    expect(d?.routeId).toBe("web"); // classifier said "2"
    expect(d?.method).toBe("classifier");
  });

  it("skips Stage 2 cleanly when no embedder is available", async () => {
    classify.mockClear();
    const d = await routeMessage("anything", ROUTES, {
      classify,
      embedQuery: async () => null, // embedder down
      prototypes,
    });
    expect(classify).toHaveBeenCalled(); // fell through to Stage 3
    expect(d?.method).toBe("classifier");
  });
});

// In-memory localStorage shim — the lib tests run in an env whose localStorage
// isn't reliably writable; a fresh Map-backed store per test isolates config CRUD.
class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

describe("router configurations", () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage =
      new MemStore() as unknown as Storage;
  });

  it("creates a config, makes it active, and exposes its routes via loadRoutes", () => {
    const cfg = createConfig("Hybrid", ROUTES);
    expect(getActiveConfigId()).toBe(cfg.id);
    expect(loadConfigs().map((c) => c.label)).toContain("Hybrid");
    expect(loadRoutes().map((r) => r.id)).toEqual(ROUTES.map((r) => r.id));
  });

  it("updates label/notes/routes on the active config", () => {
    const cfg = createConfig("A", []);
    updateConfig(cfg.id, { label: "Renamed", notes: "why" });
    const reloaded = loadConfigs().find((c) => c.id === cfg.id);
    expect(reloaded?.label).toBe("Renamed");
    expect(reloaded?.notes).toBe("why");
  });

  it("duplicates a config", () => {
    const cfg = createConfig("Base", ROUTES);
    const dup = duplicateConfig(cfg.id);
    expect(dup).not.toBeNull();
    expect(loadConfigs()).toHaveLength(2);
    expect(dup?.routes).toHaveLength(ROUTES.length);
  });

  it("deleting the active config switches active to a survivor", () => {
    const a = createConfig("A", []);
    const b = createConfig("B", []);
    setActiveConfigId(a.id);
    deleteConfig(a.id);
    expect(loadConfigs().some((c) => c.id === a.id)).toBe(false);
    expect(getActiveConfigId()).toBe(b.id);
  });

  it("migrates a legacy flat chat.routes list into a Default config", () => {
    localStorage.setItem("chat.routes", JSON.stringify(ROUTES));
    const configs = loadConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].label).toBe("Default");
    expect(configs[0].routes.map((r) => r.id)).toEqual(ROUTES.map((r) => r.id));
  });
});
