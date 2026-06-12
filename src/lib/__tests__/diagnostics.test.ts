import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom's Storage exposes only a getter map (no full Storage interface).
// Swap in a Map-backed shim before importing the module under test so its
// localStorage reads/writes work. Matches the pattern used by
// prompt-templates.test.ts.
const storeMap = new Map<string, string>();
const fakeStorage: Storage = {
  get length() {
    return storeMap.size;
  },
  clear: () => {
    storeMap.clear();
  },
  getItem: (k: string) =>
    storeMap.has(k) ? (storeMap.get(k) as string) : null,
  setItem: (k: string, v: string) => {
    storeMap.set(k, String(v));
  },
  removeItem: (k: string) => {
    storeMap.delete(k);
  },
  key: (i: number) => Array.from(storeMap.keys())[i] ?? null,
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: fakeStorage,
});

import {
  __resetDiagnosticsForTests,
  clearDiag,
  listDiag,
  logDiag,
  subscribeDiag,
} from "../diagnostics";

const STORAGE_KEY = "froglips.diagnostics";

beforeEach(() => {
  storeMap.clear();
  __resetDiagnosticsForTests();
});

afterEach(() => {
  __resetDiagnosticsForTests();
  storeMap.clear();
});

describe("diagnostics ring buffer", () => {
  it("records entries with the current timestamp and exposes them via listDiag()", () => {
    const before = Date.now();
    logDiag({ level: "info", source: "test", message: "hello" });
    const after = Date.now();
    const all = listDiag();
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe("test");
    expect(all[0].level).toBe("info");
    expect(all[0].message).toBe("hello");
    expect(all[0].ts).toBeGreaterThanOrEqual(before);
    expect(all[0].ts).toBeLessThanOrEqual(after);
  });

  it("caps the buffer at 500 entries (FIFO eviction)", () => {
    for (let i = 0; i < 600; i++) {
      logDiag({ level: "warn", source: "load", message: `m${i}` });
    }
    const all = listDiag();
    expect(all.length).toBe(500);
    // First entry should be m100 (since 600 - 500 = 100 dropped from the head).
    expect(all[0].message).toBe("m100");
    expect(all[all.length - 1].message).toBe("m599");
  });

  it("persists the most-recent 100 entries to localStorage and rehydrates on read", () => {
    for (let i = 0; i < 150; i++) {
      logDiag({ level: "warn", source: "persist", message: `n${i}` });
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(100);
    // Tail should be the most-recent 100 entries (n50..n149)
    expect(parsed[0].message).toBe("n50");
    expect(parsed[99].message).toBe("n149");

    // Now simulate a reload by resetting in-memory state and reading again.
    __resetDiagnosticsForTests();
    const hydrated = listDiag();
    expect(hydrated.length).toBe(100);
    expect(hydrated[0].message).toBe("n50");
    expect(hydrated[hydrated.length - 1].message).toBe("n149");
  });

  it("notifies subscribers on push and on clear", () => {
    const calls: number[] = [];
    const off = subscribeDiag((snap) => calls.push(snap.length));
    // Priming call.
    expect(calls).toEqual([0]);
    logDiag({ level: "warn", source: "sub", message: "one" });
    logDiag({ level: "error", source: "sub", message: "two" });
    expect(calls).toEqual([0, 1, 2]);
    clearDiag();
    expect(calls).toEqual([0, 1, 2, 0]);
    off();
    // After unsubscribe, further pushes don't notify.
    logDiag({ level: "info", source: "sub", message: "three" });
    expect(calls).toEqual([0, 1, 2, 0]);
  });

  it("clearDiag wipes both in-memory and persisted state", () => {
    logDiag({ level: "warn", source: "wipe", message: "x" });
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    clearDiag();
    expect(listDiag()).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("normalises Error instances in detail so they JSON-serialise", () => {
    const err = new Error("boom");
    logDiag({
      level: "warn",
      source: "norm",
      message: "see detail",
      detail: err,
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].detail).toMatchObject({ message: "boom", name: "Error" });
  });

  it("does not throw when localStorage is unavailable", () => {
    // Simulate a broken setItem (quota exceeded). The push must still land
    // in memory.
    const original = fakeStorage.setItem;
    fakeStorage.setItem = vi.fn(() => {
      throw new Error("quota");
    });
    try {
      expect(() =>
        logDiag({ level: "warn", source: "quota", message: "y" }),
      ).not.toThrow();
      expect(listDiag()).toHaveLength(1);
    } finally {
      fakeStorage.setItem = original;
    }
  });
});
