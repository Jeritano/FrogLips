/**
 * Acceptance tests for the curated, RAM-aware Catalog tab.
 *
 * Covers:
 *  1. Entries render grouped by size tier with a one-click Install button.
 *  2. RAM-fit badges reflect the detected machine (won't-fit on a small Mac,
 *     fits on a big one) — the SAME classify() the picker/wizard use.
 *  3. Clicking Install calls the parent's pull() with the entry id.
 *  4. An installed entry shows Remove instead of Install.
 *  5. The "Fits my Mac" toggle hides models that won't fit.
 *
 * tauri-api is mocked — the presentational view never touches real IPC.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../lib/tauri-api", () => ({
  api: {},
}));

import { CatalogTab } from "../CatalogTab";
import type { CatalogEntry } from "../catalog";
import type { ModelEntry } from "../../../types";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG: CatalogEntry[] = [
  {
    id: "tiny:1b",
    label: "Tiny 1B",
    size: "1 GB",
    tags: ["chat"],
    desc: "A tiny chat model.",
  },
  {
    id: "huge:70b",
    label: "Huge 70B",
    size: "43 GB",
    tags: ["chat"],
    desc: "A huge chat model.",
  },
  {
    id: "kimi-k2:cloud",
    label: "Kimi Cloud",
    size: "cloud",
    tags: ["cloud", "reasoning"],
    desc: "A hosted cloud model.",
  },
];

function mountIn(container: HTMLDivElement, ui: React.ReactNode): Root {
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function baseProps() {
  return {
    catalog: CATALOG,
    installedOllama: [] as ModelEntry[],
    machine: { total_ram_gb: 16 },
    query: "",
    pull: vi.fn(),
    requestRemove: vi.fn(),
    pulling: null,
    pullProgress: null,
    deleting: null,
    done: new Set<string>(),
    errors: new Map<string, string>(),
    confirmDelete: null,
  };
}

describe("CatalogTab", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  function cleanup() {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
  }

  it("renders entries grouped by size tier with an install button", () => {
    root = mountIn(container, <CatalogTab {...baseProps()} />);
    expect(container.querySelector('[data-testid="catalog-card-tiny:1b"]')).not
      .toBeNull();
    expect(container.querySelector('[data-testid="catalog-card-huge:70b"]')).not
      .toBeNull();
    // One-click install affordance present for a non-installed entry.
    expect(
      container.querySelector('[data-testid="catalog-install-tiny:1b"]'),
    ).not.toBeNull();
    // Size tier section headers exist.
    expect(container.querySelector('[data-testid="catalog-tier-small"]')).not
      .toBeNull();
    expect(container.querySelector('[data-testid="catalog-tier-large"]')).not
      .toBeNull();
    cleanup();
  });

  it("badges fit using the shared classifier (won't-fit on a small Mac)", () => {
    root = mountIn(container, <CatalogTab {...baseProps()} />);
    const tinyFit = container.querySelector(
      '[data-testid="catalog-fit-tiny:1b"]',
    );
    const hugeFit = container.querySelector(
      '[data-testid="catalog-fit-huge:70b"]',
    );
    // 1 GB on a 16 GB Mac → comfortable; 43 GB → won't fit.
    expect(tinyFit?.getAttribute("data-tier")).toBe("comfortable");
    expect(hugeFit?.getAttribute("data-tier")).toBe("impossible");
    expect(hugeFit?.textContent).toContain("Won't fit");
    // Cloud entry gets NO RAM badge (no honest verdict).
    expect(container.querySelector('[data-testid="catalog-fit-kimi-k2:cloud"]'))
      .toBeNull();
    cleanup();
  });

  it("the same big model fits on a big Mac", () => {
    root = mountIn(
      container,
      <CatalogTab {...baseProps()} machine={{ total_ram_gb: 128 }} />,
    );
    const hugeFit = container.querySelector(
      '[data-testid="catalog-fit-huge:70b"]',
    );
    expect(hugeFit?.getAttribute("data-tier")).toBe("comfortable");
    cleanup();
  });

  it("clicking install calls pull() with the entry id", () => {
    const props = baseProps();
    root = mountIn(container, <CatalogTab {...props} />);
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="catalog-install-tiny:1b"]',
    );
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(props.pull).toHaveBeenCalledWith("tiny:1b");
    cleanup();
  });

  it("shows Remove for an installed model", () => {
    const props = baseProps();
    props.installedOllama = [
      { id: "tiny:1b", size_bytes: 1e9, backend: "ollama" },
    ];
    root = mountIn(container, <CatalogTab {...props} />);
    const card = container.querySelector(
      '[data-testid="catalog-card-tiny:1b"]',
    );
    expect(card?.textContent).toContain("Remove");
    // No install button on an installed row.
    expect(
      container.querySelector('[data-testid="catalog-install-tiny:1b"]'),
    ).toBeNull();
    cleanup();
  });

  it("'Fits my Mac' toggle hides models that won't fit", () => {
    const props = baseProps();
    root = mountIn(container, <CatalogTab {...props} />);
    const toggle = container.querySelector<HTMLInputElement>(
      '[data-testid="catalog-fits-only"]',
    );
    act(() =>
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    // huge:70b won't fit on 16 GB → dropped; tiny:1b + cloud stay.
    expect(container.querySelector('[data-testid="catalog-card-huge:70b"]'))
      .toBeNull();
    expect(container.querySelector('[data-testid="catalog-card-tiny:1b"]')).not
      .toBeNull();
    expect(
      container.querySelector('[data-testid="catalog-card-kimi-k2:cloud"]'),
    ).not.toBeNull();
    cleanup();
  });
});
