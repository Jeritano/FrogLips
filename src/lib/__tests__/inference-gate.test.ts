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

  it("shrink-with-queued-waiter does NOT over-grant past capacity on release", async () => {
    // Repro of the over-grant bug: shrinking never preempts in-flight holders,
    // so a release while over-subscribed must NOT hand a permit to a waiter
    // alongside the still-in-flight over-capacity holder.
    const gate = new InferenceGate(2);
    await gate.acquire(); // holder A (inFlight=1)
    await gate.acquire(); // holder B (inFlight=2)

    let granted = false;
    const c = gate.acquire().then(() => {
      granted = true;
    }); // queued waiter C
    await tick();
    expect(gate.waiting()).toBe(1);

    gate.setPermits(1); // capacity→1, but A+B (=2) still in flight, C queued

    // First release (say A finishes): in-flight drops 2→1, still AT capacity,
    // so C must remain queued — granting it would mean 2 concurrent vs cap 1.
    gate.release();
    await tick();
    expect(granted).toBe(false);
    expect(gate.waiting()).toBe(1);

    // Second release (B finishes): in-flight 1→0, now below capacity → hand to C.
    gate.release();
    await c;
    expect(granted).toBe(true);
    expect(gate.waiting()).toBe(0);

    // C releases → back to one free permit at the shrunk capacity.
    gate.release();
    expect(gate.available()).toBe(1);
  });
});

describe("shouldBypassInferenceGate", () => {
  it("bypasses cloud routes, gates local routes", () => {
    expect(shouldBypassInferenceGate("kimi-k2.6:cloud", "ollama")).toBe(true);
    expect(shouldBypassInferenceGate("whatever", "openrouter")).toBe(true);
    // Local routes are gated.
    expect(shouldBypassInferenceGate("llama3.1:8b", "ollama")).toBe(false);
    expect(shouldBypassInferenceGate("some-mlx-model", "mlx")).toBe(false);
    expect(shouldBypassInferenceGate("gguf-model", "native")).toBe(false);
    expect(shouldBypassInferenceGate(null, null)).toBe(false);
  });

  it("custom backend: bypasses genuinely-remote endpoints", () => {
    expect(
      shouldBypassInferenceGate("gpt-4o", "custom", "https://api.example.com/v1"),
    ).toBe(true);
    expect(
      shouldBypassInferenceGate("m", "custom", "https://infer.together.ai/v1"),
    ).toBe(true);
  });

  it("custom backend: GATES local/private endpoints (the local device)", () => {
    // Loopback / localhost.
    expect(
      shouldBypassInferenceGate("m", "custom", "http://localhost:8000/v1"),
    ).toBe(false);
    expect(
      shouldBypassInferenceGate("m", "custom", "http://127.0.0.1:11434/v1"),
    ).toBe(false);
    expect(shouldBypassInferenceGate("m", "custom", "http://[::1]:8000/v1")).toBe(
      false,
    );
    // RFC1918 / CGNAT / link-local LAN boxes.
    expect(
      shouldBypassInferenceGate("m", "custom", "http://192.168.1.5:8000/v1"),
    ).toBe(false);
    expect(shouldBypassInferenceGate("m", "custom", "http://10.0.0.9:8000")).toBe(
      false,
    );
    expect(
      shouldBypassInferenceGate("m", "custom", "http://172.16.4.2:8000"),
    ).toBe(false);
    expect(
      shouldBypassInferenceGate("m", "custom", "http://100.100.5.5:8000"),
    ).toBe(false);
    // mDNS .local name.
    expect(
      shouldBypassInferenceGate("m", "custom", "http://gpu-box.local:8000/v1"),
    ).toBe(false);
    // No base_url → gate conservatively (protect the local device).
    expect(shouldBypassInferenceGate("m", "custom")).toBe(false);
    expect(shouldBypassInferenceGate("m", "custom", "not a url")).toBe(false);
  });
});
