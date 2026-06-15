/* ── Auto-update check ───────────────────────────────────────────────────────
 *
 * Thin wrapper over @tauri-apps/plugin-updater. A check surfaces a tasteful
 * "update available" affordance; it NEVER auto-downloads.
 *
 * Outcome contract (so callers can tell the three cases apart instead of
 * collapsing them all into a silent null):
 *   - resolves to an `UpdateInfo`  → an update is available.
 *   - resolves to `null`           → genuinely up to date.
 *   - rejects (throws)             → the check itself FAILED (offline, endpoint
 *                                    unreachable, manifest not hosted yet, dev
 *                                    build without the plugin). The error is
 *                                    logged to diagnostics here AND re-thrown so
 *                                    the caller can surface it. The manual
 *                                    "Check for updates" button shows it; the
 *                                    background poll swallows it (best-effort).
 */

import { logDiag } from "./diagnostics";

export interface UpdateInfo {
  version: string;
  /** Download + install the update, then relaunch. */
  install: () => Promise<void>;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  let update: Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    update = await check();
  } catch (err) {
    // Endpoint unreachable / offline / dev build / private-repo manifest not
    // yet hosted. Log it, then re-throw so a manual check can report "Update
    // failed" instead of mislabeling the failure as "Up to date." Background
    // callers catch this and stay silent.
    logDiag({
      level: "warn",
      source: "updater",
      message: "update check failed (endpoint unreachable or offline)",
      detail: err,
    });
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (!update) return null;
  return {
    version: update.version,
    install: async () => {
      await update.downloadAndInstall();
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (e) {
        logDiag({
          level: "warn",
          source: "updater",
          message:
            "relaunch after install failed — restart manually to finish updating",
          detail: e,
        });
      }
    },
  };
}
