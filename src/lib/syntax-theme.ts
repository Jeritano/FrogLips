/**
 * Syntax-highlight palette selection. Independent of the app light/dark
 * theme — each palette in `styles/syntax.css` defines both a dark and a
 * light variant, so the chosen palette stays readable when the user flips
 * the app theme.
 *
 * Persisted in localStorage (a pure-cosmetic, device-local preference —
 * no need to round-trip through the Rust settings store). Applied by
 * writing `documentElement.dataset.syntaxTheme`, which the CSS keys off.
 */

export const SYNTAX_THEMES = [
  { id: "auto", label: "Default (GitHub)" },
  { id: "vivid", label: "Vivid (high contrast)" },
  { id: "mono", label: "Monochrome" },
] as const;

export type SyntaxThemeId = (typeof SYNTAX_THEMES)[number]["id"];

const STORAGE_KEY = "froglips.syntaxTheme";
const DEFAULT: SyntaxThemeId = "auto";

function isValid(v: string | null): v is SyntaxThemeId {
  return v != null && SYNTAX_THEMES.some((t) => t.id === v);
}

/** Current palette id from storage (or the default). */
export function getSyntaxTheme(): SyntaxThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isValid(v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Persist + apply a palette. `auto` clears the dataset attribute so the
 *  CSS falls back to the theme-aware default block. */
export function setSyntaxTheme(id: SyntaxThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private-mode / quota — apply in-memory anyway */
  }
  applySyntaxTheme(id);
}

/** Write the dataset attribute the CSS reads. Call once on app start. */
export function applySyntaxTheme(id: SyntaxThemeId = getSyntaxTheme()): void {
  if (typeof document === "undefined") return;
  if (id === "auto") {
    delete document.documentElement.dataset.syntaxTheme;
  } else {
    document.documentElement.dataset.syntaxTheme = id;
  }
}
