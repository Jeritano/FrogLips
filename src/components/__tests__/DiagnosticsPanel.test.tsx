import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

// happy-dom's Storage exposes only a getter map; swap in a Map-backed shim
// (same pattern as diagnostics.test.ts) BEFORE importing modules that touch
// localStorage at import-time.
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

import { DiagnosticsPanel } from "../DiagnosticsPanel";
import { __resetDiagnosticsForTests, logDiag } from "../../lib/diagnostics";

beforeEach(() => {
  storeMap.clear();
  __resetDiagnosticsForTests();
});

afterEach(() => {
  __resetDiagnosticsForTests();
  storeMap.clear();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DiagnosticsPanel", () => {
  it("returns null when not open", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DiagnosticsPanel open={false} onClose={() => {}} />);
    });
    expect(
      container.querySelector('[data-testid="diagnostics-panel"]'),
    ).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders recorded entries with level + source + message", async () => {
    logDiag({
      level: "warn",
      source: "memory-recall",
      message: "vector search failed",
    });
    logDiag({ level: "error", source: "ollama-client", message: "Ollama 500" });
    logDiag({ level: "info", source: "mcp", message: "server restarted" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />);
    });
    await flush();

    const panel = container.querySelector('[data-testid="diagnostics-panel"]');
    expect(panel).not.toBeNull();

    const rows = container.querySelectorAll('[data-testid="diag-row"]');
    expect(rows.length).toBe(3);

    // Verify all three sources appear in the rendered table. (Per-row order
    // depends on Date.now() timestamps which may collide within a single ms;
    // assert membership rather than position.)
    const sources = Array.from(rows).map((r) => r.getAttribute("data-source"));
    expect(sources.sort()).toEqual(["mcp", "memory-recall", "ollama-client"]);

    const text = container.textContent ?? "";
    expect(text).toContain("vector search failed");
    expect(text).toContain("Ollama 500");
    expect(text).toContain("server restarted");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("filters by level via the level dropdown", async () => {
    logDiag({ level: "warn", source: "a", message: "warn-entry" });
    logDiag({ level: "error", source: "b", message: "error-entry" });
    logDiag({ level: "info", source: "c", message: "info-entry" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />);
    });
    await flush();

    expect(container.querySelectorAll('[data-testid="diag-row"]').length).toBe(
      3,
    );

    const levelSel = container.querySelector(
      '[data-testid="diag-level"]',
    ) as HTMLSelectElement;
    expect(levelSel).toBeTruthy();
    await act(async () => {
      const proto = Object.getPrototypeOf(levelSel);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      desc?.set?.call(levelSel, "error");
      levelSel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    const rows = container.querySelectorAll('[data-testid="diag-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute("data-level")).toBe("error");
    expect(rows[0].textContent).toContain("error-entry");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("clear button requires two clicks (arms, then wipes)", async () => {
    logDiag({ level: "warn", source: "wipe", message: "doomed" });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DiagnosticsPanel open={true} onClose={() => {}} />);
    });
    await flush();

    const clearBtn = container.querySelector(
      '[data-testid="diag-clear"]',
    ) as HTMLButtonElement;
    expect(clearBtn).toBeTruthy();
    expect(clearBtn.textContent).toBe("Clear");
    expect(container.querySelectorAll('[data-testid="diag-row"]').length).toBe(
      1,
    );

    // First click arms.
    await act(async () => {
      clearBtn.click();
    });
    await flush();
    expect(clearBtn.textContent).toContain("Click again to confirm");
    // Entries still present.
    expect(container.querySelectorAll('[data-testid="diag-row"]').length).toBe(
      1,
    );

    // Second click clears.
    await act(async () => {
      clearBtn.click();
    });
    await flush();
    expect(container.querySelectorAll('[data-testid="diag-row"]').length).toBe(
      0,
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
