/**
 * Appearance preferences — device-local cosmetic settings persisted in
 * localStorage (no Rust round-trip needed). Consolidates:
 *   - code-block syntax palettes, chosen INDEPENDENTLY for light + dark app
 *     themes (the active one is written to `dataset.syntaxTheme`, which
 *     `styles/syntax.css` already keys off),
 *   - a custom monospace code font (overrides the `--mono` token),
 *   - the interface font family (`--ui-font`),
 *   - transcript text size (`dataset.transcriptSize`),
 *   - a high-contrast dark theme (`dataset.highContrast`).
 *
 * Mirrors the layout of the Claude Code "Appearance" settings.
 */

import { SYNTAX_THEMES, type SyntaxThemeId } from "./syntax-theme";

export { SYNTAX_THEMES };
export type { SyntaxThemeId };
/** The CONCRETE app theme actually applied to `<html data-theme>` and keyed by
 *  every CSS rule. Always one of these two — `"system"` is a *preference* that
 *  resolves to one of these via `matchMedia`. */
export type Mode = "light" | "dark";
/** The user's theme PREFERENCE. `"system"` follows the OS appearance and live-
 *  updates; the other two pin a concrete theme. Persisted in settings.json
 *  (`theme`) + mirrored to localStorage for the synchronous pre-render read. */
export type ThemePref = "light" | "dark" | "system";

/* ── System-theme resolution ───────────────────────────────────────────────
 *
 * The app's CSS keys entirely off `:root[data-theme="light"|"dark"]`, so the
 * concrete theme on `<html>` must always be one of those two. `"system"` is a
 * preference layered on top: it resolves to light/dark from the OS via
 * `matchMedia('(prefers-color-scheme: dark)')` and live-updates when the OS
 * appearance flips. We persist the PREFERENCE (so a System user stays System
 * across launches) but mirror the RESOLVED concrete theme into the legacy
 * `froglips-theme` key the three entry points already read synchronously
 * before first paint — keeping the no-flash boot path working unchanged.
 */

/** Legacy mirror key holding the RESOLVED concrete theme (light|dark) for the
 *  synchronous pre-render read in the entry points. Kept for back-compat. */
const THEME_MIRROR_KEY = "froglips-theme";
/** New key holding the user's PREFERENCE (light|dark|system) so a System user
 *  is restored as System (not as whatever concrete value we last resolved). */
const THEME_PREF_KEY = "froglips-theme-pref";

const DARK_MQ = "(prefers-color-scheme: dark)";

/** Resolve a preference to a concrete light/dark theme. `"system"` reads the
 *  OS appearance; SSR / no-matchMedia falls back to dark (the app default). */
export function resolveTheme(pref: ThemePref): Mode {
  if (pref === "light" || pref === "dark") return pref;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia(DARK_MQ).matches ? "dark" : "light";
}

/** Validate an arbitrary value as a ThemePref (settings/localStorage strings). */
export function isThemePref(v: unknown): v is ThemePref {
  return v === "light" || v === "dark" || v === "system";
}

/** Read the persisted preference (localStorage mirror). Defaults to "system" so
 *  a fresh install follows the OS; legacy installs that only stored a concrete
 *  `froglips-theme` fall back to that value (preserving their explicit choice). */
export function getThemePref(): ThemePref {
  try {
    const p = localStorage.getItem(THEME_PREF_KEY);
    if (isThemePref(p)) return p;
    // Legacy: a concrete value was mirrored before System existed — honor it as
    // an explicit pin rather than silently switching the user to System.
    const legacy = localStorage.getItem(THEME_MIRROR_KEY);
    if (legacy === "light" || legacy === "dark") return legacy;
  } catch {
    /* localStorage unavailable */
  }
  return "system";
}

/** Persist the preference + mirror the resolved concrete theme for pre-render. */
export function writeThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_PREF_KEY, pref);
    localStorage.setItem(THEME_MIRROR_KEY, resolveTheme(pref));
  } catch {
    /* best-effort */
  }
}

/** Apply a preference to `<html data-theme>` (resolving System → light/dark)
 *  and return the concrete theme applied. Does NOT persist. */
export function applyThemePref(pref: ThemePref): Mode {
  const resolved = resolveTheme(pref);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
  }
  return resolved;
}

/**
 * Subscribe to OS appearance changes while the preference is "system". Calls
 * `onChange(resolved)` whenever the OS flips light↔dark. Returns an unsubscribe
 * fn (no-op when matchMedia is unavailable). The caller is responsible for only
 * subscribing while the preference is actually "system".
 */
