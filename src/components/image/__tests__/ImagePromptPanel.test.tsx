import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ImagePromptPanel } from "../ImagePromptPanel";

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
  onCancel: ReturnType<typeof vi.fn>;
}

async function mount(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onGenerate = vi.fn();
  const onCancel = vi.fn();
  await act(async () => {
    root.render(
      <ImagePromptPanel
        onGenerate={onGenerate}
        onCancel={onCancel}
        running={false}
        progress={{ phase: "idle" }}
        error={null}
      />,
    );
  });
  await flush();
  return { container, root, onGenerate, onCancel };
}

async function teardown(h: Harness) {
  await act(async () => { h.root.unmount(); });
  h.container.remove();
}

describe("ImagePromptPanel", () => {
  let h: Harness;
  afterEach(async () => { if (h) await teardown(h); });

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
    // Clicking the disabled button must not invoke the callback.
    await act(async () => { gen?.click(); });
    expect(h.onGenerate).not.toHaveBeenCalled();
  });

  it("enables Generate once the prompt has non-whitespace content", async () => {
    h = await mount();
    const ta = h.container.querySelector<HTMLTextAreaElement>('[data-testid="image-prompt-textarea"]')!;
    await act(async () => {
      // Mirror React's controlled-input event dispatch — setter + native input event.
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
  });
});
