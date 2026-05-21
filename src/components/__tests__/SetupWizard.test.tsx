import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * SetupWizard renders three steps:
 *   1. backend probe table
 *   2. starter model cards
 *   3. sample prompt cards + Done button
 *
 * We mock the Tauri api wrapper so probes resolve deterministically and the
 * Done button's setup-complete persistence call can be asserted. The
 * `chat-input:prefill` window event dispatch lives in App.tsx, not the
 * wizard itself, so we only check the `onDone(samplePrompt)` callback here.
 */

const apiMocks = vi.hoisted(() => ({
  nativeSupported: vi.fn(async () => true),
  mlxProbe: vi.fn(async () => false),
  ollamaProbe: vi.fn(async () => true),
  openExternal: vi.fn(async () => undefined),
  pullOllamaModel: vi.fn(async () => "Pulled"),
  pullHfModel: vi.fn(async () => "Downloaded"),
  settingsSet: vi.fn(async () => ({})),
  setupCompleteSet: vi.fn(async () => undefined),
}));

vi.mock("../../lib/tauri-api", () => ({ api: apiMocks }));
vi.mock("../../lib/diagnostics", () => ({ logDiag: vi.fn() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SetupWizard } from "../SetupWizard";

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
  onDone: ReturnType<typeof vi.fn>;
}

async function mount(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onDone = vi.fn();
  await act(async () => {
    root.render(<SetupWizard onDone={onDone} />);
  });
  await flush();
  return { container, root, onDone };
}

describe("SetupWizard", () => {
  beforeEach(() => {
    apiMocks.nativeSupported.mockClear().mockResolvedValue(true);
    apiMocks.mlxProbe.mockClear().mockResolvedValue(false);
    apiMocks.ollamaProbe.mockClear().mockResolvedValue(true);
    apiMocks.openExternal.mockClear();
    apiMocks.pullOllamaModel.mockClear();
    apiMocks.pullHfModel.mockClear();
    apiMocks.settingsSet.mockClear();
    apiMocks.setupCompleteSet.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders Step 1 and reflects backend probe results", async () => {
    const { container, root } = await mount();

    // Wizard mounted.
    expect(container.querySelector('[data-testid="setup-wizard"]')).not.toBeNull();
    // Step 1 visible.
    expect(container.querySelector('[data-testid="setup-wizard-step-1"]')).not.toBeNull();

    // Probe table has three backend rows.
    expect(container.querySelector('[data-testid="setup-wizard-probe-native"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="setup-wizard-probe-mlx"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="setup-wizard-probe-ollama"]')).not.toBeNull();

    // Probes resolved per the mock setup (native=true, mlx=false, ollama=true).
    const nativeStatus = container.querySelector(
      '[data-testid="setup-wizard-status-native"]',
    ) as HTMLElement;
    expect(nativeStatus.textContent).toContain("Available");
    const mlxStatus = container.querySelector(
      '[data-testid="setup-wizard-status-mlx"]',
    ) as HTMLElement;
    expect(mlxStatus.textContent).toContain("Not detected");
    const ollamaStatus = container.querySelector(
      '[data-testid="setup-wizard-status-ollama"]',
    ) as HTMLElement;
    expect(ollamaStatus.textContent).toContain("Available");

    // Each probe IPC was called exactly once.
    expect(apiMocks.nativeSupported).toHaveBeenCalledTimes(1);
    expect(apiMocks.mlxProbe).toHaveBeenCalledTimes(1);
    expect(apiMocks.ollamaProbe).toHaveBeenCalledTimes(1);

    await act(async () => { root.unmount(); });
  });

  it("Done button hands the chosen sample prompt back via onDone", async () => {
    const { container, root, onDone } = await mount();

    // Walk Step 1 → Step 2 → Step 3.
    await act(async () => {
      const nextBtn = container.querySelector(
        '[data-testid="setup-wizard-next-1"]',
      ) as HTMLButtonElement;
      nextBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="setup-wizard-step-2"]')).not.toBeNull();

    // Skip the model step (download not required for the wizard contract).
    await act(async () => {
      const skip = container.querySelector(
        '[data-testid="setup-wizard-skip-model"]',
      ) as HTMLButtonElement;
      skip.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="setup-wizard-step-3"]')).not.toBeNull();

    // Done with no prompt selected → onDone(null).
    await act(async () => {
      const done = container.querySelector(
        '[data-testid="setup-wizard-done"]',
      ) as HTMLButtonElement;
      done.click();
    });
    await flush();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);

    await act(async () => { root.unmount(); });
  });

  it("clicking a sample prompt card invokes onDone with that prompt text", async () => {
    const { container, root, onDone } = await mount();

    await act(async () => {
      (container.querySelector(
        '[data-testid="setup-wizard-next-1"]',
      ) as HTMLButtonElement).click();
    });
    await flush();
    await act(async () => {
      (container.querySelector(
        '[data-testid="setup-wizard-skip-model"]',
      ) as HTMLButtonElement).click();
    });
    await flush();

    // Click the first prompt card.
    const card = container.querySelector<HTMLButtonElement>(
      '[data-testid^="setup-wizard-prompt-"]',
    );
    expect(card).not.toBeNull();
    await act(async () => { card!.click(); });
    await flush();

    expect(onDone).toHaveBeenCalledTimes(1);
    const arg = onDone.mock.calls[0][0];
    expect(typeof arg).toBe("string");
    expect((arg as string).length).toBeGreaterThan(0);

    await act(async () => { root.unmount(); });
  });
});
