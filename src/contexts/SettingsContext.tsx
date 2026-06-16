import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { api } from "../lib/tauri-api";
import { registerCustomBackendHosts } from "../lib/inference-gate";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { logDiag } from "../lib/diagnostics";
import type { AppSettings } from "../types";

/* ── Central settings store ───────────────────────────────────────────────
 *
 * One source of truth for the `settings.json` blob in the webview. Replaces
 * the ~20 component sites that each issued their own `settings_get` + their
 * own `settings-changed` listener, all pulling the entire blob to slice out a
 * field or two.
 *
 * Semantics are preserved exactly:
 *   - The blob is fetched ONCE on mount (same payload-less `settings_get`).
 *   - A SINGLE `settings-changed` listener re-fetches and pushes the fresh
 *     blob to subscribers (the old per-site listeners did the same re-fetch).
 *   - `updateSettings(patch)` calls the existing `settings_set`; the Rust side
 *     emits `settings-changed`, which round-trips back through the listener and
 *     refreshes the store. This keeps the write → event → refresh ordering the
 *     individual call sites relied on. `settings_set` also returns the merged
 *     blob, which we apply immediately so the value is current even before the
 *     event lands (the event then reconciles, idempotently).
 *
 * Selective re-render: the store is exposed through `useSyncExternalStore`, so
 * `useSettingsField(selector)` re-renders a component only when its selected
 * slice changes — not on every unrelated settings write. The full-blob
 * `useSettings()` hook re-renders on any change, matching a component that
 * read the whole object before.
 *
 * Call-time reads: `useSettingsGetter()` returns a stable function that reads
 * the latest blob synchronously. Handlers that previously did
 * `await api.settingsGet()` inside an async action (to read the freshest value
 * at the moment of the action) use this instead of forcing the read through
 * React state, preserving their exact read-at-call-time behavior.
 */

interface SettingsStore {
  /** Current cached blob, or null until the first fetch resolves. */
  get: () => AppSettings | null;
  /** Subscribe to any change; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void;
  /** Replace the cached blob and notify subscribers. */
  set: (next: AppSettings | null) => void;
}

function createStore(): SettingsStore {
  let snapshot: AppSettings | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      snapshot = next;
      for (const l of listeners) l();
    },
  };
}

interface SettingsContextValue {
  store: SettingsStore;
  /** Re-fetch the blob from Rust and push it into the store. */
  refresh: () => Promise<AppSettings | null>;
  /**
   * Persist a partial settings patch via `settings_set`. The returned (merged)
   * blob is applied to the store immediately; the `settings-changed` event the
   * Rust side emits then round-trips and refreshes again (idempotent).
   */
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  // The store is created once and never re-created, so subscribers keep a
  // stable subscription target across re-renders.
  const storeRef = useRef<SettingsStore | null>(null);
  if (storeRef.current === null) storeRef.current = createStore();
  const store = storeRef.current;

  const refresh = useCallback(async () => {
    try {
      const s = await api.settingsGet();
      store.set(s);
      // Keep the inference-gate's custom-backend host registry in sync so it can
      // gate localhost custom endpoints (and bypass genuinely-remote ones)
      // without threading base_url through every call site.
      registerCustomBackendHosts(s.custom_backends);
      return s;
    } catch (err) {
      logDiag({
        level: "warn",
        source: "settings",
        message: "settingsGet() failed — keeping the last cached blob",
        detail: err,
      });
      return store.get();
    }
  }, [store]);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      // `settings_set` returns the merged blob. Apply it eagerly so consumers
      // see the new value without waiting for the event, then let the
      // `settings-changed` round-trip reconcile (idempotent re-fetch).
      const merged = await api.settingsSet(patch);
      store.set(merged);
      return merged;
    },
    [store],
  );

  // Single initial fetch on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Single `settings-changed` listener for the whole app: any save anywhere
  // (this window or another) re-fetches and refreshes the store.
  useTauriEvent<unknown>(
    "settings-changed",
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const value = useMemo<SettingsContextValue>(
    () => ({ store, refresh, updateSettings }),
    [store, refresh, updateSettings],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a <SettingsProvider>");
  }
  return ctx;
}

/**
 * The full settings blob (or null until the first fetch resolves). Re-renders
 * on any settings change — use for a component that genuinely reads many
 * fields. Prefer `useSettingsField` when you only need one slice.
 */
