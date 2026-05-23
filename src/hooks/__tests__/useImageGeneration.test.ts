import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, useEffect } from "react";

type Handler = (e: { payload: unknown }) => void;
const { listenMock, handlers, unlistenSpy, imageGenerateMock } = vi.hoisted(() => {
  const handlers: Record<string, Handler[]> = {};
  const unlistenSpy = vi.fn();
  const listenMock = vi.fn(async (name: string, fn: Handler) => {
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(fn);
    const off = () => {
      unlistenSpy(name);
      handlers[name] = (handlers[name] || []).filter((h) => h !== fn);
    };
    return off;
  });
  const imageGenerateMock = vi.fn(
    async (
      _prompt: string,
      _model: string,
      _opts: unknown,
      _convId: number | null,
      _opId: string,
    ) => 0,
  );
  return { listenMock, handlers, unlistenSpy, imageGenerateMock };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../../lib/tauri-api", () => ({
  api: {
    imageGenerate: (
      prompt: string,
      model: string,
      opts: unknown,
      convId: number | null,
      opId: string,
    ) => imageGenerateMock(prompt, model, opts, convId, opId),
    imageCancel: vi.fn(async () => undefined),
  },
}));
vi.mock("../../lib/diagnostics", () => ({ logDiag: vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { useImageGeneration, type ImageGenProgress } from "../useImageGeneration";

interface Harness {
  container: HTMLElement;
  root: Root;
  progressRef: { current: ImageGenProgress };
  generate: ReturnType<typeof useImageGeneration>["generate"];
  runningRef: { current: boolean };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function HookProbe({
  onReady,
}: {
  onReady: (r: ReturnType<typeof useImageGeneration>) => void;
}) {
  const result = useImageGeneration();
  // Push every render to the harness so tests can observe progress / running.
  useEffect(() => { onReady(result); });
  return null;
}

async function mount(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const progressRef = { current: { phase: "idle" } as ImageGenProgress };
  const runningRef = { current: false };
  let generateCap: ReturnType<typeof useImageGeneration>["generate"] | null = null;
  const onReady = (r: ReturnType<typeof useImageGeneration>) => {
    progressRef.current = r.progress;
    runningRef.current = r.running;
    if (!generateCap) generateCap = r.generate;
  };
  await act(async () => {
    root.render(createElement(HookProbe, { onReady }));
  });
  await flush();
  if (!generateCap) throw new Error("generate fn never captured");
  return { container, root, progressRef, runningRef, generate: generateCap };
}

async function teardown(h: Harness) {
  await act(async () => { h.root.unmount(); });
  h.container.remove();
}

describe("useImageGeneration", () => {
  let h: Harness | undefined;

  beforeEach(() => {
    for (const k of Object.keys(handlers)) handlers[k] = [];
    listenMock.mockClear();
    unlistenSpy.mockClear();
    imageGenerateMock.mockClear();
    imageGenerateMock.mockResolvedValue(0);
  });

  afterEach(async () => {
    if (h) await teardown(h);
    h = undefined;
  });

  it("registers all three listeners BEFORE imageGenerate is called (H3)", async () => {
    let imageGenerateCalledAfter: string[] | null = null;
    imageGenerateMock.mockImplementation(async () => {
      // Snapshot the listener-registration calls observed up to this point.
      imageGenerateCalledAfter = listenMock.mock.calls.map((c) => c[0] as string);
      return 0;
    });
    h = await mount();
    void h.generate({ prompt: "p", model: "schnell", opts: {}, convId: null }).catch(() => {});
    await flush();
    // imageGenerate must see all three listeners already registered.
    expect(imageGenerateCalledAfter).toContain("image-progress");
    expect(imageGenerateCalledAfter).toContain("image-done");
    expect(imageGenerateCalledAfter).toContain("image-error");
  });

  it("treats a Loading-shaped progress event as 'loading', not sampling (M8)", async () => {
    h = await mount();
    const donePromise = h.generate({ prompt: "p", model: "schnell", opts: {}, convId: null });
    donePromise.catch(() => {});
    await flush();
    // Fire a Loading-shaped event: step:0, total:0, stage:"warmup". Old code
    // misclassified this as sampling because it checked `step` first.
    const onProgress = handlers["image-progress"]?.[0];
    expect(onProgress).toBeTruthy();
    await act(async () => {
      onProgress!({ payload: { op_id: getOpIdFromCalls(), step: 0, total: 0, stage: "warmup" } });
    });
    await flush();
    expect(h.progressRef.current.phase).toBe("loading");
    expect(h.progressRef.current.stage).toBe("warmup");
    // Now an honest sampling event (no stage) → sampling.
    await act(async () => {
      onProgress!({ payload: { op_id: getOpIdFromCalls(), step: 1, total: 4 } });
    });
    await flush();
    expect(h.progressRef.current.phase).toBe("sampling");
    expect(h.progressRef.current.step).toBe(1);
    expect(h.progressRef.current.total).toBe(4);
    // Wrap up so the promise doesn't dangle.
    const onDone = handlers["image-done"]?.[0];
    await act(async () => { onDone!({ payload: { op_id: getOpIdFromCalls(), image_id: 7 } }); });
    await flush();
    await donePromise;
  });

  it("releases all listeners when the hook unmounts mid-generate (M4)", async () => {
    h = await mount();
    // Kick off a generate that never resolves (imageGenerate hangs).
    imageGenerateMock.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );
    void h.generate({ prompt: "p", model: "schnell", opts: {}, convId: null }).catch(() => {});
    await flush();
    expect(handlers["image-progress"]?.length ?? 0).toBeGreaterThan(0);
    expect(handlers["image-done"]?.length ?? 0).toBeGreaterThan(0);
    expect(handlers["image-error"]?.length ?? 0).toBeGreaterThan(0);
    const before = unlistenSpy.mock.calls.length;
    await teardown(h);
    h = undefined;
    // On unmount, all three unlisten handles must have fired.
    const after = unlistenSpy.mock.calls.length;
    expect(after - before).toBeGreaterThanOrEqual(3);
  });
});

/** Pull the op_id from the most recent imageGenerate invocation. */
function getOpIdFromCalls(): string {
  const last = imageGenerateMock.mock.calls[imageGenerateMock.mock.calls.length - 1];
  // Args: (prompt, model, opts, convId, opId)
  return String(last?.[4] ?? "");
}
