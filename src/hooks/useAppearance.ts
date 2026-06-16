import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import {
  applyCodeTheme,
  applyThemePref,
  getThemePref,
  isThemePref,
  resolveTheme,
  watchSystemTheme,
  writeThemePref,
  type Mode,
  type ThemePref,
} from "../lib/appearance";
import { logDiag } from "../lib/diagnostics";

/**
 * App theme state + the toggle/persist plumbing that used to live inline in
 * `App`. Owns BOTH the user's PREFERENCE (`light` | `dark` | `system`) and the
 * RESOLVED concrete theme (`light` | `dark`) that is mirrored onto
 * `<html data-theme>` and consumed by every CSS rule.
 *
 * `theme` is the resolved concrete value (so existing consumers — the moon
 * button, AppearanceModal/SettingsModal sun/moon labels, per-theme syntax
 * palette — keep working unchanged). `themePref` is the new tri-state used to
 * render the System / Light / Dark selector.
 *
 * When the preference is `"system"` we subscribe to
 * `matchMedia('(prefers-color-scheme: dark)')` and live-update the applied theme
 * on every OS appearance flip. The localStorage mirror (`froglips-theme`) is
 * kept current so `main.tsx`'s synchronous pre-render read keeps the first frame
 * on the right theme next launch; the new `froglips-theme-pref` key restores a
 * System user as System rather than as the last concrete value.
 *
 * `applyPersistedTheme` is called from App's startup `settingsGet` effect to
 * apply the saved preference WITHOUT re-persisting it (the value just came from
 * the store).
 */
export function useAppearance(): {
  /** Resolved concrete theme applied to <html data-theme> (light | dark). */
  theme: Mode;
  /** User's preference (light | dark | system). */
  themePref: ThemePref;
  /** Cycle light → dark (toggling the legacy sun/moon button). A System
   *  preference toggles to the OPPOSITE of the currently-resolved theme,
   *  pinning a concrete value (the user expressed an explicit intent). */
  toggleTheme: () => void;
  /** Set an explicit preference (the System / Light / Dark selector). */
  setThemePref: (pref: ThemePref) => void;
  /** Apply a preference value read from persisted settings on startup. */
  applyPersistedTheme: (pref: ThemePref) => void;
} {
  const [themePref, setThemePrefState] = useState<ThemePref>(() =>
    getThemePref(),
  );
  const [theme, setTheme] = useState<Mode>(() => resolveTheme(getThemePref()));

  // Persist + apply a preference, returning the resolved concrete theme.
  const persist = useCallback((pref: ThemePref) => {
    setThemePrefState(pref);
    writeThemePref(pref);
    const resolved = applyThemePref(pref);
    setTheme(resolved);
    // Re-apply the code palette chosen for the NEW resolved app theme
    // (light/dark each carry their own syntax-palette pick).
    applyCodeTheme(resolved);
    api.settingsSet({ theme: pref }).catch((err) =>
      logDiag({
        level: "warn",
        source: "app",
        message: "settingsSet(theme) failed — UI updated but not persisted",
        detail: err,
      }),
    );
    return resolved;
  }, []);

  function applyPersistedTheme(pref: ThemePref) {
    // Came FROM the store — apply + mirror, but don't re-persist.
    setThemePrefState(pref);
    writeThemePref(pref);
    const resolved = applyThemePref(pref);
    setTheme(resolved);
  }

  function setThemePref(pref: ThemePref) {
    persist(pref);
  }

  function toggleTheme() {
    // Toggling from the legacy button pins a concrete value: from System we
    // flip to the opposite of whatever is currently showing.
    const next: ThemePref = theme === "dark" ? "light" : "dark";
    persist(next);
  }

  // Live-update on OS appearance change while following the system. Re-subscribe
  // whenever the preference changes; the listener is a no-op (unsubscribed)
  // unless the preference is "system".
  useEffect(() => {
    if (themePref !== "system") return;
    const unsubscribe = watchSystemTheme((resolved) => {
      document.documentElement.dataset.theme = resolved;
      // Keep the pre-render mirror current so next launch matches the OS.
      writeThemePref("system");
      setTheme(resolved);
      applyCodeTheme(resolved);
    });
    return unsubscribe;
  }, [themePref]);

  return {
    theme,
    themePref,
    toggleTheme,
    setThemePref,
    applyPersistedTheme,
  };
}

/** Re-exported so callers needn't import from two modules. */
export { isThemePref };
