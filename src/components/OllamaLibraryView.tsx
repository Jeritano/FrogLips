import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/tauri-api";
import type { ModelEntry, OllamaLibraryEntry, OllamaPullProgress } from "../types";

/* ── color palette ──────────────────────────────────────────────────────
   Matches the colored chips on ollama.com/library:
     vision  → orange
     tools   → blue
     thinking→ purple
     audio   → teal
     cloud   → green
     embedding → yellow
     size    → slate
   Background is the color at ~22% opacity, foreground at 100%. */
export const CAP_COLORS: Record<string, string> = {
  vision:    "#f97316",
  tools:     "#3b82f6",
  thinking:  "#a855f7",
  audio:     "#06b6d4",
  cloud:     "#22c55e",
  embedding: "#eab308",
};
const SIZE_COLOR = "#475569";

type SortKey = "popular" | "newest" | "updated";
const ALL_FILTERS: readonly string[] = [
  "Cloud",
  "Embedding",
  "Vision",
  "Tools",
  "Thinking",
] as const;

interface OllamaLibraryViewProps {
  /** Locally-installed Ollama models — drives the Installed/Remove badge. */
  installedOllama: ModelEntry[];
  /** Trigger a pull for `name` via the parent's existing flow. */
  pull: (name: string) => void;
  /** Trigger a remove (two-click confirm) via the parent. */
  requestRemove: (name: string) => void;
  /** Set of model id currently being pulled (parent state). */
  pulling: string | null;
  /** Live progress for the in-flight pull (matches the active card by name). */
  pullProgress?: OllamaPullProgress | null;
  /** Set of model id currently being deleted. */
  deleting: string | null;
  /** Set of model ids that finished pulling this session. */
  done: Set<string>;
  /** Map of model id → error message from a failed pull/remove. */
  errors: Map<string, string>;
  /** id currently armed for two-click delete confirm. */
  confirmDelete: string | null;
  /** Fallback dataset shown when ollama.com/library can't be reached. */
  fallback: { id: string; label: string; desc: string; tags: string[]; size: string }[];
  /** Filter text from the parent search box (existing styling). */
  query: string;
}

/**
 * Convert raw pull count to a short string: 587_400 → "587.4K", 1_200_000 → "1.2M".
 * Mirrors ollama.com's own display. Single-source-of-truth for the metadata row.
 */
function fmtPulls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Heuristic ordering for the "Newest" sort. ollama.com renders relative
 * strings ("3 weeks ago"); we map each to an approximate day count so a
 * lexicographic sort is wrong but a numeric sort is right.
 *
 * Returns "days ago" — smaller = more recent.
 */
function daysAgoEstimate(rel: string): number {
  const t = rel.toLowerCase();
  // Order most specific suffix first so "1 month ago" beats "1 m ago".
  const tokens: [RegExp, number][] = [
    [/(\d+(?:\.\d+)?)\s*year/, 365],
    [/(\d+(?:\.\d+)?)\s*month/, 30],
    [/(\d+(?:\.\d+)?)\s*week/, 7],
    [/(\d+(?:\.\d+)?)\s*day/, 1],
    [/(\d+(?:\.\d+)?)\s*hour/, 1 / 24],
    [/(\d+(?:\.\d+)?)\s*minute/, 1 / 1440],
    [/(\d+(?:\.\d+)?)\s*second/, 1 / 86400],
  ];
  for (const [re, mult] of tokens) {
    const m = t.match(re);
    if (m) return parseFloat(m[1]) * mult;
  }
  // "yesterday" / "today" / unknown → put after explicit dates.
  if (/yesterday/.test(t)) return 1;
  if (/today|now/.test(t)) return 0;
  return Number.POSITIVE_INFINITY;
}

/** Build a chip with the colored-pill look from the screenshot. */
function CapChip({ label }: { label: string }) {
  const color = CAP_COLORS[label.toLowerCase()] ?? "#6b7280";
  return (
    <span
      className="mb-tag mb-ollama-cap"
      style={{ background: `${color}38`, color }}
      data-testid="ollama-cap-chip"
    >
      {label}
    </span>
  );
}

function SizeChip({ label }: { label: string }) {
  return (
    <span
      className="mb-tag mb-ollama-size"
      style={{ background: `${SIZE_COLOR}38`, color: "#cbd5e1" }}
    >
      {label}
    </span>
  );
}

