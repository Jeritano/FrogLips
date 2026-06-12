/**
 * Unified HuggingFace search helper.
 *
 * Consolidates the previous `loadHf` / `loadHfAll` / `loadHfGguf` shapes
 * into a single entry point used by the new HuggingFaceLibraryView.
 *
 * HF API quirks worth noting:
 *  - `pipeline_tag` accepts ONE value. When the user multi-selects tasks,
 *    we fan out N parallel calls (capped at 10) and merge the results.
 *  - `filter` accepts a comma-joined list of library/tag slugs and is
 *    AND-semantics (a repo must carry every one of them).
 *  - `inference=warm` is HF's flag for "live on an inference provider",
 *    matching the lightning-bolt filter on the website.
 *  - Apps and providers are NOT first-class API params for most slugs,
 *    so we apply those as client-side post-filters over `tags`.
 */

export interface HfModel {
  id: string;
  downloads: number;
  likes: number;
  tags?: string[];
  pipeline_tag?: string;
  library_name?: string;
  lastModified?: string;
  createdAt?: string;
  gated?: boolean | string;
  private?: boolean;
  /** Some HF endpoints return a numeric param count when `full=true`; we
   *  don't request full responses but the field is honored if present. */
  numParameters?: number;
}

export interface LoadOpts {
  query: string;
  tasks: string[];
  libraries: string[];
  inference: boolean;
  sort: string;
  offset: number;
  /** AbortSignal so cancellation flows through to the fetch. */
  signal: AbortSignal;
  /** Items per page. Default 100 matches the HF API default. */
  limit?: number;
}

export interface LoadResult {
  models: HfModel[];
  /** Total catalogue size as reported by HF — surfaced in the header
   *  ("Models · 2,898,041"). HF returns this in the `x-total-count`
   *  response header (lower-case in fetch). May be null. */
  totalCount: number | null;
}

const HF_API = "https://huggingface.co/api/models";
const MAX_CONCURRENT = 10;

/** Build the query string for ONE HF call. Tasks come in as a single value
 *  (the caller fans out if the user multi-selected). */
function buildUrl(opts: {
  query: string;
  task: string | null;
  libraries: string[];
  inference: boolean;
  sort: string;
  offset: number;
  limit: number;
}): string {
  const p = new URLSearchParams();
  // The website's default sort is "trending"; the HF API accepts an empty
  // sort to mean trending so we only emit `sort=` for non-trending values.
  if (opts.sort && opts.sort !== "trending") {
    p.set("sort", opts.sort);
    p.set("direction", "-1");
  }
  p.set("limit", String(opts.limit));
  if (opts.offset > 0) p.set("offset", String(opts.offset));
  if (opts.query.trim()) p.set("search", opts.query.trim());
  if (opts.task) p.set("pipeline_tag", opts.task);
  if (opts.libraries.length > 0) p.set("filter", opts.libraries.join(","));
  if (opts.inference) p.set("inference", "warm");
  return `${HF_API}?${p.toString()}`;
}

