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
export type Mode = "light" | "dark";

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
