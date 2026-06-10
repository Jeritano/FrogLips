import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CommandPalette,
  fuzzyMatch,
  type PaletteAction,
} from "../CommandPalette";
import type { Conversation } from "../../types";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("fuzzyMatch", () => {
  it("matches case-insensitive subsequences", () => {
    expect(fuzzyMatch("gtf", "Go to Flows")).toBe(true);
    expect(fuzzyMatch("FLOWS", "go to flows")).toBe(true);
    expect(fuzzyMatch("", "anything")).toBe(true);
    expect(fuzzyMatch("xyz", "Go to Flows")).toBe(false);
    // Order matters for a subsequence.
    expect(fuzzyMatch("wolf", "flows")).toBe(false);
  });
});

describe("CommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function conv(id: number, title: string): Conversation {
    return { id, title, created_at: 0 } as Conversation;
  }

  function mount(over: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const actions: PaletteAction[] = [
      { id: "a1", label: "Go to Flows", run: vi.fn() },
      { id: "a2", label: "New chat", run: vi.fn() },
    ];
    const props = {
      open: true,
      onClose: vi.fn(),
      actions,
      conversations: [
        conv(1, "SurfaceWatch planning"),
        conv(2, "Recipe ideas"),
      ],
      onOpenConversation: vi.fn(),
      ...over,
    };
    act(() => {
      root.render(<CommandPalette {...props} />);
    });
    return props;
  }

  function type(text: string) {
    const input = container.querySelector(
      '[data-testid="command-palette-input"]',
    ) as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setValue?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  it("renders nothing when closed", () => {
    mount({ open: false });
    expect(
      container.querySelector('[data-testid="command-palette"]'),
    ).toBeNull();
  });

  it("shows the action registry on empty query, no conversations", () => {
    mount();
    const rows = container.querySelectorAll(".cmdk-row");
    expect(rows.length).toBe(2);
    expect(container.textContent).not.toContain("SurfaceWatch");
  });

  it("typing filters actions and surfaces matching conversations", () => {
    mount();
    type("surface");
    expect(container.textContent).toContain("SurfaceWatch planning");
    expect(container.textContent).not.toContain("Recipe ideas");
  });

  it("Enter runs the selected action and closes", () => {
    const props = mount();
    const input = type("flows");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(props.actions[0].run).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes without running anything", () => {
    const props = mount();
    const input = container.querySelector(
      '[data-testid="command-palette-input"]',
    ) as HTMLInputElement;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.actions[0].run).not.toHaveBeenCalled();
  });

  it("clicking a conversation row opens it", () => {
    const props = mount();
    type("recipe");
    const row = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cmdk-row"),
    ).find((b) => b.textContent?.includes("Recipe ideas"));
    expect(row).toBeTruthy();
    act(() => row!.click());
    expect(props.onOpenConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
    );
  });
});
