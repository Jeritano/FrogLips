import type { AppSettings, McpServerConfig } from "../types";
import { logDiag } from "./diagnostics";

/* ── MCP server config: settings.json is the source of truth ───────────────
 *
 * History: `mcp.servers` lived in BOTH `localStorage` and `settings.json`,
 * dual-written, with localStorage as the authoritative READ path. That split
 * brain meant a server added in one window (or restored from settings.json on
 * a fresh profile) could be invisible until localStorage caught up.
 *
 * Now `settings.json` (the Rust `Settings`) is authoritative. `localStorage`
 * is demoted to a pre-paint cache — exactly the role `froglips-theme` plays
 * for the theme: a synchronous read so the Installed list isn't empty for the
 * one frame before the async `settings_get` resolves. Every write goes to
 * settings.json first; the cache is only a mirror.
 *
 * Migration is lossless: `reconcileConfigs` reads the cache once and, if
 * settings.json has no servers but the cache does (a profile that pre-dates
 * this change, or whose settings.json was reset), it adopts the cached list as
 * the migration source so nothing the user configured is dropped.
 */

const LS_KEY = "mcp.servers";

/** Parse a raw `mcp.servers` JSON string into a config array (or null). */
function parseConfigs(raw: string | null): McpServerConfig[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (s): s is McpServerConfig =>
        !!s && typeof s === "object" && typeof s.name === "string",
    );
  } catch {
    return null;
  }
}

/**
 * Synchronous pre-paint read of the cached MCP server list. Used as the
 * `useState` initializer so the Installed list paints immediately, before the
 * authoritative `settings_get` resolves. Malformed cache → `[]` (never throws).
 */
export function readCachedConfigs(): McpServerConfig[] {
  try {
    return parseConfigs(localStorage.getItem(LS_KEY)) ?? [];
  } catch (err) {
    logDiag({
      level: "warn",
      source: "mcp",
      message: "readCachedConfigs: malformed localStorage 'mcp.servers'",
      detail: err,
    });
    return [];
  }
}

/** Mirror the authoritative list into the pre-paint cache. Best-effort. */
function writeCache(list: McpServerConfig[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* quota / private-mode — the cache is best-effort, settings.json is truth */
  }
}

/**
 * Reconcile the authoritative settings.json value against the legacy cache and
 * return the canonical server list.
 *
 * - settings.json has servers → it wins; refresh the cache to match.
 * - settings.json empty/absent but the cache has servers → adopt the cache as
 *   a one-time migration (the caller persists it back via `persistConfigs`),
 *   so a profile predating the settings.json-authoritative model isn't wiped.
 * - both empty → `[]`.
 *
 * `migrated` is true only in the adopt-from-cache case, signalling the caller
 * to write the list back into settings.json so the migration sticks.
 */
export function reconcileConfigs(settings: AppSettings | null): {
  configs: McpServerConfig[];
  migrated: boolean;
} {
  const fromSettings = settings?.mcp_servers ?? null;
  if (fromSettings && fromSettings.length > 0) {
    writeCache(fromSettings);
    return { configs: fromSettings, migrated: false };
  }
  // settings.json has nothing — fall back to the legacy cache, if any.
  const cached = readCachedConfigs();
  if (cached.length > 0) {
    return { configs: cached, migrated: true };
  }
  // Both empty: keep settings.json (an explicit empty list) as truth and make
  // sure the cache reflects it so a stale non-empty cache can't resurrect.
  writeCache([]);
  return { configs: [], migrated: false };
}

/**
 * Persist the authoritative MCP server list: write settings.json (truth) via
 * the central store updater, then mirror to the pre-paint cache. The cache is
 * written even if the settings write rejects, so the in-session list and the
 * next pre-paint stay consistent with what the user sees (settings.json
 * reconciles on the next successful save / `settings-changed`).
 */
export async function persistConfigs(
  list: McpServerConfig[],
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>,
): Promise<void> {
  writeCache(list);
  try {
    await updateSettings({ mcp_servers: list });
  } catch (err) {
    logDiag({
      level: "warn",
      source: "mcp",
      message: "persistConfigs: settings_set failed",
      detail: err,
    });
  }
}
