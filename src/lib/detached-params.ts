/**
 * Parse the `?detached=1&conversation_id=NN` query string used by detached
 * conversation windows. Returns `null` when the URL is *not* a detached
 * window, which signals `main.tsx` to render the full `App` shell.
 *
 * Extracted into its own module so it can be unit-tested without a DOM:
 * happy-dom's URL handling matches the browser closely enough for parsing,
 * but isolating the function keeps the test free of React-mount boilerplate.
 */
export interface DetachedParams {
  conversationId: number;
}

export function parseDetachedParams(search: string): DetachedParams | null {
  // URLSearchParams accepts a leading "?" or a bare key=value string.
  const params = new URLSearchParams(search);
  if (params.get("detached") !== "1") return null;
  const raw = params.get("conversation_id");
  if (raw == null) return null;
  // Strict integer parse: reject NaN, floats, and non-numeric strings.
  // The conv id is the SQLite rowid (autoincrement int), so allow any
  // signed integer including negatives — the backend validates further.
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return { conversationId: n };
}
