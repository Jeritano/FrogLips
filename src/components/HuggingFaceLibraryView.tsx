/**
 * Full-pane HuggingFace library view.
 *
 * Mirrors the layout of https://huggingface.co/models — a left filter rail
 * with collapsible sections, plus a main pane with a header (count + filter
 * input + inference toggle + sort dropdown) and a responsive grid of model
 * cards. Designed to replace the old `hf` and `hf-all` tabs of ModelBrowser.
 *
 * Component is split across `hf-library/`:
 *   - `constants.ts` — static filter lists, sort options, palette
 *   - `loader.ts`    — HF API fetch + client-side filter helpers
 *   - `Sidebar.tsx`  — filter rail
 *   - `ModelCard.tsx`— individual repo tile
 *
 * Apps + Inference Providers are applied as CLIENT-SIDE filters because the
 * HF /api/models endpoint doesn't expose first-class params for every app or
 * provider slug. This means the count in the header is slightly optimistic
 * when those filters are active; we document this in the UI strip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "./hf-library/Sidebar";
import { ModelCard } from "./hf-library/ModelCard";
import { SORT_OPTIONS, PARAM_TICKS } from "./hf-library/constants";
import {
  loadHuggingFace,
  matchesApps,
  matchesProviders,
  matchesParams,
  type HfModel,
} from "./hf-library/loader";

export interface HuggingFaceLibraryViewProps {
  /** Repo ids the user has already pulled (MLX side). Card switches to
   *  "Remove" when present. */
  installedMlxIds: Set<string>;
  /** When the libraries filter should start with MLX pre-checked. Used by
   *  the source dropdown's old "HuggingFace MLX" entry. */
  initialLibraries?: string[];
  /** Pull pipeline. (id, "hf") — same signature as the existing helper. */
  onPull: (id: string) => void;
  /** Remove (two-click confirm handled upstream). */
  onRequestRemove: (id: string) => void;
  /** Switch the parent ModelBrowser to the GGUF tab pre-filled with this
   *  repo id, so the user can pick a specific quant. */
  onViewGguf: (id: string) => void;
  /** Open URL externally. We use api.openExternal in production but accept
   *  it as a prop to keep this component pure. */
  onOpenHf: (id: string) => void;
  /** Maps from the parent's `pulling`/`done`/`errors`/`deleting` state. */
  pulling: string | null;
  done: Set<string>;
  errors: Map<string, string>;
  confirmDelete: string | null;
}

interface FilterState {
  tasks: string[];
  libraries: string[];
  apps: string[];
  providers: string[];
  paramMin: number;
  paramMax: number;
}

const DEFAULT_FILTERS = (initialLibraries: string[]): FilterState => ({
  tasks: [],
  libraries: initialLibraries,
  apps: [],
  providers: [],
  paramMin: 0,
  paramMax: PARAM_TICKS.length - 1,
});

const PAGE_SIZE = 100;
const SKELETON_COUNT = 6;
const BUCKET_MAXES = PARAM_TICKS.map((t) => t.max);

