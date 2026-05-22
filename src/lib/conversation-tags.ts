// Conversation tags are persisted as a raw JSON array string in the
// `conversations.tags` column. These helpers decode/encode defensively so a
// malformed value never throws into the render path.

/** Parse a raw tags JSON string into a clean, de-duplicated string array. */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of parsed) {
      if (typeof t !== "string") continue;
      const v = t.trim();
      if (v && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        out.push(v);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Encode a tag array back to a JSON string, or null when empty. */
export function encodeTags(tags: string[]): string | null {
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const v = t.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      clean.push(v);
    }
  }
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

/** Split a comma/whitespace-separated user string into tags. */
export function tagsFromInput(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}
