import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, McpServerConfig } from "../../types";
import {
  readCachedConfigs,
  reconcileConfigs,
  persistConfigs,
} from "../mcp-servers";

/*
 * The split-brain fix: settings.json is authoritative, localStorage is a
 * pre-paint cache only. These pin the reconcile/migration logic so a profile
 * predating the change can't lose its configured servers, and so a stale cache
 * can't resurrect a server the settings.json truth no longer lists.
 */

// The test runtime's global `localStorage` (Node's experimental, file-backed
// Web Storage) only partially implements the Storage API (clear() throws).
// Install a clean in-memory Storage so the helpers and assertions share one
// deterministic store (matching usePersistedState's test harness).
const __store = new Map<string, string>();
const memoryStorage: Storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k)! : null),
  setItem: (k, v) => {
    __store.set(k, String(v));
  },
  removeItem: (k) => {
    __store.delete(k);
  },
  clear: () => {
    __store.clear();
  },
  key: (i) => Array.from(__store.keys())[i] ?? null,
  get length() {
    return __store.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: memoryStorage,
  configurable: true,
});

const LS_KEY = "mcp.servers";

const SRV = (name: string, command = "npx"): McpServerConfig => ({
  name,
  command,
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("readCachedConfigs", () => {
  it("returns [] when the cache is empty", () => {
    expect(readCachedConfigs()).toEqual([]);
  });

  it("parses a well-formed cached list", () => {
    localStorage.setItem(LS_KEY, JSON.stringify([SRV("fs"), SRV("git")]));
    expect(readCachedConfigs().map((c) => c.name)).toEqual(["fs", "git"]);
  });

  it("drops malformed entries and never throws on garbage", () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify([SRV("ok"), { command: "x" }, "nope", null]),
    );
    expect(readCachedConfigs().map((c) => c.name)).toEqual(["ok"]);
  });

  it("falls back to [] on corrupt JSON", () => {
    localStorage.setItem(LS_KEY, "{not json");
    expect(readCachedConfigs()).toEqual([]);
  });
});

describe("reconcileConfigs", () => {
  it("settings.json wins when it has servers, and refreshes the cache", () => {
    localStorage.setItem(LS_KEY, JSON.stringify([SRV("stale")]));
    const settings: AppSettings = { mcp_servers: [SRV("fs"), SRV("git")] };
    const { configs, migrated } = reconcileConfigs(settings);
    expect(migrated).toBe(false);
    expect(configs.map((c) => c.name)).toEqual(["fs", "git"]);
    // Cache mirrors the authoritative set (stale entry gone).
    expect(readCachedConfigs().map((c) => c.name)).toEqual(["fs", "git"]);
  });

  it("adopts the cache (migrated=true) when settings.json is empty", () => {
    localStorage.setItem(LS_KEY, JSON.stringify([SRV("legacy")]));
    const { configs, migrated } = reconcileConfigs({ mcp_servers: [] });
    expect(migrated).toBe(true);
    expect(configs.map((c) => c.name)).toEqual(["legacy"]);
  });

  it("adopts the cache when settings.json has no mcp_servers field", () => {
    localStorage.setItem(LS_KEY, JSON.stringify([SRV("legacy")]));
    const { configs, migrated } = reconcileConfigs({});
    expect(migrated).toBe(true);
    expect(configs.map((c) => c.name)).toEqual(["legacy"]);
  });

  it("returns [] and clears the cache when both are empty", () => {
    localStorage.setItem(LS_KEY, JSON.stringify([]));
    const { configs, migrated } = reconcileConfigs({ mcp_servers: [] });
    expect(migrated).toBe(false);
    expect(configs).toEqual([]);
    expect(readCachedConfigs()).toEqual([]);
  });

  it("treats a null settings (settings_get failed) as empty → cache fallback", () => {
    localStorage.setItem(LS_KEY, JSON.stringify([SRV("legacy")]));
    const { configs, migrated } = reconcileConfigs(null);
    expect(migrated).toBe(true);
    expect(configs.map((c) => c.name)).toEqual(["legacy"]);
  });
});

describe("persistConfigs", () => {
  it("writes settings.json (authoritative) and mirrors the cache", async () => {
    const update = vi.fn(async (patch: Partial<AppSettings>) => patch as AppSettings);
    const list = [SRV("fs")];
    await persistConfigs(list, update);
    expect(update).toHaveBeenCalledWith({ mcp_servers: list });
    expect(readCachedConfigs().map((c) => c.name)).toEqual(["fs"]);
  });

  it("still updates the cache when the settings write rejects", async () => {
    const update = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const list = [SRV("fs")];
    await expect(persistConfigs(list, update)).resolves.toBeUndefined();
    // Cache was written before the (failed) settings_set, so the in-session
    // list and next pre-paint stay consistent.
    expect(readCachedConfigs().map((c) => c.name)).toEqual(["fs"]);
  });
});