export function HuggingFaceLibraryView(props: HuggingFaceLibraryViewProps) {
  const [filters, setFilters] = useState<FilterState>(() => DEFAULT_FILTERS(props.initialLibraries ?? []));
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<string>("trending");
  const [inference, setInference] = useState(false);
  const [models, setModels] = useState<HfModel[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  /** True when we know we've exhausted server-side pagination (a fetch
   *  returned 0 models). Prevents an endless "Load more" button. */
  const [exhausted, setExhausted] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Debounce the free-text filter input — 250ms matches the pattern used by
  // the legacy HF tabs in ModelBrowser.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  /** Re-fetch whenever a server-driving filter changes. We deliberately
   *  exclude `apps`, `providers`, and the param slider — those are applied
   *  client-side on the existing result set. */
  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setErr(null);
    setOffset(0);
    setExhausted(false);
    (async () => {
      try {
        const r = await loadHuggingFace({
          query: debouncedQuery,
          tasks: filters.tasks,
          libraries: filters.libraries,
          inference,
          sort,
          offset: 0,
          signal: ctrl.signal,
          limit: PAGE_SIZE,
        });
        if (ctrl.signal.aborted) return;
        setModels(r.models);
        setTotalCount(r.totalCount);
        if (r.models.length < PAGE_SIZE) setExhausted(true);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setErr(String((e as { message?: string })?.message ?? e));
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [debouncedQuery, filters.tasks, filters.libraries, sort, inference]);

  /** Fetch the next page and append. We don't reset the abort controller
   *  here so a paginated load doesn't kill the visible list. */
  async function loadMore() {
    if (loadingMore || exhausted) return;
    setLoadingMore(true);
    setErr(null);
    const ctrl = new AbortController();
    try {
      const nextOffset = offset + PAGE_SIZE;
      const r = await loadHuggingFace({
        query: debouncedQuery,
        tasks: filters.tasks,
        libraries: filters.libraries,
        inference,
        sort,
        offset: nextOffset,
        signal: ctrl.signal,
        limit: PAGE_SIZE,
      });
      setModels((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...r.models.filter((m) => !seen.has(m.id))];
      });
      setOffset(nextOffset);
      if (r.models.length < PAGE_SIZE) setExhausted(true);
    } catch (e: unknown) {
      setErr(String((e as { message?: string })?.message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }

  /** Apply the client-side filters (apps / providers / param slider). */
  const visibleModels = useMemo(() => {
    return models.filter(
      (m) =>
        matchesApps(m, filters.apps) &&
        matchesProviders(m, filters.providers) &&
        matchesParams(m, filters.paramMin, filters.paramMax, BUCKET_MAXES),
    );
  }, [models, filters.apps, filters.providers, filters.paramMin, filters.paramMax]);

  const clientFiltering =
    filters.apps.length > 0 || filters.providers.length > 0 || filters.paramMin > 0 || filters.paramMax < PARAM_TICKS.length - 1;

  return (
    <div className="hfl-root" data-testid="hfl-root">
      <Sidebar
        tasks={filters.tasks}
        libraries={filters.libraries}
        apps={filters.apps}
        providers={filters.providers}
        paramMin={filters.paramMin}
        paramMax={filters.paramMax}
        onChange={(next) => setFilters((f) => ({ ...f, ...next }))}
      />

      <main className="hfl-main">
        <div className="hfl-toolbar">
          <div className="hfl-toolbar-title">
            Models · <strong>{totalCount !== null ? totalCount.toLocaleString() : "—"}</strong>
          </div>
          <input
            type="text"
            className="hfl-name-filter"
            placeholder="Filter by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="model-search"
          />
          <label className="hfl-inference-toggle" title="Show only repos with warm inference">
            <input
              type="checkbox"
              checked={inference}
              onChange={(e) => setInference(e.target.checked)}
              data-testid="hfl-inference-toggle"
            />
            <span className="hfl-bolt" aria-hidden>⚡</span>
            <span>Inference Available</span>
          </label>
          <select
            className="hfl-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            data-testid="hfl-sort"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>Sort: {o.label}</option>
            ))}
          </select>
        </div>

        {clientFiltering && (
          <div className="hfl-note">
            Apps, providers, and parameter filters are applied client-side to the
            loaded page — the count above is a server-side total.
          </div>
        )}
        {err && <div className="hfl-error">Failed to load: {err}</div>}

        <div className="hfl-grid" data-testid="hfl-grid">
          {loading && models.length === 0 &&
            Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <div key={`sk-${i}`} className="hfl-card hfl-skeleton" data-testid="hfl-skeleton" aria-hidden />
            ))}
          {!loading && visibleModels.length === 0 && !err && (
            <div className="hfl-empty">No models match your filters.</div>
          )}
          {visibleModels.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              installed={props.installedMlxIds.has(m.id)}
              pulling={props.pulling === m.id}
              done={props.done.has(m.id)}
              err={props.errors.get(m.id)}
              onPull={props.onPull}
              onOpenHf={props.onOpenHf}
              onViewGguf={props.onViewGguf}
              onRemove={props.onRequestRemove}
              confirmDelete={props.confirmDelete}
            />
          ))}
        </div>

        {visibleModels.length > 0 && !exhausted && (
          <div className="hfl-load-more">
            <button
              type="button"
              className="hfl-btn"
              onClick={loadMore}
              disabled={loadingMore}
              data-testid="hfl-load-more"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default HuggingFaceLibraryView;
