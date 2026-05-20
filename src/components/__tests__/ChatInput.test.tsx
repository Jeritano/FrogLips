import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// happy-dom's localStorage is read-only in this pinned version; install a
// Map-backed shim before the component pulls in prompt-templates.
const storeMap = new Map<string, string>();
const fakeStorage: Storage = {
  get length() { return storeMap.size; },
  clear: () => { storeMap.clear(); },
  getItem: (k: string) => (storeMap.has(k) ? (storeMap.get(k) as string) : null),
  setItem: (k: string, v: string) => { storeMap.set(k, String(v)); },
  removeItem: (k: string) => { storeMap.delete(k); },
  key: (i: number) => Array.from(storeMap.keys())[i] ?? null,
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: fakeStorage,
});

import { ChatInput } from "../ChatInput";

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
  onSend: ReturnType<typeof vi.fn>;
}

async function mount(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSend = vi.fn();
  await act(async () => {
    root.render(<ChatInput onSend={onSend} />);
  });
  await flush();
  return { container, root, onSend };
}

async function teardown(h: Harness) {
  await act(async () => { h.root.unmount(); });
  h.container.remove();
}

function getTextarea(h: Harness): HTMLTextAreaElement {
  return h.container.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement;
}

async function typeInto(h: Harness, value: string) {
  const ta = getTextarea(h);
  // React intercepts the value setter to track changes; bypass it so the
  // synthetic "input" event we dispatch carries the new value through React.
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    if (setter) setter.call(ta, value); else ta.value = value;
    ta.selectionStart = value.length;
    ta.selectionEnd = value.length;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

function clearStorage() {
  storeMap.clear();
}

describe("ChatInput slash autocomplete", () => {
  beforeEach(() => {
    clearStorage();
  });
  afterEach(() => {
    clearStorage();
    document.body.innerHTML = "";
  });

  it("shows the explain template when the user types /expl", async () => {
    const h = await mount();
    await typeInto(h, "/expl");

    const menu = h.container.querySelector('[data-testid="prompt-autocomplete"]');
    expect(menu).not.toBeNull();
    const option = h.container.querySelector('[data-testid="prompt-option-explain"]');
    expect(option).not.toBeNull();
    expect(option?.textContent).toContain("explain");

    await teardown(h);
  });

  it("Escape dismisses the dropdown without sending", async () => {
    const h = await mount();
    await typeInto(h, "/expl");
    expect(h.container.querySelector('[data-testid="prompt-autocomplete"]')).not.toBeNull();

    const ta = getTextarea(h);
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();

    expect(h.container.querySelector('[data-testid="prompt-autocomplete"]')).toBeNull();
    expect(h.onSend).not.toHaveBeenCalled();

    await teardown(h);
  });

  it("Enter on a match expands the template and replaces the slash query", async () => {
    const h = await mount();
    await typeInto(h, "/summ");

    const ta = getTextarea(h);
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    // Template body for `summarize` starts with "Summarize the conversation".
    expect(ta.value.startsWith("Summarize the conversation")).toBe(true);
    // Menu is dismissed.
    expect(h.container.querySelector('[data-testid="prompt-autocomplete"]')).toBeNull();
    // Send wasn't fired by the expansion-Enter.
    expect(h.onSend).not.toHaveBeenCalled();

    await teardown(h);
  });

  it("plain Enter without an open menu still sends the message", async () => {
    const h = await mount();
    await typeInto(h, "hello world");
    const ta = getTextarea(h);
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    expect(h.onSend).toHaveBeenCalledTimes(1);
    expect(h.onSend.mock.calls[0][0]).toBe("hello world");

    await teardown(h);
  });
});
