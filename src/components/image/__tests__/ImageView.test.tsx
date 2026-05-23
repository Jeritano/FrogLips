import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageMeta } from "../../../types";

// ── Module stubs (hoisted) ─────────────────────────────────────────────────
//
// We mock `tauri-api` fully so `api.imageList` returns whatever the test sets,
// and we stub the @tauri-apps/api/event `listen` so we can drive the global
// `image-done` listener that ImageView registers (U4).

type Handler = (e: { payload: unknown }) => void;
const { listenMock, handlers, imageListMock, imageDeleteMock } = vi.hoisted(() => {
  const handlers: Record<string, Handler[]> = {};
  const listenMock = vi.fn(async (name: string, fn: Handler) => {
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(fn);
    return () => {
      handlers[name] = (handlers[name] || []).filter((h) => h !== fn);
    };
  });
  const imageListMock = vi.fn(async (_convId: number | null, _limit?: number) => [] as ImageMeta[]);
  const imageDeleteMock = vi.fn(async (_id: number) => undefined);
  return { listenMock, handlers, imageListMock, imageDeleteMock };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../../../lib/tauri-api", () => ({
  api: {
    imageList: (convId: number | null, limit?: number) => imageListMock(convId, limit),
    imageDelete: (id: number) => imageDeleteMock(id),
    imageGet: vi.fn(async () => null),
    imageGenerate: vi.fn(async () => 0),
    imageCancel: vi.fn(async () => undefined),
  },
}));
vi.mock("../../../lib/diagnostics", () => ({
  logDiag: vi.fn(),
}));
vi.mock("../../../lib/announce", () => ({
  announce: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ImageView } from "../../ImageView";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeImage(over: Partial<ImageMeta> = {}): ImageMeta {
  return {
    id: 1,
    conv_id: null,
    model: "schnell",
    prompt: "sample",
    params_json: "{}",
    path: "/tmp/img.png",
    width: 1024,
    height: 1024,
    seed: 42,
    created_at: 1700000000,
    ...over,
  };
}

interface Harness {
  container: HTMLElement;
  root: Root;
  onSendToChat: ReturnType<typeof vi.fn>;
}

async function mount(convId: number | null = null): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSendToChat = vi.fn();
  await act(async () => {
    root.render(<ImageView conversationId={convId} onSendToChat={onSendToChat} />);
  });
  await flush();
  return { container, root, onSendToChat };
}

async function teardown(h: Harness) {
  await act(async () => { h.root.unmount(); });
  h.container.remove();
}

describe("ImageView", () => {
  let h: Harness;

  beforeEach(() => {
    for (const k of Object.keys(handlers)) handlers[k] = [];
    listenMock.mockClear();
    imageListMock.mockClear();
    imageDeleteMock.mockClear();
    imageListMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (h) await teardown(h);
  });

  it("renders the three filter chip buttons", async () => {
    h = await mount();
    expect(h.container.querySelector('[data-testid="image-filter-all"]')).toBeTruthy();
    expect(h.container.querySelector('[data-testid="image-filter-this-chat"]')).toBeTruthy();
    expect(h.container.querySelector('[data-testid="image-filter-standalone"]')).toBeTruthy();
  });

  it("defaults to 'this-chat' when a conversation is selected", async () => {
    h = await mount(5);
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="image-filter-this-chat"]',
    );
    expect(btn?.getAttribute("aria-pressed")).toBe("true");
    // First refresh after mount should query with convId=5.
    expect(imageListMock).toHaveBeenCalled();
    const calls = imageListMock.mock.calls;
    expect(calls.some((c) => c[0] === 5)).toBe(true);
  });

  it("defaults to 'all' when no conversation is selected and disables This chat", async () => {
    h = await mount(null);
    const all = h.container.querySelector<HTMLButtonElement>('[data-testid="image-filter-all"]');
    const thisChat = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="image-filter-this-chat"]',
    );
    expect(all?.getAttribute("aria-pressed")).toBe("true");
    expect(thisChat?.disabled).toBe(true);
  });

  it("filters to standalone client-side when chip flips to 'standalone' (U3)", async () => {
    const images: ImageMeta[] = [
      makeImage({ id: 1, conv_id: null }),
      makeImage({ id: 2, conv_id: 9 }),
      makeImage({ id: 3, conv_id: null }),
    ];
    imageListMock.mockResolvedValue(images);
    h = await mount(null);
    await act(async () => {
      const btn = h.container.querySelector<HTMLButtonElement>(
        '[data-testid="image-filter-standalone"]',
      );
      btn?.click();
    });
    await flush();
    // Strip should only contain conv_id=null images (ids 1 and 3).
    const tiles = h.container.querySelectorAll('[data-testid="image-gallery-tile"]');
    expect(tiles.length).toBe(2);
  });

  it("refreshes the gallery when a global image-done event fires (U4)", async () => {
    imageListMock.mockResolvedValueOnce([]); // initial load (empty)
    h = await mount(null);
    // After mount, useTauriEvent has registered an `image-done` handler.
    const onDones = handlers["image-done"] ?? [];
    expect(onDones.length).toBeGreaterThan(0);
    // Subsequent refresh after the event should return one row.
    imageListMock.mockResolvedValue([makeImage({ id: 99, conv_id: null, prompt: "agent-driven" })]);
    await act(async () => {
      onDones[0]({ payload: { op_id: "x", image_id: 99 } });
    });
    await flush();
    const tile = h.container.querySelector('[data-testid="image-gallery-tile"]');
    expect(tile).toBeTruthy();
  });
});
