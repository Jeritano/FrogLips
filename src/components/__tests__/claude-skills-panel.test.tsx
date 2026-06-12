/**
 * ClaudeSkillsPanel tests.
 *
 * Mocks the Tauri API per the existing pattern
 * (`workflows/__tests__/skills-panel.test.tsx`,
 *  `__tests__/MemoryPanel.test.tsx`): `vi.mock("../../lib/tauri-api", …)`
 * returns a stub `api` object with the surface this panel touches.
 *
 * The "feature-detection" test sits in a SEPARATE describe block with
 * its own setup — the panel checks `"claudeSkillList" in api`, so we
 * need a module-scope mock that lacks those keys for that case. We use
 * vi.resetModules + vi.doMock + dynamic import to obtain a fresh copy
 * with a different api shape.
 *
 * The folder picker mock (`@tauri-apps/plugin-dialog`) is set up at
 * module scope and the call site dynamic-imports it — vitest's mock
 * registry honours dynamic imports too, so the stub takes effect even
 * though the component calls `await import(...)` lazily.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ClaudeSkillRow, ClaudeSkillSummary } from "../../types";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fixtures: ClaudeSkillSummary[] = [
  {
    id: 1,
    name: "pdf-fill",
    description:
      "Fill an Anthropic-format PDF skill. Drives a small Python script in the bundled folder; chat agents call load_claude_skill to mount it.",
    source_path: "/Users/joseph/skills/pdf-fill",
    enabled: true,
    pinned: true,
  },
  {
    id: 2,
    name: "docx-report",
    description: "Generate a Word document from a structured spec.",
    source_path: "/Users/joseph/skills/docx-report",
    enabled: false,
    pinned: false,
  },
];

const fullFixture: ClaudeSkillRow = {
  ...fixtures[0],
  body_md:
    "# pdf-fill\n\nThis skill fills a PDF form via the bundled Python helper.\n\n## Usage\n\nProvide a JSON spec…\n",
  allowed_tools_json: JSON.stringify(["Read", "Write", "Bash"]),
  imported_at: Date.now() - 60_000,
};

// Track the value returned from the next folder-picker call. Reset per test.
let dialogOpenResult: string | string[] | null =
  "/Users/joseph/skills/pdf-fill";
const dialogOpenSpy = vi.fn(async () => dialogOpenResult);

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenSpy,
}));

vi.mock("../../lib/tauri-api", () => {
  return {
    api: {
      claudeSkillList: vi.fn(async () => fixtures),
      claudeSkillGet: vi.fn(async () => fullFixture),
      claudeSkillImport: vi.fn(
        async (_path: string, _overwrite?: boolean) => fullFixture,
      ),
      claudeSkillSetEnabled: vi.fn(async () => undefined),
      claudeSkillSetPinned: vi.fn(async () => undefined),
      claudeSkillDelete: vi.fn(async () => undefined),
    },
  };
});

vi.mock("../../lib/diagnostics", () => ({
  logDiag: vi.fn(),
}));

import { ClaudeSkillsPanel } from "../ClaudeSkillsPanel";

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
  props: Partial<Parameters<typeof ClaudeSkillsPanel>[0]> = {},
): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = props.onClose ?? vi.fn();
  await act(async () => {
    root.render(
      <ClaudeSkillsPanel open={props.open ?? true} onClose={onClose} />,
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

describe("ClaudeSkillsPanel", () => {
  beforeEach(async () => {
    const { api } = await import("../../lib/tauri-api");
    dialogOpenResult = "/Users/joseph/skills/pdf-fill";
    dialogOpenSpy.mockClear();
    (api.claudeSkillList as ReturnType<typeof vi.fn>).mockClear();
    (api.claudeSkillList as ReturnType<typeof vi.fn>).mockResolvedValue(
      fixtures,
    );
    (api.claudeSkillGet as ReturnType<typeof vi.fn>).mockClear();
    (api.claudeSkillGet as ReturnType<typeof vi.fn>).mockResolvedValue(
      fullFixture,
    );
    (api.claudeSkillImport as ReturnType<typeof vi.fn>).mockClear();
    (api.claudeSkillImport as ReturnType<typeof vi.fn>).mockResolvedValue(
      fullFixture,
    );
    (api.claudeSkillSetEnabled as ReturnType<typeof vi.fn>).mockClear();
    (api.claudeSkillSetPinned as ReturnType<typeof vi.fn>).mockClear();
    (api.claudeSkillDelete as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("renders the empty state when no skills are imported", async () => {
    const { api } = await import("../../lib/tauri-api");
    (api.claudeSkillList as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const h = await mount();
    const empty = h.container.querySelector(
      '[data-testid="claude-skills-empty"]',
    );
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No Skills imported");
    expect(empty?.textContent).toContain("list_claude_skills()");
    expect(empty?.textContent).toContain("load_claude_skill(name)");

    await h.cleanup();
  });

  it("renders one row per skill with name, description, and source path", async () => {
    const h = await mount();
    const table = h.container.querySelector(
      '[data-testid="claude-skills-table"]',
    );
    expect(table).not.toBeNull();

    const row1 = h.container.querySelector(
      '[data-testid="claude-skills-row-pdf-fill"]',
    ) as HTMLElement;
    const row2 = h.container.querySelector(
      '[data-testid="claude-skills-row-docx-report"]',
    ) as HTMLElement;
    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();

    expect(row1.textContent).toContain("pdf-fill");
    expect(row1.textContent).toContain("Fill an Anthropic-format PDF skill");
    const path1 = h.container.querySelector(
      '[data-testid="claude-skills-path-pdf-fill"]',
    );
    expect(path1?.textContent).toBe("/Users/joseph/skills/pdf-fill");

    expect(row2.textContent).toContain("docx-report");
    const path2 = h.container.querySelector(
      '[data-testid="claude-skills-path-docx-report"]',
    );
    expect(path2?.textContent).toBe("/Users/joseph/skills/docx-report");

    // Status chips reflect the fixture state.
    const enabled1 = h.container.querySelector(
      '[data-testid="claude-skills-chip-enabled-pdf-fill"]',
    );
    expect(enabled1?.textContent).toContain("enabled");
    const enabled2 = h.container.querySelector(
      '[data-testid="claude-skills-chip-enabled-docx-report"]',
    );
    expect(enabled2?.textContent).toContain("disabled");
    const pinned1 = h.container.querySelector(
      '[data-testid="claude-skills-chip-pinned-pdf-fill"]',
    );
    expect(pinned1).not.toBeNull();
    const pinned2 = h.container.querySelector(
      '[data-testid="claude-skills-chip-pinned-docx-report"]',
    );
    expect(pinned2).toBeNull();

    await h.cleanup();
  });

  it("opens the folder picker and calls claudeSkillImport with the chosen folder", async () => {
    const { api } = await import("../../lib/tauri-api");
    dialogOpenResult = "/Users/joseph/skills/new-one";

    const h = await mount();
    const importBtn = h.container.querySelector(
      '[data-testid="claude-skills-import"]',
    ) as HTMLButtonElement;
    expect(importBtn).not.toBeNull();
    await act(async () => {
      importBtn.click();
    });
    await flush();

    expect(dialogOpenSpy).toHaveBeenCalledTimes(1);
    const dialogCall = (dialogOpenSpy.mock.calls[0] as unknown[])[0] as {
      directory?: boolean;
    };
    expect(dialogCall.directory).toBe(true);

    expect(api.claudeSkillImport).toHaveBeenCalledWith(
      "/Users/joseph/skills/new-one",
      false,
    );

    await h.cleanup();
  });

  it("shows the overwrite confirm on name_collision and re-imports with overwrite=true on confirm", async () => {
    const { api } = await import("../../lib/tauri-api");
    dialogOpenResult = "/Users/joseph/skills/pdf-fill-v2";

    // First call rejects with the collision payload; subsequent call resolves.
    let firstCall = true;
    (api.claudeSkillImport as ReturnType<typeof vi.fn>).mockImplementation(
      async (_path: string, _overwrite?: boolean) => {
        if (firstCall) {
          firstCall = false;
          throw {
            kind: "name_collision",
            name: "pdf-fill",
            existing_path: "/Users/joseph/skills/pdf-fill",
          };
        }
        return fullFixture;
      },
    );

    const h = await mount();
    const importBtn = h.container.querySelector(
      '[data-testid="claude-skills-import"]',
    ) as HTMLButtonElement;
    await act(async () => {
      importBtn.click();
    });
    await flush();

    const confirm = h.container.querySelector(
      '[data-testid="claude-skills-overwrite-confirm"]',
    );
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain("pdf-fill");
    expect(confirm?.textContent).toContain("/Users/joseph/skills/pdf-fill");
    expect(confirm?.textContent).toContain("/Users/joseph/skills/pdf-fill-v2");

    const allow = h.container.querySelector(
      '[data-testid="claude-skills-overwrite-confirm-allow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allow.click();
    });
    await flush();

    expect(api.claudeSkillImport).toHaveBeenCalledTimes(2);
    expect(api.claudeSkillImport).toHaveBeenLastCalledWith(
      "/Users/joseph/skills/pdf-fill-v2",
      true,
    );

    await h.cleanup();
  });

  it("calls claudeSkillSetEnabled with the inverted flag when the enable toggle is clicked", async () => {
    const { api } = await import("../../lib/tauri-api");
    const h = await mount();

    // pdf-fill is currently enabled — clicking should disable it.
    const toggle = h.container.querySelector(
      '[data-testid="claude-skills-toggle-enabled-pdf-fill"]',
    ) as HTMLButtonElement;
    expect(toggle.textContent).toContain("Disable");
    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(api.claudeSkillSetEnabled).toHaveBeenCalledWith("pdf-fill", false);
    // refresh fires another list call.
    expect(
      (api.claudeSkillList as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(1);

    // docx-report is currently disabled — clicking should enable it.
    const toggle2 = h.container.querySelector(
      '[data-testid="claude-skills-toggle-enabled-docx-report"]',
    ) as HTMLButtonElement;
    expect(toggle2.textContent).toContain("Enable");
    await act(async () => {
      toggle2.click();
    });
    await flush();

    expect(api.claudeSkillSetEnabled).toHaveBeenCalledWith("docx-report", true);

    await h.cleanup();
  });

  it("calls claudeSkillSetPinned with the inverted flag when the pin toggle is clicked", async () => {
    const { api } = await import("../../lib/tauri-api");
    const h = await mount();

    const unpinBtn = h.container.querySelector(
      '[data-testid="claude-skills-toggle-pinned-pdf-fill"]',
    ) as HTMLButtonElement;
    expect(unpinBtn.textContent).toContain("Unpin");
    await act(async () => {
      unpinBtn.click();
    });
    await flush();
    expect(api.claudeSkillSetPinned).toHaveBeenCalledWith("pdf-fill", false);
    expect(
      (api.claudeSkillList as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(1);

    const pinBtn = h.container.querySelector(
      '[data-testid="claude-skills-toggle-pinned-docx-report"]',
    ) as HTMLButtonElement;
    expect(pinBtn.textContent).toContain("Pin");
    await act(async () => {
      pinBtn.click();
    });
    await flush();
    expect(api.claudeSkillSetPinned).toHaveBeenCalledWith("docx-report", true);

    await h.cleanup();
  });

  it("calls claudeSkillDelete with the skill name after the destructive confirm", async () => {
    const { api } = await import("../../lib/tauri-api");
    const h = await mount();

    const delBtn = h.container.querySelector(
      '[data-testid="claude-skills-delete-pdf-fill"]',
    ) as HTMLButtonElement;
    await act(async () => {
      delBtn.click();
    });
    await flush();

    const confirm = h.container.querySelector(
      '[data-testid="claude-skills-delete-confirm"]',
    );
    expect(confirm).not.toBeNull();

    const allow = h.container.querySelector(
      '[data-testid="claude-skills-delete-confirm-allow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allow.click();
    });
    await flush();

    expect(api.claudeSkillDelete).toHaveBeenCalledWith("pdf-fill");

    await h.cleanup();
  });

  it("renders the full body_md inside the View Body sub-modal", async () => {
    const { api } = await import("../../lib/tauri-api");
    const h = await mount();

    const viewBtn = h.container.querySelector(
      '[data-testid="claude-skills-view-pdf-fill"]',
    ) as HTMLButtonElement;
    expect(viewBtn).not.toBeNull();
    await act(async () => {
      viewBtn.click();
    });
    await flush();

    expect(api.claudeSkillGet).toHaveBeenCalledWith("pdf-fill");
    const body = h.container.querySelector(
      '[data-testid="claude-skills-body-md"]',
    );
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("# pdf-fill");
    expect(body?.textContent).toContain("This skill fills a PDF form");

    // allowed_tools_json gets parsed into chips.
    const tools = h.container.querySelector(
      '[data-testid="claude-skills-allowed-tools"]',
    );
    expect(tools).not.toBeNull();
    expect(tools?.textContent).toContain("Read");
    expect(tools?.textContent).toContain("Write");
    expect(tools?.textContent).toContain("Bash");

    await h.cleanup();
  });

  it("re-imports with the existing source_path + overwrite=true from the View Body sub-modal", async () => {
    const { api } = await import("../../lib/tauri-api");
    const h = await mount();

    const viewBtn = h.container.querySelector(
      '[data-testid="claude-skills-view-pdf-fill"]',
    ) as HTMLButtonElement;
    await act(async () => {
      viewBtn.click();
    });
    await flush();

    const reimport = h.container.querySelector(
      '[data-testid="claude-skills-reimport"]',
    ) as HTMLButtonElement;
    expect(reimport).not.toBeNull();
    await act(async () => {
      reimport.click();
    });
    await flush();

    expect(api.claudeSkillImport).toHaveBeenCalledWith(
      "/Users/joseph/skills/pdf-fill",
      true,
    );

    await h.cleanup();
  });
});

/* ── Feature-detection branch ────────────────────────────────────────── */
describe("ClaudeSkillsPanel feature detection", () => {
  it("renders the unavailable hint and does not call any api method when claudeSkillList is missing", async () => {
    vi.resetModules();
    const listSpy = vi.fn(async () => []);
    vi.doMock("../../lib/tauri-api", () => ({
      api: {
        // Intentionally NO claudeSkill* methods. We expose `listSpy` under
        // a different name to prove the panel never reaches for it.
        unrelated: listSpy,
      },
    }));
    vi.doMock("../../lib/diagnostics", () => ({ logDiag: vi.fn() }));
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

    const { ClaudeSkillsPanel: FreshPanel } =
      await import("../ClaudeSkillsPanel");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<FreshPanel open={true} onClose={() => undefined} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const hint = container.querySelector(
      '[data-testid="claude-skills-unsupported"]',
    );
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("not yet available");
    expect(listSpy).not.toHaveBeenCalled();

    // The Import button is rendered but disabled — clicking it should
    // not open the folder picker.
    const importBtn = container.querySelector(
      '[data-testid="claude-skills-import"]',
    ) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();

    vi.doUnmock("../../lib/tauri-api");
    vi.doUnmock("../../lib/diagnostics");
    vi.doUnmock("@tauri-apps/plugin-dialog");
    vi.resetModules();
  });
});
