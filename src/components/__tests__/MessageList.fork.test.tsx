import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Message } from "../../types";

// memory-client.saveMemory talks to embeddings + the IPC bridge; stub it so
// the PinControl side of the row doesn't try to hit network/Tauri in tests.
vi.mock("../../lib/memory-client", async (orig) => {
  const real = await (orig() as Promise<
    typeof import("../../lib/memory-client")
  >);
  return {
    ...real,
    saveMemory: vi.fn(async () => undefined),
    embed: vi.fn(async () => null),
  };
});

import { MessageList } from "../MessageList";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  container: HTMLElement;
  root: Root;
  onFork: ReturnType<typeof vi.fn>;
}

const USER_MSG: Message = {
  id: 42,
  conversation_id: 7,
  role: "user",
  content: "what is the meaning of life?",
  created_at: 1,
};

async function mount(
  opts: { onFork?: Harness["onFork"]; conversationId?: number | null } = {},
): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onFork = opts.onFork ?? vi.fn();
  await act(async () => {
    root.render(
      <MessageList
        messages={[USER_MSG]}
        conversationId={
          opts.conversationId === undefined ? 7 : opts.conversationId
        }
        onFork={onFork as unknown as (m: Message) => void}
      />,
    );
  });
  // Flush microtasks so any post-mount effects settle.
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root, onFork };
}

async function teardown(h: Harness) {
  await act(async () => {
    h.root.unmount();
  });
  h.container.remove();
}

describe("MessageList fork-from-here button", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a fork button on a persisted user message", async () => {
    const h = await mount();
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="fork-btn"]',
    );
    expect(btn).not.toBeNull();
    expect(btn?.textContent ?? "").toContain("Fork");
    await teardown(h);
  });

  it("arms on first click without dispatching onFork", async () => {
    // First click should only flip the button into its armed state — fork
    // must not fire until the second click confirms.
    const onFork = vi.fn();
    const h = await mount({ onFork });
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="fork-btn"]',
    );
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(onFork).not.toHaveBeenCalled();
    const armedBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="fork-btn"]',
    );
    expect(armedBtn?.textContent ?? "").toContain("Click again to confirm");
    await teardown(h);
  });

  it("dispatches onFork with the message on the second click", async () => {
    const onFork = vi.fn();
    const h = await mount({ onFork });
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="fork-btn"]',
    );
    expect(btn).not.toBeNull();
    // First click arms.
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(onFork).not.toHaveBeenCalled();
    // Second click within the window fires.
    await act(async () => {
      const armed = h.container.querySelector<HTMLButtonElement>(
        '[data-testid="fork-btn"]',
      );
      armed!.click();
      await Promise.resolve();
    });
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(onFork.mock.calls[0][0]).toMatchObject({ id: 42, role: "user" });
    await teardown(h);
  });

  it("does not render the fork button when there is no conversation id", async () => {
    const h = await mount({ conversationId: null });
    const btn = h.container.querySelector('[data-testid="fork-btn"]');
    expect(btn).toBeNull();
    await teardown(h);
  });
});