async function fetchOne(
  url: string,
  signal: AbortSignal,
): Promise<{
  models: HfModel[];
  totalCount: number | null;
}> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HF API ${res.status}`);
  const totalHeader = res.headers.get("x-total-count");
  const totalCount = totalHeader ? Number.parseInt(totalHeader, 10) : null;
  const data = (await res.json()) as HfModel[];
  return {
    models: Array.isArray(data) ? data : [],
    totalCount: Number.isFinite(totalCount as number)
      ? (totalCount as number)
      : null,
  };
}

/** Deduplicate models by id while preserving first-seen order. */
function dedupe(models: HfModel[]): HfModel[] {
  const seen = new Set<string>();
  const out: HfModel[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export async function loadHuggingFace(opts: LoadOpts): Promise<LoadResult> {
  const limit = opts.limit ?? 100;
  // If 0 or 1 tasks, single fetch. Otherwise fan out — cap concurrency at
  // MAX_CONCURRENT so a wide multi-select doesn't trigger 30 simultaneous
  // network calls.
  if (opts.tasks.length <= 1) {
    const url = buildUrl({
      query: opts.query,
      task: opts.tasks[0] ?? null,
      libraries: opts.libraries,
      inference: opts.inference,
      sort: opts.sort,
      offset: opts.offset,
      limit,
    });
    return fetchOne(url, opts.signal);
  }

  const tasks = opts.tasks.slice(0, MAX_CONCURRENT);
  const results = await Promise.all(
    tasks.map((t) =>
      fetchOne(
        buildUrl({
          query: opts.query,
          task: t,
          libraries: opts.libraries,
          inference: opts.inference,
          sort: opts.sort,
          offset: opts.offset,
          limit,
        }),
        opts.signal,
      ),
    ),
  );
  // Merge: concat, dedupe, then sort by downloads desc as a tiebreaker
  // (HF's per-task ordering is preserved per-bucket but cross-bucket the
  // user expects a single coherent list).
  const merged = dedupe(results.flatMap((r) => r.models));
  if (opts.sort === "downloads" || opts.sort === "trending") {
    merged.sort((a, b) => b.downloads - a.downloads);
  } else if (opts.sort === "likes") {
    merged.sort((a, b) => b.likes - a.likes);
  }
  // Sum-of-totals is misleading (overlap) so use the max across calls as a
  // floor. HF doesn't expose a union total, so this is the best estimate.
  const totalCount = results.reduce(
    (acc, r) =>
      r.totalCount !== null && (acc === null || r.totalCount > acc)
        ? r.totalCount
        : acc,
    null as number | null,
  );
  return { models: merged, totalCount };
}

/* ── Client-side filters ─────────────────────────────────────────────────── */

/** Match an app slug against a model's tags. Apps are scoped via tags like
 *  `library:vllm` or just `vllm` on the repo. We tolerate both. */
export function matchesApps(model: HfModel, apps: string[]): boolean {
  if (apps.length === 0) return true;
  const tags = (model.tags ?? []).map((t) => t.toLowerCase());
  return apps.some((a) => {
    const slug = a.toLowerCase();
    return (
      tags.includes(slug) ||
      tags.includes(`library:${slug}`) ||
      tags.includes(`app:${slug}`)
    );
  });
}

/** Same approach for inference providers. HF surfaces these as
 *  `inference_provider:groq` (etc.) on repos that are warm there. */
export function matchesProviders(model: HfModel, providers: string[]): boolean {
  if (providers.length === 0) return true;
  const tags = (model.tags ?? []).map((t) => t.toLowerCase());
  return providers.some((p) => {
    const slug = p.toLowerCase();
    return (
      tags.includes(slug) ||
      tags.includes(`provider:${slug}`) ||
      tags.includes(`inference_provider:${slug}`)
    );
  });
}

/** Heuristic: extract a parameter count (in number of params) from a model.
 *  Tries `numParameters` first, then parses the model id (`-7B`, `-70B`,
 *  `-1.5B`, `-405b`, `-3.8b`, `-32B`). Returns null when nothing matches. */
export function extractParams(model: HfModel): number | null {
  if (typeof model.numParameters === "number" && model.numParameters > 0) {
    return model.numParameters;
  }
  // Look for ` 7B ` / `-7B-` / `_7B_` / suffix etc. Decimal allowed.
  const m = model.id.match(/[-_./ ](\d+(?:\.\d+)?)\s?b\b/i);
  if (m) return Math.round(parseFloat(m[1]) * 1_000_000_000);
  const m2 = model.id.match(/[-_./ ](\d+(?:\.\d+)?)\s?m\b/i);
  if (m2) return Math.round(parseFloat(m2[1]) * 1_000_000);
  return null;
}

/** Whether a model's inferred params fall inside [minBucket, maxBucket].
 *  Buckets come from PARAM_TICKS in constants.ts. We treat "no idea" as
 *  always-include when the user hasn't moved the slider off defaults
 *  (min=0, max=5) — otherwise unknowns are filtered out so the user
 *  actually sees the narrowing they asked for. */
export function matchesParams(
  model: HfModel,
  minBucket: number,
  maxBucket: number,
  bucketMaxes: number[],
): boolean {
  // Default full-range → include everything (including unknowns).
  if (minBucket === 0 && maxBucket >= bucketMaxes.length - 1) return true;
  const n = extractParams(model);
  if (n === null) return false;
  const lo = minBucket > 0 ? bucketMaxes[minBucket - 1] : 0;
  const hi = bucketMaxes[maxBucket] ?? Infinity;
  return n >= lo && n <= hi;
}
