import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * PrivacyPanel decides the "100% local" vs "Cloud model active" trust label
 * from the active backend (LOCAL_BACKENDS.has). That's a security-facing claim,
 * so it's pinned here: adding a cloud backend without updating LOCAL_BACKENDS
 * would mislabel it as local and fail this test. The embedded AuditLog is
 * stubbed (its own data path is out of scope).
 */

const apiMocks = vi.hoisted(() => ({
  serverStatus: vi.fn(),
  agentGetWorkspace: vi.fn(async () => "/Users/me/proj"),
}));
vi.mock("../../lib/tauri-api", () => ({ api: apiMocks }));
vi.mock("../AuditLog", () => ({ AuditLog: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { PrivacyPanel } from "../PrivacyPanel";

function status(backend: string | null) {
  return {
    running: backend != null,
    ready: backend != null,
    model: backend ? "m" : null,
    backend,
    host: "",
    port: 0,
    last_error: null,
  };
}

describe("PrivacyPanel trust labeling", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PrivacyPanel open={true} onClose={() => {}} />);
    });
    // Flush the two sequential async awaits in the open-effect.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("labels a local backend (ollama) 100% local", async () => {
    apiMocks.serverStatus.mockResolvedValue(status("ollama"));
    await mount();
    expect(container.textContent).toContain("100% local");
    expect(container.textContent).not.toContain("Cloud model active");
  });

  it("labels mlx / native as local too", async () => {
    for (const b of ["mlx", "native"]) {
      apiMocks.serverStatus.mockResolvedValue(status(b));
      await mount();
      expect(container.textContent, b).toContain("100% local");
      act(() => root.unmount());
      container.remove();
    }
    // re-mount so afterEach has a live root to unmount
    apiMocks.serverStatus.mockResolvedValue(status("native"));
    await mount();
  });

  it("labels a cloud backend (openrouter) as cloud, not local", async () => {
    apiMocks.serverStatus.mockResolvedValue(status("openrouter"));
    await mount();
    expect(container.textContent).toContain("Cloud model active");
    expect(container.textContent).not.toContain("100% local");
  });

  it("treats no running model as local (nothing leaves the machine)", async () => {
    apiMocks.serverStatus.mockResolvedValue(status(null));
    await mount();
    expect(container.textContent).toContain("100% local");
  });

  it("shows the confined workspace path", async () => {
    apiMocks.serverStatus.mockResolvedValue(status("ollama"));
    await mount();
    expect(container.textContent).toContain("/Users/me/proj");
  });
});
