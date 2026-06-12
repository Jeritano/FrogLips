/**
 * User-message chat-bubble color. A device-local cosmetic preference
 * (localStorage, no Rust round-trip), applied by setting the
 * `--user-bubble` custom property on <html>. The chat CSS reads it as
 * `var(--user-bubble, var(--accent))`, so "Default" simply clears the
 * property and falls back to the app accent.
 */

export const BUBBLE_COLORS: ReadonlyArray<{
  name: string;
  value: string | null;
}> = [
  { name: "Default", value: null }, // falls back to --accent
  { name: "Indigo", value: "#6366f1" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Emerald", value: "#10b981" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Orange", value: "#f97316" },
  { name: "Rose", value: "#f43f5e" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Slate", value: "#64748b" },
  { name: "Graphite", value: "#3f3f46" },
];

const STORAGE_KEY = "froglips.bubbleColor";

/** Current bubble color (hex) or null for the accent default. */
export function getBubbleColor(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v == null || v === "") return null;
    // Only honor a value that's in the curated palette — guards against a
    // stale/garbage localStorage entry injecting an arbitrary CSS string.
    return BUBBLE_COLORS.some((c) => c.value === v) ? v : null;
  } catch {
    return null;
  }
}

/** Persist + apply a bubble color. `null` clears it (accent default). */
export function setBubbleColor(value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private-mode / quota — still apply in-memory */
  }
  applyBubbleColor(value);
}

/** Write (or clear) the `--user-bubble` property. Call once on app start. */
export function applyBubbleColor(
  value: string | null = getBubbleColor(),
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (value == null) root.style.removeProperty("--user-bubble");
  else root.style.setProperty("--user-bubble", value);
}
