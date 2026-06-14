import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppSettings } from "../../types";

// ── Tauri stubs ──────────────────────────────────────────────────────────
// The context reaches Rust through `invoke("settings_get" | "settings_set")`
// and subscribes via `listen("settings-changed")`. Capture both so the test
// controls what each call returns and can replay the change event.
type Handler = (e: { payload: unknown }) => void;
const { handlers, invokeMock, listenMock } = vi.hoisted(() => {
  const handlers: Record<string, Handler> = {};
  const invokeMock = vi.fn();
  const listenMock = vi.fn(async (name: string, fn: Handler) => {
    handlers[name] = fn;
    return () => {
      delete handlers[name];
    };
  });
  return { handlers, invokeMock, listenMock };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import {
  SettingsProvider,
  useSettings,
  useSettingsField,
  useSettingsGetter,
  useUpdateSettings,
} from "../SettingsContext";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Default `invoke` impl: settings_get returns the current blob; settings_set
// merges the patch into it (mirroring the Rust merge-and-return contract).
let store: AppSettings = {};
function installInvoke() {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "settings_get") return { ...store };
    if (cmd === "settings_set") {
      const patch = (args as { patch: Partial<AppSettings> }).patch;
      store = { ...store, ...patch };
      return { ...store };
    }
    return undefined;
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let container: HTMLElement;
let root: Root;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<SettingsProvider>{ui}</SettingsProvider>);
  });
}

beforeEach(() => {
  store = {};
  invokeMock.mockReset();
  listenMock.mockClear();
  for (const k of Object.keys(handlers)) delete handlers[k];
  installInvoke();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = "";
});

