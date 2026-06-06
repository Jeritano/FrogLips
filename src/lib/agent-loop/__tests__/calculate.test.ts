import { describe, expect, it } from "vitest";
import { safeCalculate } from "../dispatch";

/** The `calculate` tool's evaluator. Hand-written shunting-yard — must compute
 *  correctly AND never execute arbitrary code. */
describe("safeCalculate", () => {
  const ok = (expr: string) => {
    const r = safeCalculate(expr);
    if (!r.ok) throw new Error(`expected ok for "${expr}": ${r.error}`);
    return r.result;
  };

  it("evaluates basic arithmetic with precedence", () => {
    expect(ok("2 + 3 * 4")).toBe(14);
    expect(ok("(2 + 3) * 4")).toBe(20);
    expect(ok("10 / 4")).toBe(2.5);
    expect(ok("10 % 3")).toBe(1);
  });

  it("handles unary minus and exponent (right-assoc)", () => {
    expect(ok("-5 + 2")).toBe(-3);
    expect(ok("2 ^ 3 ^ 2")).toBe(512); // 2^(3^2), not (2^3)^2
    expect(ok("-2 ^ 2")).toBe(-4); // unary binds looser than ^
  });

  it("supports functions and constants", () => {
    expect(ok("sqrt(16)")).toBe(4);
    expect(ok("log(1000)")).toBeCloseTo(3, 10);
    expect(ok("ln(e)")).toBeCloseTo(1, 10);
    expect(ok("floor(pi)")).toBe(3);
    expect(ok("round(2.5)")).toBe(3);
  });

  it("rejects unknown names instead of executing them", () => {
    const r = safeCalculate("process.exit(1)");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(safeCalculate("2 +").ok).toBe(false);
    expect(safeCalculate("(1 + 2").ok).toBe(false);
    expect(safeCalculate("1 + 2)").ok).toBe(false);
    expect(safeCalculate("").ok).toBe(false);
  });

  it("rejects division producing non-finite results", () => {
    expect(safeCalculate("1 / 0").ok).toBe(false);
  });
});
