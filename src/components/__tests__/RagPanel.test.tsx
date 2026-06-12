import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => {
  return {
    api: {
      ragListCorpora: vi.fn(async () => [
        {
          id: 1,
          name: "demo-proj",
          root_path: "/tmp/demo",
          chunk_count: 42,
          created_at: Math.floor(Date.now() / 1000) - 100,
          updated_at: Math.floor(Date.now() / 1000) - 10,
        },
      ]),
      ragIngestFolder: vi.fn(async () => ({
        corpus_id: 2,
        files_seen: 5,
        files_indexed: 5,
        chunks_created: 12,
        total_bytes: 1024,
        duration_ms: 7,
      })),
      ragSearch: vi.fn(async () => [
        {
          path: "x.ts",
          snippet: "hit",
          score: 0.9,
          start_byte: 0,
          end_byte: 3,
        },
      ]),
      ragDeleteCorpus: vi.fn(async () => undefined),
    },
  };
});

import { RagPanel } from "../RagPanel";

async function flush() {
  // Let useEffect + microtasks settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RagPanel", () => {
  it("renders the panel header and ingest controls", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<RagPanel />);
    });
    await flush();

    expect(container.textContent).toContain("Project knowledge");
    // Ingest button is present
    const ingestBtn = container.querySelector(
      '[data-testid="rag-ingest"]',
    ) as HTMLButtonElement | null;
    expect(ingestBtn).not.toBeNull();
    expect(ingestBtn?.disabled).toBe(true); // empty inputs → disabled

    // After listing, mocked corpus appears
    expect(container.textContent).toContain("demo-proj");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("calls ragSearch when search button is clicked", async () => {
    const { api } = await import("../../lib/tauri-api");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<RagPanel />);
    });
    await flush();

    // Set corpus + query via DOM
    const select = container.querySelector("select") as HTMLSelectElement;
    const query = container.querySelector(
      '[data-testid="rag-query"]',
    ) as HTMLInputElement;
    const btn = container.querySelector(
      '[data-testid="rag-search-btn"]',
    ) as HTMLButtonElement;

    expect(select).toBeTruthy();
    expect(query).toBeTruthy();
    expect(btn).toBeTruthy();

    await act(async () => {
      // Fire onChange via native setter so React picks it up.
      const setNativeValue = (
        el: HTMLInputElement | HTMLSelectElement,
        v: string,
      ) => {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        desc?.set?.call(el, v);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setNativeValue(select, "demo-proj");
      setNativeValue(query, "hello");
    });
    await flush();

    await act(async () => {
      btn.click();
    });
    await flush();

    expect(api.ragSearch).toHaveBeenCalledWith("demo-proj", "hello", 5);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
