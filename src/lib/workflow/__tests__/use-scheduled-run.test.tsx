import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the Tauri listener the hook registers so we can replay a
// `workflow-trigger` event, and spy on the run-control `start`. Hoisted so the
// vi.mock factories below close over the same instances.
const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: { payload: unknown }) => void>,
  start: vi.fn(
    (_args: {
      workflowId: number;
      opts: { scheduled?: boolean; startCardId?: string };
    }) => true,
  ),
  workflowGet: vi.fn(),
  startServer: vi.fn(async () => undefined),
  parseWorkflow: vi.fn(),
  resolveLinearOrder: vi.fn(),
  runningWorkflowId: null as number | null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, fn: (e: { payload: unknown }) => void) => {
      h.handlers[name] = fn;
      return () => {
        delete h.handlers[name];
      };
    },
  ),
}));
vi.mock("../../tauri-api", () => ({
  api: { workflowGet: h.workflowGet, startServer: h.startServer },
}));
vi.mock("../run-context", () => ({
  useWorkflowRunControl: () => ({
    runningWorkflowId: h.runningWorkflowId,
    start: h.start,
    lastSummary: null,
    stop: vi.fn(),
    stopCard: vi.fn(),
    clearSummary: vi.fn(),
  }),
}));
vi.mock("../../../contexts/SettingsContext", () => ({
  useSettingsGetter: () => async () => ({ user_profile: null }),
}));
vi.mock("../graph", () => ({ resolveLinearOrder: h.resolveLinearOrder }));
vi.mock("../../../types", async (orig) => ({
  ...(await orig<typeof import("../../../types")>()),
  parseWorkflow: h.parseWorkflow,
}));

import { ScheduledWorkflowRunner } from "../use-scheduled-run";

const STATUS = { model: "llama", backend: "ollama", running: true } as never;

function card(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Brief",
    model: "llama",
    backend: "ollama",
    needsReview: false,
    ...over,
  };
}

function seed(cards: ReturnType<typeof card>[]) {
  h.workflowGet.mockResolvedValue({ id: 1, name: "Test", graph_json: "{}" });
  h.parseWorkflow.mockReturnValue({
    id: 1,
    name: "Test",
    graph: { cards, edges: [] },
    created_at: 0,
    updated_at: 0,
  });
  h.resolveLinearOrder.mockReturnValue(cards);
}

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ScheduledWorkflowRunner status={STATUS} />);
    // flush the effect that registers the listener (listen() is async)
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function fireTrigger() {
  await act(async () => {
    h.handlers["workflow-trigger"]?.({
      payload: { workflow_id: 1, card_id: "c1" },
    });
    // let the handler's async IIFE settle: workflowGet → parse → start
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ScheduledWorkflowRunner (app-level workflow-trigger listener)", () => {
  beforeEach(() => {
    for (const k of Object.keys(h.handlers)) delete h.handlers[k];
    h.start.mockClear();
    h.workflowGet.mockReset();
    h.parseWorkflow.mockReset();
    h.resolveLinearOrder.mockReset();
    h.runningWorkflowId = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("registers the workflow-trigger listener at app scope", async () => {
    await mount();
    expect(h.handlers["workflow-trigger"]).toBeDefined();
  });

  it("starts a scheduled run when a due flow fires (any view open)", async () => {
    seed([card()]);
    await mount();
    await fireTrigger();
    expect(h.start).toHaveBeenCalledTimes(1);
    const arg = h.start.mock.calls[0]?.[0];
    expect(arg?.workflowId).toBe(1);
    expect(arg?.opts.scheduled).toBe(true);
    expect(arg?.opts.startCardId).toBe("c1");
  });

  it("refuses to auto-run an unreviewed (un-armed) flow", async () => {
    seed([card({ needsReview: true })]);
    await mount();
    await fireTrigger();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("ignores a trigger while another run is already in progress", async () => {
    h.runningWorkflowId = 7;
    seed([card()]);
    await mount();
    await fireTrigger();
    expect(h.start).not.toHaveBeenCalled();
  });
});
