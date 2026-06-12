import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Capture event listeners that QuickPrompt registers so we can replay
// streamed chunks deterministically. Use vi.hoisted so these are
// initialized before the vi.mock factories execute (which themselves
// are hoisted to top-of-file).
type Handler = (e: { payload: unknown }) => void;
const { handlers, invokeMock, listenMock } = vi.hoisted(() => {
  const handlers: Record<string, Handler> = {};
  const invokeMock = vi.fn(async () => undefined);
  const listenMock = vi.fn(async (name: string, fn: Handler) => {
    handlers[name] = fn;
    return () => {
      delete handlers[name];
    };
  });
  return { handlers, invokeMock, listenMock };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { QuickPrompt } from "../QuickPrompt";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Harness {
  container: HTMLElement;
  root: Root;
}

async function mount(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QuickPrompt />);
  });
  await flush();
  return { container, root };
}

describe("QuickPrompt", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    listenMock.mockClear();
    for (const k of Object.keys(handlers)) delete handlers[k];
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an autofocused textarea and a disabled Send button", async () => {
    const { container, root } = await mount();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    const btn = container.querySelector(".quick-send") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });

  it("submits prompt on Enter and streams chunks into the reply panel", async () => {
    const { container, root } = await mount();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;

    // React's synthetic event system tracks the value via a hidden setter
    // installed on the DOM property descriptor. Bypassing it (ta.value = "x")
    // makes React think there was no change. Set via the native setter so
    // React's onChange fires correctly.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(ta, "hello");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flush();

    expect(invokeMock).toHaveBeenCalledWith(
      "quick_prompt_submit",
      expect.objectContaining({ text: "hello" }),
    );

    // Find the event channel name the component registered for.
    const channel = Object.keys(handlers).find((n) =>
      n.startsWith("quick-prompt-response:"),
    );
    expect(channel).toBeDefined();
    await act(async () => {
      handlers[channel!]({
        payload: { op_id: "x", delta: "hi ", done: false, error: null },
      });
      handlers[channel!]({
        payload: { op_id: "x", delta: "there", done: false, error: null },
      });
      handlers[channel!]({
        payload: { op_id: "x", delta: "", done: true, error: null },
      });
    });
    await flush();

    const reply = container.querySelector(
      '[data-testid="quick-reply"]',
    ) as HTMLElement;
    expect(reply.textContent).toContain("hi there");

    await act(async () => {
      root.unmount();
    });
  });

  it("invokes quick_prompt_hide on Escape", async () => {
    const { root } = await mount();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("quick_prompt_hide");
    await act(async () => {
      root.unmount();
    });
  });
});
