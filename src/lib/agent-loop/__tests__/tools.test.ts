import { describe, expect, it } from "vitest";
import { TOOLS } from "../tools";

describe("TOOLS registry", () => {
  it("exposes exactly 33 tool definitions", () => {
    expect(TOOLS.length).toBe(33);
  });

  it("every entry has function.name, function.description, function.parameters", () => {
    for (const t of TOOLS) {
      expect(t.type).toBe("function");
      expect(t.function).toBeDefined();
      expect(typeof t.function.name).toBe("string");
      expect(t.function.name.length).toBeGreaterThan(0);
      expect(typeof t.function.description).toBe("string");
      expect(t.function.description.length).toBeGreaterThan(0);
      expect(t.function.parameters).toBeDefined();
      expect(typeof t.function.parameters).toBe("object");
    }
  });

  it("tool names are unique", () => {
    const names = TOOLS.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
