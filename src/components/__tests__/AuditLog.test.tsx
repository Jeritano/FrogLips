import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentAuditRow, AgentAuditStats } from "../../types";

/*
 * AuditLog is the user-facing record of what the agent actually did. Two of its
 * behaviors are security-relevant and pinned here:
 *  - a `dry_run` outcome must read "dry-run" (a suppressed side-effect), not be
 *    silently shown as a normal "ok" — that distinction is the whole point of
 *    dry-run mode.
 *  - purge must reject a < 1 day window locally (no destructive call fired).
 */

const apiMocks = vi.hoisted(() => ({
  agentAuditList: vi.fn<() => Promise<AgentAuditRow[]>>(async () => []),
  agentAuditStats: vi.fn<() => Promise<AgentAuditStats>>(async () => ({
    total_calls_24h: 0,
    error_calls_24h: 0,
    error_rate_24h: 0,
    top_tools_24h: [],
    avg_duration_ms_24h: [],
  })),
  agentAuditPurge: vi.fn(async () => 0),
}));
vi.mock("../../lib/tauri-api", () => ({ api: apiMocks }));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { AuditLog } from "../AuditLog";

function row(over: Partial<AgentAuditRow>): AgentAuditRow {
  return {
    id: 1,
    ts: 1_700_000_000_000,
    conversation_id: "c1",
    tool_name: "run_shell",
    args_json: "{}",
    result_hash: "h",
    result_size: 0,
    duration_ms: 5,
    approval: "auto",
    outcome: "ok",
    error_kind: null,
    workflow_run_id: null,
    ...over,
  };
}

describe("AuditLog", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function mountOpen() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AuditLog />);
    });
    // Click the toggle to open; the open-effect then fires the async refresh.
    const toggle = container.querySelector(".audit-log-toggle") as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("renders a dry_run outcome as 'dry-run', not 'ok'", async () => {
    apiMocks.agentAuditList.mockResolvedValue([
      row({ outcome: "dry_run", tool_name: "write_file" }),
    ]);
    await mountOpen();
    const cell = container.querySelector(
      ".audit-outcome-dryrun",
    ) as HTMLElement;
    expect(cell).toBeTruthy();
    expect(cell.textContent).toContain("dry-run");
    expect(cell.getAttribute("title")).toMatch(/suppressed by dry-run/i);
  });

  it("flags a denied outcome with the denied class", async () => {
    apiMocks.agentAuditList.mockResolvedValue([row({ outcome: "denied" })]);
    await mountOpen();
    expect(container.querySelector(".audit-outcome-denied")).toBeTruthy();
  });

  it("appends error_kind to the outcome cell", async () => {
    apiMocks.agentAuditList.mockResolvedValue([
      row({ outcome: "error", error_kind: "timeout" }),
    ]);
    await mountOpen();
    expect(container.textContent).toContain("error:timeout");
  });

  it("rejects a purge window < 1 day without calling the backend", async () => {
    await mountOpen();
    const dayInput = container.querySelector(
      ".audit-input-days",
    ) as HTMLInputElement;
    // React tracks the value via a prototype setter; assign through it so the
    // synthetic onChange actually fires and component state updates to 0.
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue?.call(dayInput, "0");
      dayInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const purgeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Purge",
    ) as HTMLButtonElement;
    await act(async () => {
      purgeBtn.click();
    });
    expect(apiMocks.agentAuditPurge).not.toHaveBeenCalled();
    expect(container.querySelector(".audit-log-err")?.textContent).toMatch(
      /days must be/i,
    );
  });

  it("shows an empty-state row when there are no audit entries", async () => {
    apiMocks.agentAuditList.mockResolvedValue([]);
    await mountOpen();
    expect(container.querySelector(".audit-log-empty")?.textContent).toContain(
      "No audit rows.",
    );
  });
});