/** Skeleton placeholder while the scrape is in flight. */
function SkeletonCard() {
  return (
    <div className="mb-card mb-ollama-card mb-ollama-skel" aria-busy="true">
      <div className="mb-card-info">
        <div className="mb-ollama-skel-line" style={{ width: "32%", height: 14 }} />
        <div className="mb-ollama-skel-line" style={{ width: "92%", height: 10, marginTop: 8 }} />
        <div className="mb-ollama-skel-line" style={{ width: "78%", height: 10, marginTop: 4 }} />
        <div className="mb-ollama-skel-line" style={{ width: "40%", height: 10, marginTop: 10 }} />
      </div>
    </div>
  );
}

/**
 * Full-pane clone of <https://ollama.com/library>. Pulls live data via the
 * Tauri command, falls back to a curated list on failure.
 *
 * The parent component owns the install/pull side effects so this view stays
 * presentational — easy to test, easy to drop into other tabs later.
 */
export function OllamaLibraryView({
  installedOllama,
  pull,
  requestRemove,
  pulling,
  pullProgress,
  deleting,
  done,
  errors,
  confirmDelete,
  fallback,
  query,
}: OllamaLibraryViewProps) {
  const [entries, setEntries] = useState<OllamaLibraryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [fellBack, setFellBack] = useState(false);
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("popular");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await api.ollamaLibraryFetch();
        if (cancelled) return;
        if (!Array.isArray(list) || list.length === 0) {
          setEntries(synthesizeFromFallback(fallback));
          setFellBack(true);
        } else {
          setEntries(list);
          setFellBack(false);
        }
      } catch {
        if (cancelled) return;
        setEntries(synthesizeFromFallback(fallback));
        setFellBack(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // `fallback` is a stable prop reference from the parent (the `OLLAMA`
    // const). Re-running on every render would thrash the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installedIds = useMemo(
    () => new Set(installedOllama.map((m) => m.id)),
    [installedOllama],
  );

  const toggleFilter = (f: string) => {
    setFilters((prev) => {
      const next = new Set(prev);
      const key = f.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filteredSorted = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    let out = entries.filter((e) => {
      // ALL selected filters must match the entry's capabilities.
      for (const f of filters) {
        if (!e.capabilities.includes(f)) return false;
      }
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.capabilities.some((c) => c.includes(q)) ||
        e.sizes.some((s) => s.toLowerCase().includes(q))
      );
    });
    if (sort === "popular") {
      out = [...out].sort((a, b) => b.pulls - a.pulls);
    } else if (sort === "newest") {
      out = [...out].sort((a, b) =>
        daysAgoEstimate(a.updated_relative) - daysAgoEstimate(b.updated_relative),
      );
    } else {
      // "updated" = alpha by updated_relative; matches the screenshot's
      // ordering for rarely-touched models.
      out = [...out].sort((a, b) => a.updated_relative.localeCompare(b.updated_relative));
    }
    return out;
  }, [entries, filters, sort, query]);

  return (
    <div className="mb-ollama-view" data-testid="ollama-library-view">
      {/* Filter chips + sort dropdown — top toolbar (matches ollama.com). */}
      <div className="mb-ollama-toolbar">
        <div className="mb-ollama-chips" role="group" aria-label="Filter by capability">
          {ALL_FILTERS.map((label) => {
            const key = label.toLowerCase();
            const active = filters.has(key);
            const color = CAP_COLORS[key] ?? "#6b7280";
            return (
              <button
                key={label}
                type="button"
                className={`mb-ollama-chip ${active ? "active" : ""}`}
                onClick={() => toggleFilter(label)}
                style={
                  active
                    ? { background: `${color}33`, color, borderColor: `${color}88` }
                    : undefined
                }
                aria-pressed={active}
                data-testid={`filter-chip-${key}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <select
          className="mb-ollama-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          data-testid="ollama-sort"
        >
          <option value="popular">Popular</option>
          <option value="newest">Newest</option>
          <option value="updated">Updated</option>
        </select>
      </div>

      {fellBack && (
        <div className="mb-ollama-banner" role="status">
          Couldn't reach ollama.com — showing curated list.
        </div>
      )}

      {/* Loading skeletons keep the layout from collapsing on the slow path. */}
      {loading && (
        <>
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonCard key={`skel-${i}`} />
          ))}
        </>
      )}

      {!loading && filteredSorted.length === 0 && (
        <div className="mb-empty">
          No models match your filters.
        </div>
      )}

      {!loading &&
        filteredSorted.map((entry) => {
          // Cloud-capability models aren't a local download — Ollama serves
          // them under the `:cloud` tag (and they require `ollama signin`).
          // Pull/track the suffixed id so a bare `ollama pull <name>` doesn't
          // 404 on a missing local manifest ("file does not exist").
          const isCloud = entry.capabilities.includes("cloud");
          const pullId = isCloud && !entry.name.includes(":") ? `${entry.name}:cloud` : entry.name;
          const isInstalled = installedIds.has(pullId) || installedIds.has(entry.name);
          const removeId = installedIds.has(pullId) ? pullId : entry.name;
          const isPulling = pulling === pullId;
          const isDeleting = deleting === removeId;
          const isDone = done.has(pullId);
          const err = errors.get(pullId) ?? errors.get(entry.name);
          return (
            <article
              key={entry.name}
              className={`mb-card mb-ollama-card ${isInstalled ? "installed" : ""}`}
              data-testid="ollama-library-card"
            >
              <div className="mb-card-info">
                <h2 className="mb-ollama-name">{entry.name}</h2>
                {entry.description && (
                  <p className="mb-ollama-desc">{entry.description}</p>
                )}
                <div className="mb-ollama-chiprow">
                  {entry.capabilities.map((c) => (
                    <CapChip key={`cap-${c}`} label={c} />
                  ))}
                  {entry.sizes.map((s) => (
                    <SizeChip key={`size-${s}`} label={s} />
                  ))}
                </div>
                <div className="mb-ollama-meta">
                  <span>↓ {fmtPulls(entry.pulls)} Pulls</span>
                  <span>· 🏷 {entry.tag_count} Tag{entry.tag_count === 1 ? "" : "s"}</span>
                  {entry.updated_relative && <span>· 🕒 Updated {entry.updated_relative}</span>}
                </div>
                {isCloud && !isInstalled && (
                  <div className="mb-ollama-cloudhint">
                    ☁ Cloud model — runs on Ollama's servers, no local download. First pull opens Ollama sign-in in your browser automatically.
                  </div>
                )}
                {err && <div className="mb-card-err">{err}</div>}
                {isPulling && pullProgress && pullProgress.name === pullId && (
                  <div className="mb-pull-progress">
                    <div className="mb-pull-track">
                      <div
                        className={`mb-pull-fill${pullProgress.percent == null ? " indeterminate" : ""}`}
                        style={
                          pullProgress.percent != null
                            ? { width: `${pullProgress.percent}%` }
                            : undefined
                        }
                      />
                    </div>
                    <div className="mb-pull-status">{pullProgress.status}</div>
                  </div>
                )}
              </div>
              <div className="mb-card-actions">
                {isInstalled ? (
                  <button
                    className="mb-delete-btn"
                    onClick={() => requestRemove(removeId)}
                    disabled={isDeleting || !!deleting}
                  >
                    {isDeleting
                      ? <span className="mb-spinner" />
                      : confirmDelete === removeId
                        ? "Click again to confirm"
                        : "🗑 Remove"}
                  </button>
                ) : (
                  <button
                    className={`mb-pull-btn ${isDone ? "done" : ""}`}
                    onClick={() => pull(pullId)}
                    disabled={isPulling || !!pulling}
                    data-testid="ollama-pull-btn"
                  >
                    {isPulling
                      ? <span className="mb-spinner" />
                      : isDone
                        ? "✓ Done"
                        : isInstalled
                          ? "✓ Installed"
                          : isCloud
                            ? "Get cloud"
                            : "Pull"}
                  </button>
                )}
                {isInstalled && (
                  <span className="mb-tag mb-installed-tag">✓ installed</span>
                )}
              </div>
            </article>
          );
        })}
    </div>
  );
}

/* Build OllamaLibraryEntry shapes from the curated CatalogEntry fallback so
 * the same renderer handles both the live and fallback paths. We can't infer
 * pulls/tag_count/updated_relative offline — display "—" and 0 for those. */
function synthesizeFromFallback(
  fb: OllamaLibraryViewProps["fallback"],
): OllamaLibraryEntry[] {
  return fb.map((c) => {
    // Map the curated tags onto the live capability vocabulary so filtering
    // still works. Unknown tags get dropped (they'd never match a filter).
    const knownCaps = new Set(Object.keys(CAP_COLORS));
    const caps = c.tags.filter((t) => knownCaps.has(t));
    return {
      name: c.id,
      description: c.desc,
      capabilities: caps,
      sizes: c.size ? [c.size] : [],
      pulls: 0,
      tag_count: 0,
      updated_relative: "",
    };
  });
}