describe("SettingsProvider", () => {
  it("loads settings once on mount via settings_get", async () => {
    store = { ollama_keep_alive: "30m" };
    let seen: AppSettings | null = null;
    function Probe() {
      seen = useSettings();
      return null;
    }
    mount(<Probe />);
    await flush();
    expect(seen).toEqual({ ollama_keep_alive: "30m" });
    const gets = invokeMock.mock.calls.filter((c) => c[0] === "settings_get");
    expect(gets).toHaveLength(1);
  });

  it("subscribes to settings-changed exactly once", async () => {
    function Probe() {
      useSettings();
      return null;
    }
    mount(<Probe />);
    await flush();
    const changedSubs = listenMock.mock.calls.filter(
      (c) => c[0] === "settings-changed",
    );
    expect(changedSubs).toHaveLength(1);
  });

  it("re-fetches when a settings-changed event fires", async () => {
    store = { theme: "dark" };
    let seen: AppSettings | null = null;
    function Probe() {
      seen = useSettings();
      return null;
    }
    mount(<Probe />);
    await flush();
    expect(seen).toEqual({ theme: "dark" });

    // An out-of-band change to the backing store, then the event round-trips.
    store = { theme: "light" };
    await act(async () => {
      handlers["settings-changed"]?.({ payload: null });
    });
    await flush();
    expect(seen).toEqual({ theme: "light" });
  });

  it("useSettingsField re-renders only when its slice changes", async () => {
    store = { theme: "dark", ollama_keep_alive: "30m" };
    let themeRenders = 0;
    function ThemeProbe() {
      themeRenders++;
      const theme = useSettingsField((s) => s?.theme ?? null);
      return <span>{theme}</span>;
    }
    const updates: { fn: ReturnType<typeof useUpdateSettings> | null } = {
      fn: null,
    };
    function Updater() {
      updates.fn = useUpdateSettings();
      return null;
    }
    mount(
      <>
        <ThemeProbe />
        <Updater />
      </>,
    );
    await flush();
    const afterLoad = themeRenders;
    expect(afterLoad).toBeGreaterThan(0);

    // Change a DIFFERENT field — the theme slice is unchanged, so ThemeProbe
    // must not re-render.
    await act(async () => {
      await updates.fn!({ ollama_keep_alive: "5m" });
    });
    await flush();
    expect(themeRenders).toBe(afterLoad);

    // Now change theme — ThemeProbe re-renders.
    await act(async () => {
      await updates.fn!({ theme: "light" });
    });
    await flush();
    expect(themeRenders).toBeGreaterThan(afterLoad);
  });

  it("useSettingsField re-runs a changed selector even if the blob is unchanged", async () => {
    // Regression: the cache was keyed purely on the settings-blob input
    // reference, so a re-render with a NEW selector closure (one that closes
    // over changed state and selects a different slice) returned the PREVIOUS
    // selector's value until the whole blob changed. Key the cache on selector
    // identity and make getSnapshot's identity track the selector so
    // useSyncExternalStore actually re-reads.
    store = { custom_backends: ["a", "b", "c"] as unknown as never };
    let setIndex: ((i: number) => void) | null = null;
    let seen: unknown = "unset";
    function Probe() {
      const [index, setIndexState] = useState(0);
      setIndex = setIndexState;
      // Selector closes over `index`, so each render mints a different closure
      // that selects a different slice — while the blob reference is stable.
      seen = useSettingsField(
        (s) => (s?.custom_backends as unknown as string[] | undefined)?.[index],
      );
      return null;
    }
    mount(<Probe />);
    await flush();
    expect(seen).toBe("a");

    // Bump the index with NO settings change. The new selector must run.
    await act(async () => {
      setIndex!(2);
    });
    await flush();
    expect(seen).toBe("c");
  });

  it("useSettingsField returns the caller's default while loading", async () => {
    // Make settings_get hang so the store never hydrates.
    invokeMock.mockImplementation(
      (cmd: string) =>
        cmd === "settings_get" ? new Promise<never>(() => {}) : undefined,
    );
    let backends: unknown = "unset";
    function Probe() {
      backends = useSettingsField((s) => s?.custom_backends ?? []);
      return null;
    }
    mount(<Probe />);
    await flush();
    expect(backends).toEqual([]);
  });

  it("useSettingsGetter reads the latest blob synchronously after load", async () => {
    store = { agent_max_iterations: 80 };
    let getter: (() => Promise<AppSettings>) | null = null;
    let update: ReturnType<typeof useUpdateSettings> | null = null;
    function Probe() {
      getter = useSettingsGetter();
      update = useUpdateSettings();
      return null;
    }
    mount(<Probe />);
    await flush();

    const before = await getter!();
    expect(before.agent_max_iterations).toBe(80);
    const getsBefore = invokeMock.mock.calls.filter(
      (c) => c[0] === "settings_get",
    ).length;

    await act(async () => {
      await update!({ agent_max_iterations: 120 });
    });
    const after = await getter!();
    expect(after.agent_max_iterations).toBe(120);
    // The getter served from the cache (eagerly updated by settings_set) — no
    // extra settings_get round-trip.
    const getsAfter = invokeMock.mock.calls.filter(
      (c) => c[0] === "settings_get",
    ).length;
    expect(getsAfter).toBe(getsBefore);
  });

  it("useSettingsGetter falls back to a fetch before the store hydrates", async () => {
    let resolveGet: ((v: AppSettings) => void) | null = null;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get")
        return new Promise<AppSettings>((res) => {
          resolveGet = res;
        });
      return undefined;
    });
    let getter: (() => Promise<AppSettings>) | null = null;
    function Probe() {
      getter = useSettingsGetter();
      return null;
    }
    mount(<Probe />);
    await flush();
    // Store hasn't hydrated (the mount fetch is still pending). The getter
    // triggers refresh(); resolve it and assert the getter yields the blob.
    const pending = getter!();
    // resolveGet is assigned inside the mockImplementation closure, so TS narrows
    // it back to its `null` initializer here — cast to re-widen to the union.
    (resolveGet as ((v: AppSettings) => void) | null)?.({ last_model: "m1" });
    const got = await pending;
    expect(got).toEqual({ last_model: "m1" });
  });

  it("updateSettings applies the merged blob eagerly (before the event)", async () => {
    store = { theme: "dark" };
    let seen: AppSettings | null = null;
    let update: ReturnType<typeof useUpdateSettings> | null = null;
    function Probe() {
      seen = useSettings();
      update = useUpdateSettings();
      return null;
    }
    mount(<Probe />);
    await flush();

    // No settings-changed event is replayed here — the eager apply alone must
    // surface the new value (preserving write → immediate-refresh semantics).
    await act(async () => {
      await update!({ theme: "light" });
    });
    await flush();
    expect(seen).toEqual({ theme: "light" });
  });
});
