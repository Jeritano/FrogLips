/**
 * SkillsPanel tests.
 *
 * Mocks the Tauri API per the existing pattern (`mcp-dispatch.test.ts`,
 * `MemoryPanel.test.tsx`): `vi.mock("../../../lib/tauri-api", …)` returns
 * a stub `api` object with just the surface this panel touches. Each test
 * file maintains its own fixture set so a refactor of one panel doesn't
 * silently change another's expectations.
 *
 * The "feature-detection" test is intentionally placed in a SEPARATE
 * describe block with its own vi.mock setup — the panel checks
 * `"workflowSkillList" in api`, so we need a module-scope mock that
 * lacks those keys for that case. We achieve that with two test files
 * here actually folded into one via vi.doMock + dynamic import to keep
 * the file count low. See the `unsupported` block below.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SkillSummary, SkillFull } from "../../../types";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fixtures: SkillSummary[] = [
  {
    id: 1,
    name: "summarize_docs",
    description:
      "Read every markdown file in docs/ and produce a one-paragraph synopsis. Lives across runs of this workflow so the agent doesn't have to re-discover the layout.",
    last_used_at: Date.now() - 5 * 60 * 1000, // 5m ago
    invocation_count: 7,
  },
  {
    id: 2,
    name: "lint_then_test",
    description:
      "Run npm lint and npm test sequentially, surfacing any failures.",
    last_used_at: null,
    invocation_count: 0,
  },
];

const fullFixture: SkillFull = {
  id: 1,
  workflow_id: 99,
  name: "summarize_docs",
  description: fixtures[0].description,
  last_used_at: fixtures[0].last_used_at,
  invocation_count: fixtures[0].invocation_count,
  steps_json: JSON.stringify([
    { tool: "agent_list_dir", args: { path: "docs/" } },
    { tool: "agent_read_file", args: { path: "docs/README.md" } },
  ]),
  created_at: Date.now() - 60 * 60 * 1000,
};

vi.mock("../../../lib/tauri-api", () => {
  return {
    api: {
      workflowSkillList: vi.fn(async () => fixtures),
      workflowSkillGet: vi.fn(async () => fullFixture),
      workflowSkillDelete: vi.fn(async () => undefined),
    },
  };
});

// diagnostics.logDiag pulls in IPC indirectly via appendDiagLog. Stub it
// so the panel's catch-paths don't fail when the api stub doesn't expose
// `appendDiagLog`.
vi.mock("../../../lib/diagnostics", () => ({
  logDiag: vi.fn(),
}));

import { SkillsPanel } from "../SkillsPanel";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Harness {
  container: HTMLElement;
  root: Root;
  cleanup: () => Promise<void>;
}

async function mount(
  props: Partial<Parameters<typeof SkillsPanel>[0]> = {},
): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = props.onClose ?? vi.fn();
  await act(async () => {
    root.render(
      <SkillsPanel
        workflowId={props.workflowId ?? 99}
        workflowName={props.workflowName ?? "Test Workflow"}
        open={props.open ?? true}
        onClose={onClose}
      />,
    );
  });
  await flush();
  return {
    container,
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("SkillsPanel", () => {
  beforeEach(async () => {
    const { api } = await import("../../../lib/tauri-api");
    (api.workflowSkillList as ReturnType<typeof vi.fn>).mockClear();
    (api.workflowSkillList as ReturnType<typeof vi.fn>).mockResolvedValue(
      fixtures,
    );
    (api.workflowSkillGet as ReturnType<typeof vi.fn>).mockClear();
    (api.workflowSkillGet as ReturnType<typeof vi.fn>).mockResolvedValue(
      fullFixture,
    );
    (api.workflowSkillDelete as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    // No global state — but make sure act warnings reset between tests.
    vi.clearAllTimers();
  });

  it("renders the empty state when the workflow has no skills", async () => {
    const { api } = await import("../../../lib/tauri-api");
    (api.workflowSkillList as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      [],
    );

    const h = await mount();

    const empty = h.container.querySelector(
      '[data-testid="skills-panel-empty"]',
    );
    expect(empty).not.toBeNull();
    // Exact copy from the spec.
    expect(empty?.textContent).toContain("No skills saved");
    expect(empty?.textContent).toContain("workflow_save_skill");

    await h.cleanup();
  });

  it("renders all rows with correct name and invocation count", async () => {
    const h = await mount();
    const table = h.container.querySelector('[data-testid="skills-table"]');
    expect(table).not.toBeNull();

    const row1 = h.container.querySelector(
      '[data-testid="skills-row-summarize_docs"]',
    ) as HTMLElement;
    const row2 = h.container.querySelector(
      '[data-testid="skills-row-lint_then_test"]',
    ) as HTMLElement;
    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();

    // Name cell renders the skill name; invocation count cell renders the integer.
    expect(row1.textContent).toContain("summarize_docs");
    expect(row1.textContent).toContain("7");
    expect(row2.textContent).toContain("lint_then_test");
    expect(row2.textContent).toContain("0");
    // Never-used skill shows the "Never" placeholder for last_used_at.
    expect(row2.textContent).toContain("Never");

    await h.cleanup();
  });

  it("reveals pretty-printed steps when [View steps] is clicked", async () => {
    const h = await mount();
    const { api } = await import("../../../lib/tauri-api");

    const viewBtn = h.container.querySelector(
      '[data-testid="skills-view-summarize_docs"]',
    ) as HTMLButtonElement;
    expect(viewBtn).not.toBeNull();
    await act(async () => {
      viewBtn.click();
    });
    await flush();

    // workflowSkillGet was called with workflowId + name.
    expect(api.workflowSkillGet).toHaveBeenCalledWith(99, "summarize_docs");

    const body = h.container.querySelector('[data-testid="skills-steps-body"]');
    expect(body).not.toBeNull();
    // Pretty-printing produces newlines + indentation; the raw fixture was
    // a single-line JSON string, so post-format we expect at least one
    // newline between the array elements.
    expect(body?.textContent).toContain("\n");
    expect(body?.textContent).toContain("agent_list_dir");
    expect(body?.textContent).toContain("agent_read_file");

    await h.cleanup();
  });

  it("calls workflowSkillDelete with the workflow id + skill name after confirm", async () => {
    const h = await mount();
    const { api } = await import("../../../lib/tauri-api");

    const deleteBtn = h.container.querySelector(
      '[data-testid="skills-delete-lint_then_test"]',
    ) as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    await act(async () => {
      deleteBtn.click();
    });
    await flush();

    // ConfirmDialog mounted.
    const confirm = h.container.querySelector(
      '[data-testid="skills-delete-confirm"]',
    );
    expect(confirm).not.toBeNull();

    const allow = h.container.querySelector(
      '[data-testid="skills-delete-confirm-allow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allow.click();
    });
    await flush();

    expect(api.workflowSkillDelete).toHaveBeenCalledWith(99, "lint_then_test");

    await h.cleanup();
  });

  it("refetches when the workflowId prop changes", async () => {
    const { api } = await import("../../../lib/tauri-api");
    const h = await mount({ workflowId: 1 });

    expect(api.workflowSkillList).toHaveBeenCalledWith(1);
    const firstCallCount = (api.workflowSkillList as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    // Re-render with a new id. The panel's useEffect should refetch.
    await act(async () => {
      h.root.render(
        <SkillsPanel
          workflowId={2}
          workflowName="Test Workflow"
          open={true}
          onClose={() => undefined}
        />,
      );
    });
    await flush();

    expect(api.workflowSkillList).toHaveBeenCalledWith(2);
    expect(
      (api.workflowSkillList as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(firstCallCount);

    await h.cleanup();
  });
});

/* ── Feature-detection branch ──────────────────────────────────────────
 * The panel checks `"workflowSkillList" in api` and renders the
 * unavailable hint when it's false. We can't change the module-scope
 * mock from above, but vi.resetModules + vi.doMock + dynamic import
 * gives us a fresh copy with a different api shape for this block.
 */
describe("SkillsPanel feature detection", () => {
  it("renders the unavailable hint and does not call the API when workflowSkillList is missing", async () => {
    vi.resetModules();
    const listSpy = vi.fn(async () => []);
    vi.doMock("../../../lib/tauri-api", () => ({
      api: {
        // Intentionally NO workflowSkill* methods. We still expose `listSpy`
        // under a different name so we can prove it wasn't reached even by
        // accident if the panel called the wrong method.
        unrelated: listSpy,
      },
    }));
    vi.doMock("../../../lib/diagnostics", () => ({ logDiag: vi.fn() }));

    const { SkillsPanel: FreshPanel } = await import("../SkillsPanel");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <FreshPanel
          workflowId={1}
          workflowName="WF"
          open={true}
          onClose={() => undefined}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const hint = container.querySelector(
      '[data-testid="skills-panel-unsupported"]',
    );
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("not yet available");
    expect(listSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();

    vi.doUnmock("../../../lib/tauri-api");
    vi.doUnmock("../../../lib/diagnostics");
    vi.resetModules();
  });
});
