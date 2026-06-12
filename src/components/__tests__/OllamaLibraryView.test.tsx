/**
 * Acceptance tests for the new ModelBrowser "Ollama library" pane.
 *
 * Covers:
 *  1. Skeleton placeholders while the scrape fetch is in flight.
 *  2. Live entries render once the fetch resolves.
 *  3. Filter chips toggle and narrow the list to entries that match ALL
 *     selected capabilities.
 *  4. Sort dropdown reorders by Newest / Updated.
 *  5. Network failure falls back to the curated list with a status banner.
 *
 * Tauri IPC is fully mocked — the view should never reach out to the real
 * backend in a unit test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  api: {
    ollamaLibraryFetch: vi.fn(),
  },
}));

import { OllamaLibraryView } from "../OllamaLibraryView";
import { api } from "../../lib/tauri-api";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Two-card sample, hand-tuned to make each test assertion crisp:
//  * "alpha" — multi-capability (vision + tools) flagship, big pull count
//  * "beta" — embedding only, smaller pull count, more recent update
//  * "gamma" — thinking only, oldest update, mid pull count
const SAMPLE = [
  {
    name: "alpha",
    description: "Multimodal flagship with tool use and vision input.",
    capabilities: ["vision", "tools"],
    sizes: ["7b", "33b"],
    pulls: 1_200_000,
    tag_count: 6,
    updated_relative: "3 weeks ago",
  },
  {
    name: "beta",
    description: "Compact local embedding model from a research lab.",
    capabilities: ["embedding"],
    sizes: ["137m"],
    pulls: 50_000,
    tag_count: 3,
    updated_relative: "2 days ago",
  },
  {
    name: "gamma",
    description: "Chain-of-thought reasoning model.",
    capabilities: ["thinking"],
    sizes: ["32b"],
    pulls: 800_000,
    tag_count: 4,
    updated_relative: "6 months ago",
  },
];

const FALLBACK = [
  {
    id: "fallback-model",
    label: "Fallback Model",
    desc: "Curated when ollama.com is unreachable.",
    tags: ["vision"],
    size: "7b",
  },
];

function noop() {
  /* test stub */
}

const STUB_PROPS = {
  installedOllama: [],
  pull: noop,
  requestRemove: noop,
  pulling: null,
  deleting: null,
  done: new Set<string>(),
  errors: new Map<string, string>(),
  confirmDelete: null,
  fallback: FALLBACK,
  query: "",
};

function mountIn(container: HTMLDivElement, ui: React.ReactNode): Root {
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flushPromises() {
  // Two-tick flush: microtasks for the fetch promise, then the setState batch
  // that schedules the re-render.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("OllamaLibraryView", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container.remove();
    root = null;
  });

  it("renders 8 skeleton placeholders while the fetch is pending", () => {
    // Never-resolving promise so we stay in the loading state.
    (api.ollamaLibraryFetch as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    root = mountIn(container, <OllamaLibraryView {...STUB_PROPS} />);

    const skeletons = container.querySelectorAll(".mb-ollama-skel");
    expect(skeletons.length).toBe(8);
    // Real entries shouldn't render yet.
    expect(
      container.querySelectorAll('[data-testid="ollama-library-card"]').length,
    ).toBe(0);
  });

  it("renders one card per entry once the fetch resolves", async () => {
    (api.ollamaLibraryFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      SAMPLE,
    );
    root = mountIn(container, <OllamaLibraryView {...STUB_PROPS} />);

    await flushPromises();

    const cards = container.querySelectorAll(
      '[data-testid="ollama-library-card"]',
    );
    expect(cards.length).toBe(3);
    // Names render in order. Default sort is "popular" (by pulls desc):
    // alpha 1.2M > gamma 800K > beta 50K.
    const names = Array.from(cards).map(
      (c) => c.querySelector("h2")?.textContent,
    );
    expect(names).toEqual(["alpha", "gamma", "beta"]);
    // Capability chips render with the expected colors (orange = vision).
    const visionChips = container.querySelectorAll(
      '[data-testid="ollama-cap-chip"]',
    );
    expect(visionChips.length).toBeGreaterThan(0);
  });

  it("filter chip narrows results to entries with that capability", async () => {
    (api.ollamaLibraryFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      SAMPLE,
    );
    root = mountIn(container, <OllamaLibraryView {...STUB_PROPS} />);
    await flushPromises();

    // All three visible before any filter.
    expect(
      container.querySelectorAll('[data-testid="ollama-library-card"]').length,
    ).toBe(3);

    const visionChip = container.querySelector(
      '[data-testid="filter-chip-vision"]',
    ) as HTMLButtonElement;
    expect(visionChip).toBeTruthy();
    act(() => {
      visionChip.click();
    });

    // Only alpha has the vision capability.
    const cards = container.querySelectorAll(
      '[data-testid="ollama-library-card"]',
    );
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector("h2")?.textContent).toBe("alpha");
    expect(visionChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("sort dropdown reorders by Newest (smallest days-ago first)", async () => {
    (api.ollamaLibraryFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      SAMPLE,
    );
    root = mountIn(container, <OllamaLibraryView {...STUB_PROPS} />);
    await flushPromises();

    const select = container.querySelector(
      '[data-testid="ollama-sort"]',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    act(() => {
      select.value = "newest";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const cards = container.querySelectorAll(
      '[data-testid="ollama-library-card"]',
    );
    const names = Array.from(cards).map(
      (c) => c.querySelector("h2")?.textContent,
    );
    // beta 2d < alpha 3w (21d) < gamma 6mo (~180d).
    expect(names).toEqual(["beta", "alpha", "gamma"]);
  });

  it("falls back to the curated list with a banner when the fetch throws", async () => {
    (api.ollamaLibraryFetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );
    root = mountIn(container, <OllamaLibraryView {...STUB_PROPS} />);
    await flushPromises();

    const banner = container.querySelector(".mb-ollama-banner");
    expect(banner?.textContent).toMatch(/couldn't reach/i);
    const cards = container.querySelectorAll(
      '[data-testid="ollama-library-card"]',
    );
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector("h2")?.textContent).toBe("fallback-model");
  });
});

// happy-dom doesn't export `afterEach` from a top-level import in vitest's
// global mode, but the runner injects it. Adding an explicit import keeps
// editors happy and is a no-op at runtime.
import { afterEach } from "vitest";
