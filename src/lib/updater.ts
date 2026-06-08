/* ── Auto-update check ───────────────────────────────────────────────────────
 *
 * Thin, DEFENSIVE wrapper over @tauri-apps/plugin-updater. A background check
 * surfaces a tasteful "update available" affordance; it NEVER auto-downloads and
 * NEVER throws into the UI. If the endpoint is unreachable (e.g. the release
 * manifest isn't publicly hosted yet), offline, or the plugin is unavailable in
 * a dev build, it silently returns null — the check is best-effort.
 */

import { logDiag } from "./diagnostics";

export interface UpdateInfo {
  version: string;
  /** Download + install the update, then relaunch. */
  install: () => Promise<void>;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
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
            message: "relaunch after install failed — restart manually to finish updating",
            detail: e,
          });
        }
      },
    };
  } catch (err) {
    // Endpoint unreachable / offline / dev build / private-repo manifest not
    // yet hosted. Best-effort — log at info, never surface.
    logDiag({
      level: "info",
      source: "updater",
      message: "update check skipped (endpoint unreachable or offline)",
      detail: err,
    });
    return null;
  }
}
