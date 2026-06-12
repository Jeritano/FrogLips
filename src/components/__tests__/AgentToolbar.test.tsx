import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// AgentToolbar's undo button hits the agent-undo IPC on mount; stub the two
// calls it uses so the component renders without a Tauri runtime.
const { agentListUndoMock } = vi.hoisted(() => ({
  agentListUndoMock: vi.fn(async () => [] as { path: string; kind: string }[]),
}));
vi.mock("../../lib/tauri-api", () => ({
  api: {
    agentListUndo: agentListUndoMock,
    agentUndoLast: vi.fn(async () => undefined),
  },
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { AgentToolbar } from "../AgentToolbar";
import type { AgentSettings } from "../../hooks/useAgentSettings";
import type { AgentMetrics, AgentStatus } from "../../lib/agent-loop";
import type { Message } from "../../types";

const agentStub: AgentSettings = {
  allowlist: [],
  resetAllowlist: () => {},
  toggleAllowed: () => {},
  dryRun: false,
  setDryRun: () => {},
  approveAllShell: false,
  setApproveAllShell: () => {},
  approveAllWrite: false,
  setApproveAllWrite: () => {},
  approvedShellPrefixes: [],
  setApprovedShellPrefixes: () => {},
  presets: [
    {
      id: "default",
      name: "Default",
      description: "",
      allowedTools: [],
      builtIn: true,
    },
  ],
  activePresetId: "default",
  activePreset: undefined,
  selectPreset: () => {},
};

type ToolbarProps = Parameters<typeof AgentToolbar>[0];

function makeProps(over: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    conversation: null,
    messages: [],
    agent: agentStub,
    agentMode: true,
    agentAvailable: true,
    agentStatus: "idle" as AgentStatus,
    agentMetrics: null,
    activeModel: null,
    isWorking: false,
    workspaceRoot: null,
    projectPolicy: null,
    convParams: {
      temperature: null,
      top_p: null,
      max_tokens: null,
      system_prompt: null,
    },
    showParamsPanel: false,
    showAgentSettings: false,
    showExportMenu: false,
    onToggleAgent: () => {},
    onToggleParams: () => {},
    onToggleAgentSettings: () => {},
    onToggleToolHistory: () => {},
    onToggleExportMenu: () => {},
    onCloseExportMenu: () => {},
    ...over,
  };
}

/** Assistant turn carrying tool calls — what the runner pushes via onUpdate
 *  right before flipping status to "tool". */
function asstWithCalls(...names: string[]): Message {
  return {
    conversation_id: 1,
    role: "assistant",
    content: "",
    tool_calls: names.map((n, i) => ({
      id: `c${i}`,
      type: "function" as const,
      function: { name: n, arguments: {} },
    })),
  };
}

/** Settled tool result row appended after each call finishes. */
function toolResult(name: string, id: string): Message {
  return {
    conversation_id: 1,
    role: "tool",
    content: '{"ok":true}',
    tool_call_id: id,
    tool_name: name,
  };
}

function makeMetrics(over: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    iterations: 3,
    toolCalls: 7,
    totalToolMs: 1200,
    totalLlmMs: 3400,
    retries: 0,
    promptTokens: 100,
    completionTokens: 50,
    toolStats: {
      read_file: { count: 5, totalMs: 800, errors: 0 },
      run_shell: { count: 2, totalMs: 400, errors: 1 },
    },
    ...over,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Harness {
  container: HTMLElement;
  root: Root;
  rerender: (props: ToolbarProps) => Promise<void>;
}

async function mount(props: ToolbarProps): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AgentToolbar {...props} />);
  });
  await flush();
  return {
    container,
    root,
    rerender: async (p) => {
      await act(async () => {
        root.render(<AgentToolbar {...p} />);
      });
      await flush();
    },
  };
}

function pill(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="agent-run-pill"]');
}

describe("AgentToolbar run-status pill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentListUndoMock.mockClear();
    // Coach hint dismissal — keep the toolbar quiet in tests. (When the
    // environment has no localStorage the component defaults to "seen".)
    globalThis.localStorage?.setItem("agent.coachSeen", "true");
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders no pill while idle", async () => {
    const { container } = await mount(makeProps({ agentStatus: "idle" }));
    expect(pill(container)).toBeNull();
  });

  it("shows the executing tool name, iter N/40 and a 00:00 clock", async () => {
    const { container } = await mount(
      makeProps({
        agentStatus: "tool",
        agentMetrics: makeMetrics(),
        messages: [asstWithCalls("read_file", "run_shell")],
      }),
    );
    const el = pill(container);
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("read_file");
    expect(el!.textContent).toContain("iter 3/40");
    expect(el!.textContent).toContain("00:00");
  });

  it("advances to the next call once a tool result settles", async () => {
    const props = makeProps({
      agentStatus: "tool",
      agentMetrics: makeMetrics(),
      messages: [asstWithCalls("read_file", "run_shell")],
    });
    const h = await mount(props);
    await h.rerender({
      ...props,
      messages: [
        asstWithCalls("read_file", "run_shell"),
        toolResult("read_file", "c0"),
      ],
    });
    expect(pill(h.container)!.textContent).toContain("run_shell");
  });

  it("falls back to 'Running tool…' when no tool-call turn is in the tail", async () => {
    const { container } = await mount(
      makeProps({ agentStatus: "tool", messages: [] }),
    );
    expect(pill(container)!.textContent).toContain("Running tool…");
    // No metrics yet → no iter segment.
    expect(pill(container)!.textContent).not.toContain("iter");
  });

  it("shows 'Thinking…' between tool turns", async () => {
    const { container } = await mount(
      makeProps({
        agentStatus: "thinking",
        agentMetrics: makeMetrics({ iterations: 12 }),
      }),
    );
    expect(pill(container)!.textContent).toContain("Thinking…");
    expect(pill(container)!.textContent).toContain("iter 12/40");
  });

  it("ticks the elapsed clock once a second and freezes it on done", async () => {
    const props = makeProps({
      agentStatus: "tool",
      agentMetrics: makeMetrics(),
      messages: [asstWithCalls("read_file")],
    });
    const h = await mount(props);
    await act(async () => {
      vi.advanceTimersByTime(65_000);
    });
    expect(pill(h.container)!.textContent).toContain("01:05");

    // Run ends — interval is cleaned up, clock stops advancing.
    await h.rerender({ ...props, agentStatus: "done" });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(pill(h.container)!.textContent).toContain("Done");
    expect(pill(h.container)!.textContent).toContain("01:05");
  });

  it("lists per-tool call counts in the hover tooltip, busiest first", async () => {
    const { container } = await mount(
      makeProps({
        agentStatus: "tool",
        agentMetrics: makeMetrics(),
        messages: [asstWithCalls("read_file")],
      }),
    );
    const title = pill(container)!.getAttribute("title") ?? "";
    expect(title).toContain("Tool calls this run:");
    expect(title).toContain("read_file ×5");
    expect(title).toContain("run_shell ×2 (1 err)");
    expect(title.indexOf("read_file")).toBeLessThan(title.indexOf("run_shell"));
  });

  it("shows a placeholder tooltip before the first tool call lands", async () => {
    const { container } = await mount(
      makeProps({
        agentStatus: "thinking",
        agentMetrics: makeMetrics({ toolStats: {} }),
      }),
    );
    expect(pill(container)!.getAttribute("title")).toBe(
      "No tool calls yet this run",
    );
  });
});
