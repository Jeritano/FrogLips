/**
 * CardForm tests — the friendly schedule picker + the needsReview "Arm"
 * control.
 *
 * Mirrors the existing `skills-panel.test.tsx` harness: happy-dom +
 * `createRoot`/`act`, a stubbed `api` (CardForm only calls `listAllModels`
 * at mount), and `data-testid` / role queries against the rendered DOM.
 *
 * Coverage:
 *   - Schedule round-trips for each mode: opening a card with a stored
 *     schedule lands on the right mode with the value pre-filled, and
 *     editing/switching emits the canonical grammar string back via onSave.
 *   - The new "On a date" mode emits `at YYYY-MM-DDTHH:MM`.
 *   - A past `at` datetime is a soft warning (NOT a save block).
 *   - The Arm button clears `needsReview` (and only the button does — the
 *     banner is gone after arming).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkflowCard } from "../../../types";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// CardForm only touches the API to populate the Model dropdown. Return an
// empty installed-models list so the effect settles immediately.
vi.mock("../../../lib/tauri-api", () => ({
  api: {
    listAllModels: vi.fn(async () => ({ mlx: [], ollama: [] })),
  },
}));

import { CardForm } from "../CardForm";

function baseCard(over: Partial<WorkflowCard> = {}): WorkflowCard {
  return {
    id: "c1",
    name: "Tester",
    preset: "general",
    prompt: "do a thing",
    tools: [],
    schedule: null,
    backend: null,
    placed: true,
    x: 0,
    y: 0,
    ...over,
  };
}

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
  onSave: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function mount(card: WorkflowCard): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  await act(async () => {
    root.render(
      <CardForm
        card={card}
        origin={null}
        isNew={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
  });
  await flush();
  return {
    container,
    root,
    onSave,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Find a schedule mode button by its visible label. */
function modeBtn(container: HTMLElement, label: string): HTMLButtonElement {
  const btns = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".wf-sched-mode"),
  );
  const hit = btns.find((b) => b.textContent?.trim() === label);
  if (!hit) throw new Error(`mode button "${label}" not found`);
  return hit;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/** Set a controlled input's value the way React's onChange expects. */
