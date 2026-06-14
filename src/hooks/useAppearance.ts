import { useState } from "react";
import { api } from "../lib/tauri-api";
import { applyCodeTheme } from "../lib/appearance";
import { logDiag } from "../lib/diagnostics";

type Theme = "dark" | "light";

/**
 * App theme (light/dark) state + the toggle/persist plumbing that used to live
 * inline in `App`. Owns the `theme` value, mirrors it onto `<html data-theme>`
 * and `localStorage` (so `main.tsx`'s synchronous pre-render read keeps the
 * first frame on the right theme), re-applies the per-theme syntax palette, and
 * persists to settings.
 *
 * `applyPersistedTheme` is called from App's startup `settingsGet` effect to
 * apply the saved theme WITHOUT re-persisting it (the value just came from the
 * store) and without re-applying the code palette (the startup path calls
 * `applyAllAppearance()` separately, exactly as before).
 */
export function useAppearance(): {
  theme: Theme;
  toggleTheme: () => void;
  /** Apply a theme value read from persisted settings on startup. */
  applyPersistedTheme: (theme: Theme) => void;
} {
  const [theme, setTheme] = useState<Theme>("dark");

  function applyPersistedTheme(next: Theme) {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    // Mirror for main.tsx's synchronous pre-render read (perf C8) —
    // keeps the first frame on the right theme next launch.
    try {
      localStorage.setItem("froglips-theme", next);
    } catch {
      /* best-effort */
    }
  }

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    // Mirror for main.tsx's synchronous pre-render read (perf C8).
    try {
      localStorage.setItem("froglips-theme", next);
    } catch {
      /* best-effort */
    }
    // Re-apply the code palette chosen for the NEW app theme (light/dark each
    // carry their own syntax-palette pick).
    applyCodeTheme(next);
    api.settingsSet({ theme: next }).catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "settingsSet(theme) failed — UI updated but not persisted",
        detail: err,
      }),
    );
  }

  return { theme, toggleTheme, applyPersistedTheme };
}
