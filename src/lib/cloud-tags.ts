/* ── Ollama Cloud pull-tag resolution ────────────────────────────────────────
 *
 * Ollama "cloud" models are NOT pulled as a bare `<name>:cloud`. The tag is
 * model-specific: some use a generic `<name>:cloud` alias (glm-4.6:cloud,
 * deepseek-r1:cloud, qwen3-max:cloud), but the big size-tagged ones use
 * `<name>:<size>-cloud` (gpt-oss:120b-cloud, qwen3-coder:480b-cloud,
 * deepseek-v3.1:671b-cloud). The library view used to always build
 * `<name>:cloud`, which 404s the manifest ("pull model manifest: file does not
 * exist") for every size-tagged cloud model.
 *
 * Resolution order:
 *   1. KNOWN map — hand-verified tags against ollama.com (the same ones the
 *      curated catalog ships). Authoritative; overrides the heuristic.
 *   2. Largest-advertised-size heuristic — `<name>:<largest>-cloud`. For the
 *      size-tagged models this independently produces the right tag from the
 *      scraped size chips (gpt-oss 20b/120b → 120b-cloud; qwen3-coder 30b/480b
 *      → 480b-cloud).
 *   3. Bare `<name>:cloud` — last resort for cloud models with no size chips.
 */

/** base family name → verified cloud pull id. */
export const KNOWN_CLOUD_TAGS: Record<string, string> = {
  "kimi-k2-thinking": "kimi-k2-thinking:cloud",
  "kimi-k2.6": "kimi-k2.6:cloud",
  "kimi-k2.5": "kimi-k2.5:cloud",
  "deepseek-v4-pro": "deepseek-v4-pro:cloud",
  "deepseek-v3.1": "deepseek-v3.1:671b-cloud",
  "deepseek-r1": "deepseek-r1:cloud",
  "qwen3-coder": "qwen3-coder:480b-cloud",
  "qwen3-max": "qwen3-max:cloud",
  "gpt-oss": "gpt-oss:120b-cloud",
  "glm-4.6": "glm-4.6:cloud",
  "minimax-m2": "minimax-m2:cloud",
};

/** Parse a size chip ("480b", "120b", "1.5b", "1t") into a comparable number of
 * billions. Returns null for anything that doesn't look like a param size. */
function sizeToBillions(s: string): number | null {
  const m = /^([\d.]+)\s*([bt])$/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2].toLowerCase() === "t" ? n * 1000 : n;
}

/** Pick the largest advertised size token (normalized lowercase, no spaces). */
function largestSizeToken(sizes: string[]): string | null {
  let best: { token: string; b: number } | null = null;
  for (const raw of sizes) {
    const b = sizeToBillions(raw);
    if (b == null) continue;
    if (!best || b > best.b) best = { token: raw.trim().toLowerCase(), b };
  }
  return best?.token ?? null;
}

/**
 * Resolve the correct `ollama pull` id for a cloud-capable library entry.
 * `name` is the bare family name from the library scrape (e.g. "gpt-oss");
 * `sizes` are its advertised parameter sizes (e.g. ["20b", "120b"]).
 */
export function resolveCloudPullId(name: string, sizes: string[] = []): string {
  // Already tagged (defensive — library names are bare families).
  if (name.includes(":")) return name;
  const known = KNOWN_CLOUD_TAGS[name];
  if (known) return known;
  const largest = largestSizeToken(sizes);
  if (largest) return `${name}:${largest}-cloud`;
  return `${name}:cloud`;
}
