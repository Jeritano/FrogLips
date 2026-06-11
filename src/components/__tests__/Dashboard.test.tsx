import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardSummary } from "../../types";

/* Mock the Tauri API so the dashboard renders against a fixed empty/non-empty
   summary without hitting the IPC bridge. */
const emptySummary: DashboardSummary = {
  window_since_ts: 0,
  window_until_ts: 0,
  tool_counts: [],
  tool_latency: [],
  approval_counts: [],
  session_metrics: [],
  total_prompt_tokens: 0,
  total_completion_tokens: 0,
};

const populatedSummary: DashboardSummary = {
  window_since_ts: 0,
  window_until_ts: 0,
  tool_counts: [
    { tool_name: "read_file", count: 12 },
    { tool_name: "run_shell", count: 4 },
  ],
  tool_latency: [
    {
      tool_name: "read_file",
      count: 12,
      avg_ms: 23.5,
      p50_ms: 21,
      p95_ms: 60,
      max_ms: 90,
    },
    {
      tool_name: "run_shell",
      count: 4,
      avg_ms: 410,
      p50_ms: 300,
      p95_ms: 900,
      max_ms: 1200,
    },
  ],
  approval_counts: [
    { approval: "auto", count: 10 },
    { approval: "user_allowed", count: 3 },
    { approval: "denied", count: 1 },
  ],
  session_metrics: [
    {
      id: 1,
      ts: 1_700_000_000_000,
      conversation_id: "1",
      iterations: 4,
      tool_calls: 3,
      total_tool_ms: 1000,
      total_llm_ms: 2000,
      prompt_tokens: 800,
      completion_tokens: 200,
    },
    {
      id: 2,
      ts: 1_700_000_900_000,
      conversation_id: "1",
      iterations: 7,
      tool_calls: 6,
      total_tool_ms: 1800,
      total_llm_ms: 3500,
      prompt_tokens: 1100,
      completion_tokens: 450,
    },
  ],
  total_prompt_tokens: 1900,
  total_completion_tokens: 650,
};

let summaryToReturn: DashboardSummary = emptySummary;

vi.mock("../../lib/tauri-api", () => {
  return {
    api: {
      agentDashboardSummary: vi.fn(async () => summaryToReturn),
      modelPerfSummary: vi.fn(async () => []),
    },
  };
});

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { Dashboard } from "../Dashboard";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Dashboard", () => {
  it("does not render when closed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Dashboard open={false} onClose={() => {}} />);
    });
    // No dashboard root present.
    expect(container.querySelector('[data-testid="dashboard"]')).toBeNull();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders without crashing on empty data", async () => {
    summaryToReturn = emptySummary;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Dashboard open={true} onClose={() => {}} />);
    });
    await flush();

    // Dashboard root is mounted.
    expect(container.querySelector('[data-testid="dashboard"]')).not.toBeNull();
    // Each of the 5 sections is present.
    expect(
      container.querySelector('[data-testid="dashboard-tool-counts"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="dashboard-latency"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="dashboard-iterations"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="dashboard-throughput"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="dashboard-approvals"]'),
    ).not.toBeNull();
    // No-data sentinel appears in each empty section.
    const emptyMsgs = container.querySelectorAll(".dashboard-empty");
    expect(emptyMsgs.length).toBeGreaterThan(0);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders populated data without crashing", async () => {
    summaryToReturn = populatedSummary;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Dashboard open={true} onClose={() => {}} />);
    });
    await flush();

    // Tool count bars rendered.
    const bars = container.querySelectorAll(".dashboard-bar-row");
    expect(bars.length).toBe(2);
    // Latency table has both rows.
    const latencyRows = container.querySelectorAll(
      '[data-testid="dashboard-latency"] tbody tr',
    );
    expect(latencyRows.length).toBe(2);
    // Approval pie legend has three entries.
    const pieItems = container.querySelectorAll(".dashboard-pie-legend li");
    expect(pieItems.length).toBe(3);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
