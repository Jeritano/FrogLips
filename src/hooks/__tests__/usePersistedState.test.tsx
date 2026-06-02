import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePersistedState } from "../usePersistedState";

// The test runtime's global `localStorage` (Node's experimental,
// file-backed Web Storage) only partially implements the Storage API
// (removeItem/clear throw). Install a clean in-memory Storage so the hook
// and the assertions share one deterministic, fully-functional store.
const __store = new Map<string, string>();
const memoryStorage: Storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k)! : null),
  setItem: (k, v) => {
    __store.set(k, String(v));
  },
  removeItem: (k) => {
    __store.delete(k);
  },
  clear: () => {
    __store.clear();
  },
  key: (i) => Array.from(__store.keys())[i] ?? null,
  get length() {
    return __store.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: memoryStorage,
  configurable: true,
});

// createRoot/act harness (no testing-library, matching the repo convention).
let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  localStorage.clear();
});

let captured: { value: unknown; set: (v: unknown) => void } | null = null;

function Harness({ k, initial }: { k: string; initial: unknown }) {
  const [value, set] = usePersistedState(k, initial);
  captured = { value, set: set as (v: unknown) => void };
  return null;
}

function mount(k: string, initial: unknown) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness k={k} initial={initial} />);
  });
}

describe("usePersistedState", () => {
  it("uses the initial value when storage is empty", () => {
    localStorage.removeItem("k.empty");
    mount("k.empty", "default");
    expect(captured!.value).toBe("default");
  });

  it("writes the value to localStorage on change", () => {
    localStorage.removeItem("k.write");
    mount("k.write", "a");
    act(() => captured!.set("b"));
    expect(captured!.value).toBe("b");
    expect(JSON.parse(localStorage.getItem("k.write")!)).toBe("b");
  });

  it("hydrates from a previously-persisted value over the initial", () => {
    localStorage.setItem("k.hydrate", JSON.stringify("stored"));
    mount("k.hydrate", "default");
    expect(captured!.value).toBe("stored");
  });

  it("survives a remount (persisted across unmount)", () => {
    localStorage.removeItem("k.remount");
    mount("k.remount", false);
    act(() => captured!.set(true));
    act(() => root!.unmount());
    root = null;
    mount("k.remount", false);
    expect(captured!.value).toBe(true);
  });

  it("round-trips object values (e.g. an applied LoRA row)", () => {
    localStorage.removeItem("k.obj");
    const row = { sha: "abc", weight: 1.0 };
    mount("k.obj", null);
    act(() => captured!.set(row));
    act(() => root!.unmount());
    root = null;
    mount("k.obj", null);
    expect(captured!.value).toEqual(row);
  });

  it("falls back to initial on a corrupt stored entry", () => {
    localStorage.setItem("k.corrupt", "{not json");
    mount("k.corrupt", "safe");
    expect(captured!.value).toBe("safe");
  });

  it("pins the first initial — a changing initial prop does not override it", () => {
    localStorage.removeItem("k.initial");
    mount("k.initial", "A");
    expect(captured!.value).toBe("A");
    // Re-render the same hook with a different `initial`; the value must stay
    // "A" (the lazy initializer ran once; the ref pins it).
    act(() => {
      root!.render(<Harness k="k.initial" initial="B" />);
    });
    expect(captured!.value).toBe("A");
  });

  it("ignores a persisted value the validator rejects", () => {
    localStorage.setItem("k.validate", JSON.stringify("stale"));
    mountWithValidator(
      "k.validate",
      "fallback",
      (v): v is string => v === "ok" || v === "fallback",
    );
    expect(captured!.value).toBe("fallback");
  });

  it("does not re-write the value on mount (only on genuine change)", () => {
    localStorage.setItem("k.nowrite", JSON.stringify("hydrated"));
    // Sentinel: a different raw form than JSON.stringify would produce, so a
    // mount-time write would overwrite it and we'd detect the churn.
    localStorage.setItem("k.nowrite", '"hydrated"');
    mount("k.nowrite", "x");
    expect(captured!.value).toBe("hydrated");
    // No set() called → value must remain exactly what we seeded.
    expect(localStorage.getItem("k.nowrite")).toBe('"hydrated"');
  });
});

function Harness2({
  k,
  initial,
  validate,
}: {
  k: string;
  initial: unknown;
  validate: (v: unknown) => v is string;
}) {
  const [value, set] = usePersistedState(k, initial, validate);
  captured = { value, set: set as (v: unknown) => void };
  return null;
}

function mountWithValidator(
  k: string,
  initial: unknown,
  validate: (v: unknown) => v is string,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness2 k={k} initial={initial} validate={validate} />);
  });
}
