/**
 * Phase 3 acceptance test for the HF GGUF tab in ModelBrowser.
 *
 * Verifies:
 *  1. The new `hf-gguf` source option renders and the GGUF tab body shows
 *     when selected.
 *  2. Selecting the tab triggers a HuggingFace API call against
 *     `/api/models?library=gguf&…` (NOT the legacy `author=mlx-community`
 *     filter the existing HF tab uses).
 *  3. Clicking a returned repo row fetches its file tree via
 *     `/api/models/{repo}/tree/main` and lists the `.gguf` leaves.
 *
 * The Tauri IPC bridge is fully mocked — we never call into the real
 * backend here. The point is the React surface and the HF fetch shape.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../../lib/tauri-api", () => ({
  api: {
    listAllModels: vi.fn(async () => ({
      ollama: [],
      mlx: [],
      ollama_error: null,
      mlx_error: null,
    })),
    nativeListGgufFiles: vi.fn(async () => []),
    agentNativeDownloadGguf: vi.fn(async () => "/tmp/fake.gguf"),
    nativeDeleteGguf: vi.fn(async () => undefined),
    pullOllamaModel: vi.fn(async () => "ok"),
    pullHfModel: vi.fn(async () => "ok"),
    deleteOllamaModel: vi.fn(async () => undefined),
    deleteMlxModel: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ModelBrowser } from "../ModelBrowser";

const SAMPLE_REPO = {
  id: "bartowski/Llama-3.2-3B-Instruct-GGUF",
  downloads: 12345,
  likes: 67,
  tags: ["gguf"],
};

const SAMPLE_TREE = [
  { type: "file", path: "Llama-3.2-3B-Instruct.Q4_K_M.gguf", size: 2_100_000_000 },
  { type: "file", path: "Llama-3.2-3B-Instruct.Q8_0.gguf", size: 3_500_000_000 },
  { type: "file", path: "README.md", size: 1234 },
  { type: "directory", path: "subdir", size: 0 },
];

function mockFetch() {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("/api/models?")) {
      return {
        ok: true,
        status: 200,
        json: async () => [SAMPLE_REPO],
      } as unknown as Response;
    }
    if (url.includes("/tree/main")) {
      return {
        ok: true,
        status: 200,
        json: async () => SAMPLE_TREE,
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ModelBrowser — HF GGUF tab", () => {
  let originalFetch: typeof fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Browser timer fakes — but use modern fake timers so microtasks still run.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("renders the hf-gguf option and queries HF with library=gguf when selected", async () => {
    const { fn: fetchSpy, calls } = mockFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ModelBrowser onClose={() => {}} onPulled={() => {}} />);
    });
    await flush();

    // The source <select> should include the new option AND the legacy ones.
    const select = container.querySelector(".mb-source-select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("hf-gguf");
    expect(values).toContain("hf"); // legacy MLX tab still present — no regression

    // Switch to the GGUF tab.
    await act(async () => {
      select.value = "hf-gguf";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Advance the 250ms debounce + flush microtasks.
    await act(async () => { vi.advanceTimersByTime(300); });
    await flush();
    await flush();

    // Tab body rendered.
    expect(container.querySelector('[data-testid="hf-gguf-tab"]')).not.toBeNull();

    // HF called with `library=gguf` and NOT pinned to mlx-community.
    const hfCalls = calls.filter((u) => u.includes("/api/models?"));
    expect(hfCalls.length).toBeGreaterThan(0);
    const last = hfCalls[hfCalls.length - 1];
    expect(last).toContain("library=gguf");
    expect(last).not.toContain("author=mlx-community");
    expect(fetchSpy).toHaveBeenCalled();

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("loads the repo file tree on click and only surfaces .gguf leaves", async () => {
    const { calls } = mockFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ModelBrowser onClose={() => {}} onPulled={() => {}} />);
    });
    await flush();

    const select = container.querySelector(".mb-source-select") as HTMLSelectElement;
    await act(async () => {
      select.value = "hf-gguf";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flush();
    await flush();

    // Repo row appeared.
    const repoToggle = container.querySelector(
      `[data-testid="gguf-repo-toggle-${SAMPLE_REPO.id}"]`,
    ) as HTMLElement;
    expect(repoToggle).not.toBeNull();

    // Click to expand → fires the tree fetch.
    await act(async () => { repoToggle.click(); });
    await flush();
    await flush();

    // Tree endpoint hit with the exact repo id.
    const treeCalls = calls.filter((u) => u.includes("/tree/main"));
    expect(treeCalls.length).toBe(1);
    expect(treeCalls[0]).toContain(encodeURIComponent(SAMPLE_REPO.id));

    // Both .gguf files surfaced; README + directory filtered out.
    expect(
      container.querySelector(
        `[data-testid="gguf-file-${SAMPLE_REPO.id}-Llama-3.2-3B-Instruct.Q4_K_M.gguf"]`,
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        `[data-testid="gguf-file-${SAMPLE_REPO.id}-Llama-3.2-3B-Instruct.Q8_0.gguf"]`,
      ),
    ).not.toBeNull();
    // README.md and the directory entry must NOT render — testing presence
    // by the absence of any file row whose testid includes README.md.
    const allFileCards = container.querySelectorAll('[data-testid^="gguf-file-"]');
    for (const card of allFileCards) {
      const tid = card.getAttribute("data-testid") || "";
      expect(tid.endsWith(".gguf")).toBe(true);
    }

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("download button invokes agentNativeDownloadGguf with (repo, filename)", async () => {
    mockFetch();
    const { api } = await import("../../lib/tauri-api");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ModelBrowser onClose={() => {}} onPulled={() => {}} />);
    });
    await flush();

    const select = container.querySelector(".mb-source-select") as HTMLSelectElement;
    await act(async () => {
      select.value = "hf-gguf";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(300); });
    await flush();
    await flush();

    const repoToggle = container.querySelector(
      `[data-testid="gguf-repo-toggle-${SAMPLE_REPO.id}"]`,
    ) as HTMLElement;
    await act(async () => { repoToggle.click(); });
    await flush();
    await flush();

    const dlBtn = container.querySelector(
      `[data-testid="gguf-download-${SAMPLE_REPO.id}-Llama-3.2-3B-Instruct.Q4_K_M.gguf"]`,
    ) as HTMLButtonElement;
    expect(dlBtn).not.toBeNull();

    await act(async () => { dlBtn.click(); });
    await flush();

    expect(api.agentNativeDownloadGguf).toHaveBeenCalledWith(
      SAMPLE_REPO.id,
      "Llama-3.2-3B-Instruct.Q4_K_M.gguf",
    );

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