export function watchSystemTheme(onChange: (resolved: Mode) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_MQ);
  const handler = (e: MediaQueryListEvent) =>
    onChange(e.matches ? "dark" : "light");
  // addEventListener is supported on every browser we target; the legacy
  // addListener fallback is unnecessary for a modern WKWebView.
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

const lsKey = (k: string) => `froglips.${k}`;
function read(k: string): string | null {
  try {
    return localStorage.getItem(lsKey(k));
  } catch {
    return null;
  }
}
function write(k: string, v: string | null): void {
  try {
    if (v == null) localStorage.removeItem(lsKey(k));
    else localStorage.setItem(lsKey(k), v);
  } catch {
    /* private-mode / quota — apply in-memory only */
  }
}

function isPalette(v: string | null): v is SyntaxThemeId {
  return v != null && SYNTAX_THEMES.some((t) => t.id === v);
}

function currentAppTheme(): Mode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/* ── Code-block palette, per app theme ─────────────────────────────────── */

/** Palette id chosen for `mode`. Falls back to the legacy single
 *  `froglips.syntaxTheme` value (so existing users keep their choice), then
 *  to the GitHub-style default. */
export function getCodeTheme(mode: Mode): SyntaxThemeId {
  const v = read(`codeTheme.${mode}`);
  if (isPalette(v)) return v;
  const legacy = read("syntaxTheme");
  return isPalette(legacy) ? legacy : "auto";
}

export function setCodeTheme(mode: Mode, id: SyntaxThemeId): void {
  write(`codeTheme.${mode}`, id);
  // Only the ACTIVE theme's palette is live; re-apply if it changed.
  if (mode === currentAppTheme()) applyCodeTheme();
}

/** Write the active app theme's palette to `dataset.syntaxTheme` (the attribute
 *  `syntax.css` reads). Call on startup and whenever the app theme flips. */
export function applyCodeTheme(appTheme: Mode = currentAppTheme()): void {
  if (typeof document === "undefined") return;
  const id = getCodeTheme(appTheme);
  if (id === "auto") delete document.documentElement.dataset.syntaxTheme;
  else document.documentElement.dataset.syntaxTheme = id;
}

/* ── Code font (overrides --mono) ──────────────────────────────────────── */

const DEFAULT_MONO = '"SF Mono", Menlo, Consolas, monospace';

export function getCodeFont(): string {
  return read("codeFont") ?? "";
}

export function setCodeFont(name: string): void {
  const v = name.trim();
  write("codeFont", v || null);
  applyCodeFont();
}

export function applyCodeFont(): void {
  if (typeof document === "undefined") return;
  const v = getCodeFont().replace(/["\\;{}]/g, ""); // sanitize before CSS injection
  if (v)
    document.documentElement.style.setProperty(
      "--mono",
      `"${v}", ${DEFAULT_MONO}`,
    );
  else document.documentElement.style.removeProperty("--mono");
}

/* ── Interface font ────────────────────────────────────────────────────── */

export type UiFont = "froglips" | "system";
const UI_FONT_STACK: Record<UiFont, string> = {
  froglips:
    '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

export function getUiFont(): UiFont {
  return read("uiFont") === "system" ? "system" : "froglips";
}

export function setUiFont(v: UiFont): void {
  write("uiFont", v);
  applyUiFont();
}

export function applyUiFont(): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--ui-font",
    UI_FONT_STACK[getUiFont()],
  );
}

/* ── Transcript text size ──────────────────────────────────────────────── */

export type TranscriptSize = "small" | "medium" | "large";

export function getTranscriptSize(): TranscriptSize {
  const v = read("transcriptSize");
  return v === "small" || v === "large" ? v : "medium";
}

export function setTranscriptSize(v: TranscriptSize): void {
  write("transcriptSize", v);
  applyTranscriptSize();
}

export function applyTranscriptSize(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.transcriptSize = getTranscriptSize();
}

/* ── High-contrast dark theme ──────────────────────────────────────────── */

export function getHighContrast(): boolean {
  return read("highContrast") === "1";
}

export function setHighContrast(on: boolean): void {
  write("highContrast", on ? "1" : null);
  applyHighContrast();
}

export function applyHighContrast(): void {
  if (typeof document === "undefined") return;
  if (getHighContrast()) document.documentElement.dataset.highContrast = "1";
  else delete document.documentElement.dataset.highContrast;
}

/* ── Apply everything (startup) ────────────────────────────────────────── */

export function applyAllAppearance(appTheme?: Mode): void {
  applyCodeTheme(appTheme);
  applyCodeFont();
  applyUiFont();
  applyTranscriptSize();
  applyHighContrast();
}
