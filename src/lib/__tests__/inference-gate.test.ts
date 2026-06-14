import { describe, expect, it } from "vitest";
import {
  InferenceGate,
  shouldBypassInferenceGate,
  withInferenceSlot,
} from "../inference-gate";

/** Resolve on the next macrotask so we can observe queued/granted ordering. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("InferenceGate", () => {
  it("acquire/release: a single permit serializes two acquirers", async () => {
    const gate = new InferenceGate(1);
    expect(gate.available()).toBe(1);

    await gate.acquire(); // holder A
    expect(gate.available()).toBe(0);

    let bGranted = false;
    const b = gate.acquire().then(() => {
      bGranted = true;
    });
    await tick();
    // B must wait — no free permit.
    expect(bGranted).toBe(false);
    expect(gate.waiting()).toBe(1);

    gate.release(); // hand straight to B
    await b;
    expect(bGranted).toBe(true);
    expect(gate.waiting()).toBe(0);

    gate.release();
    expect(gate.available()).toBe(1);
  });

  it("permits>=1 enforced and capacity caps the free count", () => {
    expect(new InferenceGate(0).available()).toBe(1); // clamped up
    expect(new InferenceGate(-5).available()).toBe(1);
    const g = new InferenceGate(2);
    g.release(); // over-release must not exceed capacity
    expect(g.available()).toBe(2);
  });

  it("rejects when the signal is already aborted", async () => {
    const gate = new InferenceGate(1);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(gate.acquire(ctrl.signal)).rejects.toBeTruthy();
    // No permit consumed.
    expect(gate.available()).toBe(1);
  });

  it("abort while queued removes the waiter, rejects, and frees nothing for it", async () => {
    const gate = new InferenceGate(1);
    await gate.acquire(); // exhaust

    const ctrl = new AbortController();
    let rejected = false;
    const queued = gate.acquire(ctrl.signal).catch(() => {
      rejected = true;
    });
    await tick();
    expect(gate.waiting()).toBe(1);

    ctrl.abort();
    await queued;
    expect(rejected).toBe(true);
    expect(gate.waiting()).toBe(0);

    // The original holder still holds the only permit — releasing returns it.
    gate.release();
    expect(gate.available()).toBe(1);
  });

  it("FIFO: waiters are granted strictly in arrival order", async () => {
    const gate = new InferenceGate(1);
    await gate.acquire(); // holder

    const order: number[] = [];
    const p1 = gate.acquire().then(() => order.push(1));
    const p2 = gate.acquire().then(() => order.push(2));
    const p3 = gate.acquire().then(() => order.push(3));
    await tick();
    expect(order).toEqual([]); // all queued

    gate.release();
    await p1;
    gate.release();
    await p2;
    gate.release();
    await p3;
    expect(order).toEqual([1, 2, 3]);
    gate.release();
  });

  it("withInferenceSlot releases on success AND on throw", async () => {
    const gate = new InferenceGate(1);

    const v = await withInferenceSlot(undefined, async () => 42, gate);
    expect(v).toBe(42);
    expect(gate.available()).toBe(1); // released after success

    await expect(
      withInferenceSlot(
        undefined,
        async () => {
          throw new Error("boom");
        },
        gate,
      ),
    ).rejects.toThrow("boom");
    expect(gate.available()).toBe(1); // released after throw
  });

  it("withInferenceSlot does not run fn when aborted while queued, and never leaks", async () => {
    const gate = new InferenceGate(1);
    await gate.acquire(); // exhaust so the next is queued

    const ctrl = new AbortController();
    let ran = false;
    const p = withInferenceSlot(
      ctrl.signal,
      async () => {
        ran = true;
        return "x";
      },
      gate,
    ).catch(() => "aborted");
    await tick();
    ctrl.abort();
    const res = await p;
    expect(res).toBe("aborted");
    expect(ran).toBe(false);

    gate.release();
    expect(gate.available()).toBe(1);
  });

  it("setPermits grows capacity and wakes queued waiters", async () => {
    const gate = new InferenceGate(1);
    await gate.acquire(); // exhaust

    let granted = false;
    const q = gate.acquire().then(() => {
      granted = true;
    });
    await tick();
    expect(granted).toBe(false);

    gate.setPermits(2); // +1 capacity → wakes the queued waiter
    await q;
    expect(granted).toBe(true);
  });
});

describe("shouldBypassInferenceGate", () => {
  it("bypasses cloud routes, gates local routes", () => {
    expect(shouldBypassInferenceGate("kimi-k2.6:cloud", "ollama")).toBe(true);
    expect(shouldBypassInferenceGate("whatever", "custom")).toBe(true);
    expect(shouldBypassInferenceGate("whatever", "openrouter")).toBe(true);
    // Local routes are gated.
    expect(shouldBypassInferenceGate("llama3.1:8b", "ollama")).toBe(false);
    expect(shouldBypassInferenceGate("some-mlx-model", "mlx")).toBe(false);
    expect(shouldBypassInferenceGate("gguf-model", "native")).toBe(false);
    expect(shouldBypassInferenceGate(null, null)).toBe(false);
  });
});