async function setInput(el: HTMLInputElement | HTMLSelectElement, v: string) {
  await act(async () => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

/** Click the form's Save and return the card passed to onSave. */
async function save(h: Harness): Promise<WorkflowCard> {
  const saveBtn = Array.from(
    h.container.querySelectorAll<HTMLButtonElement>(".wf-form-foot button"),
  ).find((b) => b.textContent?.trim() === "Save");
  if (!saveBtn) throw new Error("Save button not found");
  await click(saveBtn);
  // The exit animation is zeroed under reduced-motion / no transitionend in
  // happy-dom, so the timeout fallback (400ms) fires; advance fake timers if
  // present, else the synchronous reduced-motion path already called onSave.
  await flush();
  expect(h.onSave).toHaveBeenCalled();
  const calls = h.onSave.mock.calls;
  return calls[calls.length - 1][0] as WorkflowCard;
}

describe("CardForm — schedule picker round-trips", () => {
  beforeEach(() => {
    // Make the exit "fly/fade" path resolve synchronously: report
    // reduced-motion so CardForm.exit() calls the callback immediately.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({
        matches: q.includes("reduce"),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a blank schedule in Manual mode", async () => {
    const h = await mount(baseCard({ schedule: null }));
    expect(modeBtn(h.container, "Manual").getAttribute("aria-checked")).toBe(
      "true",
    );
    await h.cleanup();
  });

  it("Every: round-trips `every 2h` and re-emits on edit", async () => {
    const h = await mount(baseCard({ schedule: "every 2h" }));
    expect(modeBtn(h.container, "Every").getAttribute("aria-checked")).toBe(
      "true",
    );
    const count = h.container.querySelector<HTMLInputElement>(
      'input[aria-label="Interval count"]',
    )!;
    const unit = h.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Interval unit"]',
    )!;
    expect(count.value).toBe("2");
    expect(unit.value).toBe("h");
    // Change to every 45m.
    await setInput(count, "45");
    await setInput(unit, "m");
    const saved = await save(h);
    expect(saved.schedule).toBe("every 45m");
    await h.cleanup();
  });

  it("Daily: round-trips `daily 09:00` and re-emits on edit", async () => {
    const h = await mount(baseCard({ schedule: "daily 09:00" }));
    expect(modeBtn(h.container, "Daily").getAttribute("aria-checked")).toBe(
      "true",
    );
    const time = h.container.querySelector<HTMLInputElement>(
      'input[aria-label="Daily time"]',
    )!;
    expect(time.value).toBe("09:00");
    await setInput(time, "17:30");
    const saved = await save(h);
    expect(saved.schedule).toBe("daily 17:30");
    await h.cleanup();
  });

  it("On a date: round-trips `at …` and emits the `at` grammar", async () => {
    const future = "2999-01-02T03:04";
    const h = await mount(baseCard({ schedule: `at ${future}` }));
    expect(modeBtn(h.container, "On a date").getAttribute("aria-checked")).toBe(
      "true",
    );
    const dt = h.container.querySelector<HTMLInputElement>(
      'input[aria-label="Run-at date and time"]',
    )!;
    expect(dt.value).toBe(future);
    // A future `at` saves with no error block.
    const saved = await save(h);
    expect(saved.schedule).toBe(`at ${future}`);
    await h.cleanup();
  });

  it("switching Manual → On a date and picking a datetime emits `at`", async () => {
    const h = await mount(baseCard({ schedule: null }));
    await click(modeBtn(h.container, "On a date"));
    const dt = h.container.querySelector<HTMLInputElement>(
      'input[aria-label="Run-at date and time"]',
    )!;
    await setInput(dt, "2999-12-31T23:59");
    const saved = await save(h);
    expect(saved.schedule).toBe("at 2999-12-31T23:59");
    await h.cleanup();
  });

  it("a PAST `at` datetime is a soft warning, not a save block", async () => {
    const h = await mount(baseCard({ schedule: "at 2000-01-01T00:00" }));
    // No hard field error → Save is enabled.
    expect(h.container.querySelector(".wf-field-error")).toBeNull();
    // The soft warn hint is shown.
    const warn = h.container.querySelector(".wf-sched-warn");
    expect(warn).not.toBeNull();
    const saveBtn = Array.from(
      h.container.querySelectorAll<HTMLButtonElement>(".wf-form-foot button"),
    ).find((b) => b.textContent?.trim() === "Save")!;
    expect(saveBtn.disabled).toBe(false);
    const saved = await save(h);
    expect(saved.schedule).toBe("at 2000-01-01T00:00");
    await h.cleanup();
  });

  it("Manual mode clears the schedule to null", async () => {
    const h = await mount(baseCard({ schedule: "every 30m" }));
    await click(modeBtn(h.container, "Manual"));
    const saved = await save(h);
    expect(saved.schedule).toBeNull();
    await h.cleanup();
  });

  it("an unrecognized schedule drops to the raw escape hatch untouched", async () => {
    const h = await mount(baseCard({ schedule: "weekly mondays" }));
    expect(modeBtn(h.container, "Advanced").getAttribute("aria-checked")).toBe(
      "true",
    );
    const raw = h.container.querySelector<HTMLInputElement>(
      'input[aria-label="Raw schedule"]',
    )!;
    expect(raw.value).toBe("weekly mondays");
    await h.cleanup();
  });
});

describe("CardForm — needsReview Arm control", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({
        matches: q.includes("reduce"),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the banner with granted tools when needsReview is true", async () => {
    const h = await mount(
      baseCard({
        needsReview: true,
        tools: ["run_shell", "web_fetch"],
        nodeType: "critic",
      }),
    );
    const banner = h.container.querySelector(".wf-review-banner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("needs review");
    expect(banner!.textContent).toContain("run_shell");
    expect(banner!.textContent).toContain("web_fetch");
    // Non-agent node type is surfaced.
    expect(banner!.textContent).toContain("Critic Loop");
    await h.cleanup();
  });

  it("does not show the banner when needsReview is absent", async () => {
    const h = await mount(baseCard({ needsReview: false }));
    expect(h.container.querySelector(".wf-review-banner")).toBeNull();
    await h.cleanup();
  });

  it("Arm button clears needsReview and hides the banner", async () => {
    const h = await mount(
      baseCard({ needsReview: true, tools: ["edit_file"] }),
    );
    const arm = h.container.querySelector<HTMLButtonElement>(".wf-review-arm")!;
    expect(arm).not.toBeNull();
    await click(arm);
    // Banner gone after arming.
    expect(h.container.querySelector(".wf-review-banner")).toBeNull();
    // And saving now carries needsReview === false.
    const saved = await save(h);
    expect(saved.needsReview).toBe(false);
    await h.cleanup();
  });

  it("saving WITHOUT arming preserves needsReview === true", async () => {
    const h = await mount(
      baseCard({ needsReview: true, tools: ["edit_file"] }),
    );
    const saved = await save(h);
    expect(saved.needsReview).toBe(true);
    await h.cleanup();
  });
});
