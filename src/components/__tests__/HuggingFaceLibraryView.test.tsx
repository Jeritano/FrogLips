/**
 * Tests for the new HuggingFaceLibraryView.
 *
 * We mount the view directly (NOT through ModelBrowser) so we can drive
 * the props in isolation. The HF API is mocked via a fetch stub that
 * returns predictable repos and reports URL params we can assert on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { HuggingFaceLibraryView } from "../HuggingFaceLibraryView";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLE_MODELS = [
  {
    id: "mlx-community/Llama-3.2-3B-Instruct",
    downloads: 12000,
    likes: 45,
    tags: ["mlx"],
    pipeline_tag: "text-generation",
    lastModified: "2025-04-01T00:00:00Z",
  },
  {
    id: "bartowski/Mistral-7B-Instruct-GGUF",
    downloads: 80000,
    likes: 320,
    tags: ["gguf"],
    pipeline_tag: "text-generation",
    lastModified: "2025-03-01T00:00:00Z",
  },
  {
    id: "meta-llama/Llama-3.1-70B-Instruct",
    downloads: 50000,
    likes: 800,
    tags: ["transformers", "safetensors"],
    pipeline_tag: "text-generation",
    lastModified: "2025-02-01T00:00:00Z",
  },
  {
    id: "stabilityai/stable-diffusion-xl",
    downloads: 9000,
    likes: 150,
    tags: ["diffusers"],
    pipeline_tag: "text-to-image",
    lastModified: "2025-01-01T00:00:00Z",
  },
  {
    id: "test/tts-model-1B",
    downloads: 700,
    likes: 12,
    tags: ["transformers"],
    pipeline_tag: "text-to-speech",
    lastModified: "2024-12-01T00:00:00Z",
  },
];

function mockFetch() {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "x-total-count": "2898041" }),
      json: async () => SAMPLE_MODELS,
    } as unknown as Response;
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

function mountView(
  extra: Partial<React.ComponentProps<typeof HuggingFaceLibraryView>> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props: React.ComponentProps<typeof HuggingFaceLibraryView> = {
    installedMlxIds: new Set<string>(),
    onPull: vi.fn(),
    onRequestRemove: vi.fn(),
    onViewGguf: vi.fn(),
    onOpenHf: vi.fn(),
    pulling: null,
    done: new Set<string>(),
    errors: new Map<string, string>(),
    confirmDelete: null,
    ...extra,
  };
  return { container, root, props };
}

describe("HuggingFaceLibraryView", () => {
  let originalFetch: typeof fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("renders sidebar + toolbar skeleton on first mount, then cards once fetch resolves", async () => {
    const { calls } = mockFetch();
    const { container, root, props } = mountView();
    await act(async () => {
      root.render(<HuggingFaceLibraryView {...props} />);
    });
    // Toolbar + sidebar are present immediately.
    expect(
      container.querySelector('[data-testid="hfl-sidebar"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="model-search"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="hfl-sort"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    await flush();
    // After settle, the five cards render and skeletons disappear.
    const cards = container.querySelectorAll('[data-testid="hf-model-card"]');
    expect(cards.length).toBe(SAMPLE_MODELS.length);
    expect(container.querySelector('[data-testid="hfl-skeleton"]')).toBeNull();
    // Initial fetch URL is to the HF /api/models endpoint.
    expect(calls.some((u) => u.includes("/api/models?"))).toBe(true);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("library filter pill flows into the HF `filter=…` URL param", async () => {
    const { calls } = mockFetch();
    const { container, root, props } = mountView();
    await act(async () => {
      root.render(<HuggingFaceLibraryView {...props} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    const initialLen = calls.length;
    // Click the MLX pill in the Libraries section.
    const mlxPill = container.querySelector(
      '[data-testid="hfl-pill-mlx"]',
    ) as HTMLButtonElement;
    expect(mlxPill).not.toBeNull();
    await act(async () => {
      mlxPill.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    expect(calls.length).toBeGreaterThan(initialLen);
    const last = calls[calls.length - 1];
    expect(last).toContain("filter=mlx");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("sort dropdown change re-fetches with the right sort param", async () => {
    const { calls } = mockFetch();
    const { container, root, props } = mountView();
    await act(async () => {
      root.render(<HuggingFaceLibraryView {...props} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    const before = calls.length;
    const sortSel = container.querySelector(
      '[data-testid="hfl-sort"]',
    ) as HTMLSelectElement;
    await act(async () => {
      sortSel.value = "downloads";
      sortSel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    expect(calls.length).toBeGreaterThan(before);
    const last = calls[calls.length - 1];
    expect(last).toContain("sort=downloads");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("inference toggle adds inference=warm to the URL", async () => {
    const { calls } = mockFetch();
    const { container, root, props } = mountView();
    await act(async () => {
      root.render(<HuggingFaceLibraryView {...props} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    const before = calls.length;
    const toggle = container.querySelector(
      '[data-testid="hfl-inference-toggle"]',
    ) as HTMLInputElement;
    await act(async () => {
      toggle.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    expect(calls.length).toBeGreaterThan(before);
    expect(calls[calls.length - 1]).toContain("inference=warm");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("clicking a GGUF repo card hits onViewGguf, MLX card hits onPull", async () => {
    mockFetch();
    const onPull = vi.fn();
    const onViewGguf = vi.fn();
    const { container, root, props } = mountView({ onPull, onViewGguf });
    await act(async () => {
      root.render(<HuggingFaceLibraryView {...props} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();

    const mlxBtn = container.querySelector(
      '[data-testid="hfl-action-mlx-community/Llama-3.2-3B-Instruct"]',
    ) as HTMLButtonElement;
    const ggufBtn = container.querySelector(
      '[data-testid="hfl-action-bartowski/Mistral-7B-Instruct-GGUF"]',
    ) as HTMLButtonElement;
    expect(mlxBtn?.textContent).toContain("Pull");
    expect(ggufBtn?.textContent).toContain("View files");
    await act(async () => {
      mlxBtn.click();
    });
    await act(async () => {
      ggufBtn.click();
    });
    expect(onPull).toHaveBeenCalledWith("mlx-community/Llama-3.2-3B-Instruct");
    expect(onViewGguf).toHaveBeenCalledWith(
      "bartowski/Mistral-7B-Instruct-GGUF",
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("ggufMode renders the View files expander instead of Pull and locks the GGUF library chip on", async () => {
    const { calls } = mockFetch();
    const onExpandRepo = vi.fn();
    const ggufContext: React.ComponentProps<
      typeof HuggingFaceLibraryView
    >["ggufContext"] = {
      installed: [],
      trees: new Map(),
      downloads: new Set<string>(),
      progress: new Map(),
      errors: new Map<string, string>(),
      confirmDelete: null,
      deleting: null,
      onExpandRepo,
      onCollapseRepo: vi.fn(),
      onDownloadFile: vi.fn(),
      onDeleteFile: vi.fn(),
    };
    const { container, root, props } = mountView({
      ggufMode: true,
      ggufContext,
    });
    await act(async () => {
      root.render(<HuggingFaceLibraryView {...props} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    await flush();

    // The initial fetch should have filter=gguf locked on by the ggufMode
    // path (initialLibraries defaults to ["gguf"]).
    expect(calls.some((u) => u.includes("filter=gguf"))).toBe(true);

    // The GGUF pill in the Libraries section should be marked selected.
    const ggufPill = container.querySelector(
      '[data-testid="hfl-pill-gguf"]',
    ) as HTMLButtonElement;
    expect(ggufPill).not.toBeNull();
    expect(ggufPill.getAttribute("aria-pressed")).toBe("true");

    // For a repo carrying the gguf tag (bartowski/...-GGUF), the action
    // button label is "View files ▾" instead of "Pull".
    const ggufBtn = container.querySelector(
      '[data-testid="hfl-action-bartowski/Mistral-7B-Instruct-GGUF"]',
    ) as HTMLButtonElement;
    expect(ggufBtn).not.toBeNull();
    expect(ggufBtn.textContent).toContain("View files");
    expect(ggufBtn.textContent).not.toContain("Pull");

    // Clicking the View files button asks the parent to expand the repo;
    // the parent owns the tree map so the call routes through ggufContext.
    await act(async () => {
      ggufBtn.click();
    });
    expect(onExpandRepo).toHaveBeenCalledWith(
      "bartowski/Mistral-7B-Instruct-GGUF",
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
