import { afterEach, beforeEach, describe, expect, it } from "vitest";

// happy-dom's Storage exposes only a getter map (no setItem/clear) in this
// project's pinned version. Swap in a Map-backed shim before importing the
// module under test so its localStorage reads/writes work.
const storeMap = new Map<string, string>();
const fakeStorage: Storage = {
  get length() { return storeMap.size; },
  clear: () => { storeMap.clear(); },
  getItem: (k: string) => (storeMap.has(k) ? (storeMap.get(k) as string) : null),
  setItem: (k: string, v: string) => { storeMap.set(k, String(v)); },
  removeItem: (k: string) => { storeMap.delete(k); },
  key: (i: number) => Array.from(storeMap.keys())[i] ?? null,
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: fakeStorage,
});

import {
  applyTemplate,
  deleteCustomTemplate,
  extractVariables,
  filterByTrigger,
  generateTemplateId,
  getBuiltInTemplates,
  loadAllTemplates,
  loadAllTemplatesForManager,
  saveCustomTemplate,
  setBuiltInHidden,
} from "../prompt-templates";

const BUILTIN_TRIGGERS = ["explain", "refactor", "test", "summarize", "commit"];

function clearStorage() {
  storeMap.clear();
}

beforeEach(() => {
  clearStorage();
});

afterEach(() => {
  clearStorage();
});

describe("prompt-templates: built-ins", () => {
  it("ships all 5 built-in templates with the expected triggers", () => {
    const built = getBuiltInTemplates();
    expect(built).toHaveLength(5);
    expect(built.map((t) => t.trigger).sort()).toEqual(
      [...BUILTIN_TRIGGERS].sort(),
    );
    for (const t of built) {
      expect(t.builtIn).toBe(true);
    }
  });

  it("built-ins are always present in the manager view, even when hidden", () => {
    setBuiltInHidden("explain", true);
    const { builtIns, hiddenIds } = loadAllTemplatesForManager();
    expect(builtIns).toHaveLength(5);
    expect(hiddenIds.has("explain")).toBe(true);
  });

  it("loadAllTemplates omits hidden built-ins", () => {
    setBuiltInHidden("commit", true);
    const visible = loadAllTemplates();
    expect(visible.find((t) => t.trigger === "commit")).toBeUndefined();
    expect(visible.length).toBe(4);
  });
});

describe("prompt-templates: extractVariables", () => {
  it("pulls {foo} and {bar} from a body", () => {
    expect(extractVariables("do {foo} with {bar}")).toEqual(["foo", "bar"]);
  });

  it("returns [] when there are no variables", () => {
    expect(extractVariables("static prompt with no slots")).toEqual([]);
  });

  it("dedupes repeated names but preserves first-seen order", () => {
    expect(extractVariables("{a} then {b} then {a}")).toEqual(["a", "b"]);
  });

  it("ignores malformed braces", () => {
    expect(extractVariables("{ space } and {1bad}")).toEqual([]);
  });
});

describe("prompt-templates: custom persistence", () => {
  it("saves and reloads a custom template", () => {
    saveCustomTemplate({
      id: "my-tpl",
      name: "My template",
      trigger: "mine",
      body: "Hello {who}",
      variables: [],
    });
    const all = loadAllTemplates();
    const found = all.find((t) => t.id === "my-tpl");
    expect(found).toBeDefined();
    expect(found?.variables).toEqual(["who"]);
    expect(found?.builtIn).toBe(false);
  });

  it("deletes a custom template", () => {
    saveCustomTemplate({
      id: "tmp",
      name: "tmp",
      trigger: "tmp",
      body: "x",
      variables: [],
    });
    deleteCustomTemplate("tmp");
    expect(loadAllTemplates().find((t) => t.id === "tmp")).toBeUndefined();
  });

  it("custom template overrides a built-in with the same trigger", () => {
    saveCustomTemplate({
      id: "user-explain",
      name: "Custom Explain",
      trigger: "explain",
      body: "Custom explainer for {selection}",
      variables: [],
    });
    const all = loadAllTemplates();
    const explainers = all.filter((t) => t.trigger === "explain");
    expect(explainers).toHaveLength(1);
    expect(explainers[0].id).toBe("user-explain");
    expect(explainers[0].builtIn).toBe(false);
    expect(explainers[0].body).toContain("Custom explainer");
  });

  it("survives a 'restart' (re-reading from localStorage)", () => {
    saveCustomTemplate({
      id: "persist-me",
      name: "P",
      trigger: "pst",
      body: "body {x}",
      variables: [],
    });
    // Simulate a fresh page load: read state from scratch.
    const all = loadAllTemplates();
    expect(all.find((t) => t.id === "persist-me")?.body).toBe("body {x}");
  });
});

describe("prompt-templates: filterByTrigger", () => {
  it("matches by prefix, case-insensitive", () => {
    const built = getBuiltInTemplates();
    expect(filterByTrigger(built, "expl").map((t) => t.trigger)).toEqual(["explain"]);
    expect(filterByTrigger(built, "EXPL").map((t) => t.trigger)).toEqual(["explain"]);
  });

  it("returns the full list when prefix is empty", () => {
    const built = getBuiltInTemplates();
    expect(filterByTrigger(built, "")).toHaveLength(built.length);
  });

  it("returns [] when nothing matches", () => {
    expect(filterByTrigger(getBuiltInTemplates(), "zzz")).toEqual([]);
  });
});

describe("prompt-templates: applyTemplate", () => {
  it("returns body unchanged and null range when there are no variables", () => {
    const tpl = {
      id: "x",
      name: "x",
      trigger: "x",
      body: "no slots",
      variables: extractVariables("no slots"),
    };
    const out = applyTemplate(tpl);
    expect(out.text).toBe("no slots");
    expect(out.firstVarRange).toBeNull();
  });

  it("rewrites {var} → [var] and returns the first-placeholder range", () => {
    const body = "Refactor {selection} for {goal}.";
    const tpl = {
      id: "r",
      name: "r",
      trigger: "r",
      body,
      variables: extractVariables(body),
    };
    const out = applyTemplate(tpl);
    expect(out.text).toBe("Refactor [selection] for [goal].");
    expect(out.firstVarRange).toEqual({
      start: out.text.indexOf("[selection]"),
      end: out.text.indexOf("[selection]") + "[selection]".length,
    });
  });
});

describe("prompt-templates: generateTemplateId", () => {
  it("derives an id from the trigger", () => {
    const id = generateTemplateId("My Trigger!");
    expect(id.startsWith("my-trigger-")).toBe(true);
  });

  it("falls back to 'custom-' when trigger has no usable chars", () => {
    const id = generateTemplateId("!!!");
    expect(id.startsWith("custom-")).toBe(true);
  });
});