export function useSettings(): AppSettings | null {
  const { store } = useSettingsContext();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Select a slice of the settings blob, re-rendering only when that slice
 * changes (referential equality via `Object.is`, matching React's default).
 * Pass a stable selector (e.g. a top-level field accessor) — the selector is
 * applied to the current snapshot on every store notification.
 *
 * The selector receives `null` while settings are still loading, so callers
 * supply their own default (e.g. `(s) => s?.custom_backends ?? []`).
 */
export function useSettingsField<T>(
  selector: (settings: AppSettings | null) => T,
): T {
  const { store } = useSettingsContext();
  // `useSyncExternalStore` requires getSnapshot to return a referentially
  // STABLE value between calls when nothing changed — otherwise it loops
  // forever. Selectors commonly mint a fresh default (e.g. `?? []`) on every
  // call, which is never `Object.is`-equal to the prior result, so caching on
  // the OUTPUT can't break the loop. Instead memoize on the INPUT: the store
  // hands out a new settings object reference only on a real change, so we
  // re-run the selector only when that reference changes and otherwise return
  // the cached result. A second `Object.is` guard collapses selectors that DO
  // return a stable primitive/reference, so a slice that didn't change won't
  // trigger a re-render.
  //
  // The cache is also keyed on the SELECTOR identity: a re-render that passes a
  // new selector closure (e.g. one that closes over changed props/state and so
  // selects a different slice) must re-run that selector even if the settings
  // blob reference is unchanged. Including `selector` in the getSnapshot deps
  // gives getSnapshot a fresh identity on a selector change, which is what
  // makes `useSyncExternalStore` re-invoke it (a pinned-ref selector would be
  // read only on a store notification, never on a pure prop/state re-render).
  const cacheRef = useRef<{
    selector: (settings: AppSettings | null) => T;
    input: AppSettings | null;
    value: T;
  } | null>(null);
  const getSnapshot = useCallback(() => {
    const input = store.get();
    const cached = cacheRef.current;
    if (
      cached &&
      Object.is(cached.selector, selector) &&
      Object.is(cached.input, input)
    ) {
      return cached.value;
    }
    const next = selector(input);
    if (cached && Object.is(cached.value, next)) {
      // Value is unchanged even though the input/selector reference moved —
      // keep the old reference so dependent memos/effects don't see a phantom
      // change.
      cacheRef.current = { selector, input, value: cached.value };
      return cached.value;
    }
    cacheRef.current = { selector, input, value: next };
    return next;
  }, [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * A stable getter for the latest settings blob, for handlers that must read
 * the freshest value at the moment of an async action (the old pattern was
 * `const s = await api.settingsGet()` inside the handler). Reading from the
 * store is synchronous and avoids both a redundant IPC round-trip and the
 * Keychain prompt some `settings_get` paths can trigger. Falls back to a
 * one-shot fetch if the store hasn't hydrated yet, preserving the guarantee
 * that the handler sees a real blob.
 */
export function useSettingsGetter(): () => Promise<AppSettings> {
  const { store, refresh } = useSettingsContext();
  return useCallback(async () => {
    const cached = store.get();
    if (cached) return cached;
    const fetched = await refresh();
    if (fetched) return fetched;
    // Refresh swallowed an error and there's no cache — fall back to a direct
    // read so the caller still gets a blob (or its rejection) as before.
    return api.settingsGet();
  }, [store, refresh]);
}

/** Imperative access to the persist path without a field subscription. */
export function useUpdateSettings(): (
  patch: Partial<AppSettings>,
) => Promise<AppSettings> {
  return useSettingsContext().updateSettings;
}

/**
 * A stable, empty store used by `useSettingsFieldOptional` when there is NO
 * `<SettingsProvider>` above the caller. It never notifies and always reports a
 * `null` blob, so the selector resolves to its caller-supplied default. This
 * keeps `useSyncExternalStore` happy (a referentially-stable getSnapshot) while
 * letting a component that lives inside the provider in production still render
 * standalone in a unit test without one — no provider boilerplate per test.
 */
const NULL_STORE: SettingsStore = {
  get: () => null,
  subscribe: () => () => {},
  set: () => {},
};

/**
 * Provider-OPTIONAL variant of {@link useSettingsField}. Identical behaviour
 * when a `<SettingsProvider>` is present; when it is ABSENT, the selector is
 * applied to a permanent `null` blob (so the caller's `?? default` wins) instead
 * of throwing. Use for a component that always sits inside the provider in the
 * real app but is unit-tested in isolation — it reads the real setting in
 * production and degrades to the default in a bare test harness.
 */
export function useSettingsFieldOptional<T>(
  selector: (settings: AppSettings | null) => T,
): T {
  const ctx = useContext(SettingsContext);
  const store = ctx?.store ?? NULL_STORE;
  const cacheRef = useRef<{
    selector: (settings: AppSettings | null) => T;
    input: AppSettings | null;
    value: T;
  } | null>(null);
  const getSnapshot = useCallback(() => {
    const input = store.get();
    const cached = cacheRef.current;
    if (
      cached &&
      Object.is(cached.selector, selector) &&
      Object.is(cached.input, input)
    ) {
      return cached.value;
    }
    const next = selector(input);
    if (cached && Object.is(cached.value, next)) {
      cacheRef.current = { selector, input, value: cached.value };
      return cached.value;
    }
    cacheRef.current = { selector, input, value: next };
    return next;
  }, [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
