import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Memory } from "../../types";

/* Mock the Tauri API so the panel renders against fixed data without hitting
   the IPC bridge. The fixture covers all three scopes so the badges and
   filter chips can be exercised in a single render. */
const fixtures: Memory[] = [
  {
    id: 1,
    content: "remembers across all chats",
    conversation_id: null,
    source_msg_id: null,
    tags: "",
    status: "active",
    created_at: 1,
    last_used_at: null,
    scope: "global",
    project_root: null,
  },
  {
    id: 2,
    content: "lives in /tmp/proj",
    conversation_id: null,
    source_msg_id: null,
    tags: "",
    status: "active",
    created_at: 2,
    last_used_at: null,
    scope: "project",
    project_root: "/tmp/proj",
  },
  {
    id: 3,
    content: "only in this chat",
    conversation_id: 42,
    source_msg_id: null,
    tags: "",
    status: "active",
    created_at: 3,
    last_used_at: null,
    scope: "conversation",
    project_root: null,
  },
];

vi.mock("../../lib/tauri-api", () => {
  return {
    api: {
      listMemories: vi.fn(async (status?: string) =>
        status === "pending" ? [] : fixtures,
      ),
      deleteMemory: vi.fn(async () => undefined),
      updateMemoryStatus: vi.fn(async () => undefined),
      memoryPromote: vi.fn(async () => undefined),
      memoryDemote: vi.fn(async () => undefined),
      memorySetContext: vi.fn(async () => undefined),
      addMemory: vi.fn(async () => 99),
      findDuplicateMemory: vi.fn(async () => null),
      touchMemory: vi.fn(async () => undefined),
    },
  };
});

// memory-client.saveMemory calls embed() which talks to Ollama; stub it.
// Also stub getMemoryMode/setMemoryMode so we don't depend on localStorage
// being present in the test environment.
vi.mock("../../lib/memory-client", async (orig) => {
  const real = await (orig() as Promise<
    typeof import("../../lib/memory-client")
  >);
  return {
    ...real,
    embed: vi.fn(async () => null),
    getMemoryMode: vi.fn(() => "manual"),
    setMemoryMode: vi.fn(),
  };
});

// React 19's act warning is benign here — we wrap state updates in act
// already, but a few microtask awaits trip the dev guard. Mark the env.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { MemoryPanel } from "../MemoryPanel";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openPanel(container: HTMLElement) {
  const toggle = container.querySelector(
    '[data-testid="memories-toggle"]',
  ) as HTMLButtonElement;
  await act(async () => {
    toggle.click();
  });
  await flush();
}

describe("MemoryPanel scope UI", () => {
  it("renders a scope badge for each memory and filter chips for every scope", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryPanel workspaceRoot="/tmp/proj" conversationId={42} />,
      );
    });
    await flush();
    await openPanel(container);

    // Filter chips exist for All + each scope.
    for (const s of ["all", "global", "project", "conversation"]) {
      const chip = container.querySelector(`[data-testid="scope-chip-${s}"]`);
      expect(chip, `chip-${s} missing`).not.toBeNull();
    }

    // Every fixture row gets a badge with the correct letter.
    const badge1 = container.querySelector('[data-testid="scope-badge-1"]');
    const badge2 = container.querySelector('[data-testid="scope-badge-2"]');
    const badge3 = container.querySelector('[data-testid="scope-badge-3"]');
    expect(badge1?.textContent).toBe("G");
    expect(badge2?.textContent).toBe("P");
    expect(badge3?.textContent).toBe("C");

    // Clicking the "project" chip filters the list down to just the project row.
    const projectChip = container.querySelector(
      '[data-testid="scope-chip-project"]',
    ) as HTMLButtonElement;
    await act(async () => {
      projectChip.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="memory-item-1"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="memory-item-2"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="memory-item-3"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("invokes memoryPromote when the up button is clicked on a conversation memory", async () => {
    const { api } = await import("../../lib/tauri-api");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryPanel workspaceRoot="/tmp/proj" conversationId={42} />,
      );
    });
    await flush();
    await openPanel(container);

    // The conversation row (id=3) has both up + delete buttons; pick the up
    // button via aria-label so we're not coupled to button ordering.
    const row3 = container.querySelector(
      '[data-testid="memory-item-3"]',
    ) as HTMLElement;
    expect(row3).not.toBeNull();
    const upBtn = row3.querySelector(
      'button[aria-label="Promote memory"]',
    ) as HTMLButtonElement;
    expect(upBtn).not.toBeNull();
    expect(upBtn.disabled).toBe(false);

    await act(async () => {
      upBtn.click();
    });
    await flush();

    // Conversation → project requires a project_root binding when missing —
    // the panel auto-supplies the current workspace before promoting.
    expect(api.memorySetContext).toHaveBeenCalledWith(3, "/tmp/proj", null);
    expect(api.memoryPromote).toHaveBeenCalledWith(3);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
