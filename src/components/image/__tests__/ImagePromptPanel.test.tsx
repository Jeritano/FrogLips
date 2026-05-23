import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── Module stubs (must precede the SUT import) ─────────────────────────────
// The panel feature-detects `api.imageUnload`. Stub the whole tauri-api module
// so the import is a no-op in happy-dom; tests that need imageUnload reassign
// `(api as any).imageUnload = …` after mount.
vi.mock("../../../lib/tauri-api", () => ({
  api: {},
}));

import { ImagePromptPanel } from "../ImagePromptPanel";
import { api } from "../../../lib/tauri-api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Harness {
  container: HTMLElement;
  root: Root;
  onGenerate: ReturnType<typeof vi.fn>;
}

async function mount(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onGenerate = vi.fn();
  await act(async () => {
    root.render(
      <ImagePromptPanel
        onGenerate={onGenerate}
        running={false}
        progress={{ phase: "idle" }}
        error={null}
      />,
    );
  });
  await flush();
  return { container, root, onGenerate };
}

async function teardown(h: Harness) {
  await act(async () => { h.root.unmount(); });
  h.container.remove();
}

describe("ImagePromptPanel", () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await teardown(h);
    // Reset any feature-detection mutations between tests.
    delete (api as Record<string, unknown>).imageUnload;
  });

  it("renders the prompt textarea + Generate button", async () => {
    h = await mount();
    const ta = h.container.querySelector('[data-testid="image-prompt-textarea"]');
    const gen = h.container.querySelector('[data-testid="image-generate-btn"]');
    expect(ta).toBeTruthy();
    expect(gen).toBeTruthy();
  });

  it("disables Generate when the prompt is empty", async () => {
    h = await mount();
    const gen = h.container.querySelector<HTMLButtonElement>('[data-testid="image-generate-btn"]');
    expect(gen).toBeTruthy();
    expect(gen?.disabled).toBe(true);
    await act(async () => { gen?.click(); });
    expect(h.onGenerate).not.toHaveBeenCalled();
  });

  it("enables Generate once the prompt has non-whitespace content", async () => {
    h = await mount();
    const ta = h.container.querySelector<HTMLTextAreaElement>('[data-testid="image-prompt-textarea"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "a serene mountain landscape");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const gen = h.container.querySelector<HTMLButtonElement>('[data-testid="image-generate-btn"]');
    expect(gen?.disabled).toBe(false);
    await act(async () => { gen?.click(); });
    expect(h.onGenerate).toHaveBeenCalledTimes(1);
    const arg = h.onGenerate.mock.calls[0][0];
    expect(arg.prompt).toBe("a serene mountain landscape");
    expect(arg.model).toBe("schnell");
    expect(arg.opts.size).toBe("1024x1024");
    expect(arg.opts.offload).toBe(false);
    // U1: steps/cfg/seed inputs no longer exist — opts pass them as null so
    // Rust falls through to the model defaults.
    expect(arg.opts.steps).toBeNull();
    expect(arg.opts.cfg).toBeNull();
    expect(arg.opts.seed).toBeNull();
  });

  it("does not render an Advanced disclosure (U1)", async () => {
    h = await mount();
    const toggle = h.container.querySelector(".image-advanced-toggle");
    expect(toggle).toBeNull();
    const stepsInput = h.container.querySelector('input[aria-label="Sampling steps"]');
    expect(stepsInput).toBeNull();
    const seedInput = h.container.querySelector('input[aria-label="Seed"]');
    expect(seedInput).toBeNull();
  });

  it("renders the static hint line (U1)", async () => {
    h = await mount();
    const hint = h.container.querySelector('[data-testid="image-prompt-hint"]');
    expect(hint).toBeTruthy();
    expect(hint?.textContent ?? "").toContain("Schnell uses 4 steps");
    expect(hint?.textContent ?? "").toContain("Dev uses 28");
  });

  it("offers all FLUX variants in the model dropdown (F1)", async () => {
    h = await mount();
    const select = h.container.querySelector<HTMLSelectElement>('[data-testid="image-model-select"]')!;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual([
      "schnell",
      "dev",
      "schnell-fp8",
      "dev-fp8",
      "schnell-gguf-q4",
      "dev-gguf-q4",
    ]);
  });

  it("does not render a Cancel button (H4)", async () => {
    h = await mount();
    // Re-render with running=true to assert no Cancel even while busy.
    const onGen = h.onGenerate as unknown as (a: { prompt: string; model: string; opts: import("../../../types").ImageGenOpts }) => void;
    await act(async () => {
      h.root.render(
        <ImagePromptPanel
          onGenerate={onGen}
          running={true}
          progress={{ phase: "loading" }}
          error={null}
        />,
      );
    });
    await flush();
    const cancel = h.container.querySelector('[data-testid="image-cancel-btn"]');
    expect(cancel).toBeNull();
    // Loading note appears in its place.
    const note = h.container.querySelector(".image-loading-note");
    expect(note?.textContent ?? "").toContain("First run");
  });

  it("hides the Unload button until api.imageUnload exists (U6)", async () => {
    h = await mount();
    expect(h.container.querySelector('[data-testid="image-unload-btn"]')).toBeNull();
  });

  it("shows the Unload button when api.imageUnload is available (U6)", async () => {
    (api as Record<string, unknown>).imageUnload = vi.fn(async () => undefined);
    h = await mount();
    const btn = h.container.querySelector('[data-testid="image-unload-btn"]');
    expect(btn).toBeTruthy();
  });
});
