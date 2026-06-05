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
 *
 * ── GGUF mode ─────────────────────────────────────────────────────────────
 * When `ggufMode` is true (used by the HF GGUF tab), the libraries filter
 * is locked to "gguf" so the API returns only GGUF-bearing repos, and each
 * card's action button becomes an inline "View files ▾" expander revealing
 * the per-quant `.gguf` file list below the card body. The download / install
 * state for those files comes from the parent ModelBrowser through
 * `ggufContext` (so a download started here keeps progressing if the user
 * wanders to a different tab).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Zap, Search, Check } from "lucide-react";
import { Sidebar } from "./hf-library/Sidebar";
import { ModelCard } from "./hf-library/ModelCard";
import { EmptyState } from "./EmptyState";
import { SORT_OPTIONS, PARAM_TICKS } from "./hf-library/constants";
import {
  loadHuggingFace,
  matchesApps,
  matchesProviders,
  matchesParams,
  type HfModel,
} from "./hf-library/loader";
import type { GgufDownloadProgress, GgufFile } from "../types";

/** GGUF file tree entry returned by HF's `/api/models/{repo}/tree/main`.
 *  Mirrors the shape used by ModelBrowser for the legacy GGUF tab. */
export interface HfTreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
  oid?: string;
  lfs?: { size?: number; sha256?: string };
}

/** Bundle of GGUF download/install state owned by the parent (ModelBrowser),
 *  passed into the view so the per-file expander rows can render with the
 *  same source of truth as the "Installed" tab. */
export interface GgufContext {
  /** Locally-cached `.gguf` files. */
  installed: GgufFile[];
  /** repo id → file tree (or "loading" sentinel / { error } shape). */
  trees: Map<string, HfTreeEntry[] | "loading" | { error: string }>;
  /** Set of `${repo}/${filename}` keys currently downloading. */
  downloads: Set<string>;
  /** Live per-file progress, keyed by `${repo}/${filename}`. */
  progress: Map<string, GgufDownloadProgress>;
  /** Shared errors map (keyed `${repo}/${filename}` for download errors,
   *  `gguf:${repo}/${filename}` for delete errors). */
  errors: Map<string, string>;
  /** Two-click confirm key (matches the parent's deleting flow). */
  confirmDelete: string | null;
  /** Repo id currently being deleted (any GGUF deletion). */
  deleting: string | null;
  /** Begin loading the tree for this repo; parent caches in `trees`. */
  onExpandRepo: (repoId: string) => void;
  /** Forget the tree for this repo (collapse). */
  onCollapseRepo: (repoId: string) => void;
  /** Kick off a single-file download. */
  onDownloadFile: (repo: string, filename: string) => void;
  /** Two-click delete (parent handles the confirm pattern). */
  onDeleteFile: (repo: string, filename: string) => void;
}

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
  /** When true: lock libraries filter to `gguf`, swap card action buttons
   *  for an inline file-list expander, and render the per-quant download
   *  rows from `ggufContext`. */
  ggufMode?: boolean;
  /** Required when `ggufMode` is true — owned by the parent ModelBrowser
   *  so download progress survives tab switches. */
  ggufContext?: GgufContext;
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

/** Format a byte count to "1.2 GB" / "850 MB" style. Local to this view so
 *  we don't depend on the parent's fmtBytes — same rules though. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes === 0) return "—";
  return `${bytes} B`;
}

/** Parse llama.cpp quant tags ("Q4_K_M", "IQ3_XXS", "F16"…) from a `.gguf`
 *  filename. Returns null when no recognizable tag is present. */
function parseGgufQuant(filename: string): string | null {
  const m =
    filename.match(/\b(IQ\d+_[A-Z]+|Q\d+_[A-Z0-9_]+|F16|F32|BF16)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/** Build the collapsed "8 quants · 1.2-7.5 GB" summary for a repo card.
 *  Returns null when the tree hasn't been fetched yet (so the card falls
 *  back to the plain "View files ▾" label). */
function ggufRepoSummary(tree: HfTreeEntry[] | "loading" | { error: string } | undefined): string | null {
  if (!Array.isArray(tree) || tree.length === 0) return null;
  const sizes = tree
    .map((f) => f.lfs?.size ?? f.size ?? 0)
    .filter((s) => s > 0);
  if (sizes.length === 0) return `${tree.length} quant${tree.length === 1 ? "" : "s"}`;
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const range = min === max ? fmtBytes(min) : `${fmtBytes(min)}-${fmtBytes(max)}`;
  return `${tree.length} quant${tree.length === 1 ? "" : "s"} · ${range}`;
}

export function HuggingFaceLibraryView(props: HuggingFaceLibraryViewProps) {
  // Either explicit ggufMode prop OR initial libraries containing "gguf"
  // seeds the GGUF library chip. Derived ggufMode (`derivedGgufMode`
  // below) tracks the live filter state so users can flip in/out of
  // per-file expander mode by toggling the sidebar chip.
  const initialLibs = useMemo(() => {
    const seed = props.initialLibraries ?? [];
    if (!props.ggufMode) return seed;
    return seed.includes("gguf") ? seed : ["gguf", ...seed];
  }, [props.initialLibraries, props.ggufMode]);
  const [filters, setFilters] = useState<FilterState>(() => DEFAULT_FILTERS(initialLibs));
  // ggufMode follows the live "gguf" library chip. Falls back to the prop
  // for back-compat (older call sites that pass it explicitly).
  const ggufMode = filters.libraries.includes("gguf") || !!props.ggufMode;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<string>("trending");
  const [inference, setInference] = useState(false);
  const [models, setModels] = useState<HfModel[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Bumped by the Retry button to re-trigger the fetch effect (e.g. after a
  // transient network failure on a cold/offline first run).
  const [reloadTick, setReloadTick] = useState(0);
  const [offset, setOffset] = useState(0);
  /** True when we know we've exhausted server-side pagination (a fetch
   *  returned 0 models). Prevents an endless "Load more" button. */
  const [exhausted, setExhausted] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
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
    // Also cancel any in-flight "load more": its result belongs to the OLD
    // filter and would otherwise append stale rows onto the fresh list.
    // LOW (2026-05-29).
    loadMoreAbortRef.current?.abort();
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
  }, [debouncedQuery, filters.tasks, filters.libraries, sort, inference, reloadTick]);

  /** Fetch the next page and append. We don't reset the abort controller
   *  here so a paginated load doesn't kill the visible list. */
  async function loadMore() {
    if (loadingMore || exhausted) return;
    setLoadingMore(true);
    setErr(null);
    const ctrl = new AbortController();
    loadMoreAbortRef.current = ctrl;
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
      // A filter change while this was in flight aborts ctrl and resets the
      // list — drop the stale page instead of appending it. LOW (2026-05-29).
      if (ctrl.signal.aborted) return;
      setModels((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...r.models.filter((m) => !seen.has(m.id))];
      });
      setOffset(nextOffset);
      if (r.models.length < PAGE_SIZE) setExhausted(true);
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setErr(String((e as { message?: string })?.message ?? e));
    } finally {
      if (loadMoreAbortRef.current === ctrl) loadMoreAbortRef.current = null;
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
            <span className="hfl-bolt" aria-hidden><Zap size={16} /></span>
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
        {err && (
          <div className="hfl-error">
            Failed to load: {err}
            <button
              type="button"
              className="mcp-link"
              style={{ marginLeft: 8 }}
              onClick={() => { setErr(null); setReloadTick((t) => t + 1); }}
            >
              Retry
            </button>
          </div>
        )}

        <div className="hfl-grid" data-testid="hfl-grid">
          {loading && models.length === 0 &&
            Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <div key={`sk-${i}`} className="hfl-card hfl-skeleton" data-testid="hfl-skeleton" aria-hidden />
            ))}
          {!loading && visibleModels.length === 0 && !err && (
            <div className="hfl-empty">
              <EmptyState
                icon={<Search size={16} />}
                heading="No models match your filters"
                sub="Try widening the parameter slider, clearing pipeline / library chips, or relaxing the inference-only toggle."
              />
            </div>
          )}
          {visibleModels.map((m) => {
            // Non-GGUF mode: plain card.
            if (!ggufMode || !props.ggufContext) {
              return (
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
              );
            }
            // GGUF mode: pull tree state out of the context and render the
            // inline file expander when this card is open.
            const ctx = props.ggufContext;
            const tree = ctx.trees.get(m.id);
            const isExpanded = tree !== undefined;
            const summary = ggufRepoSummary(tree);
            const installedKeys = new Set(
              ctx.installed.filter((f) => f.repo === m.id).map((f) => f.filename),
            );
            return (
              <ModelCard
                key={m.id}
                model={m}
                installed={false} /* repo-level install is meaningless for GGUF */
                pulling={false}
                done={false}
                err={undefined}
                onPull={props.onPull}
                onOpenHf={props.onOpenHf}
                onViewGguf={props.onViewGguf}
                onRemove={props.onRequestRemove}
                confirmDelete={props.confirmDelete}
                ggufMode
                expanded={isExpanded}
                ggufSummary={summary}
                onToggleExpand={() => {
                  if (isExpanded) ctx.onCollapseRepo(m.id);
                  else ctx.onExpandRepo(m.id);
                }}
              >
                {tree === "loading" && (
                  <div className="hfl-gguf-empty">
                    <span className="mb-spinner" /> Loading file tree…
                  </div>
                )}
                {tree && typeof tree === "object" && !Array.isArray(tree) && "error" in tree && (
                  <div className="hfl-gguf-err">{tree.error}</div>
                )}
                {Array.isArray(tree) && tree.length === 0 && (
                  <div className="hfl-gguf-empty">No .gguf files at repo root.</div>
                )}
                {Array.isArray(tree) && tree.map((f) => {
                  const key = `${m.id}/${f.path}`;
                  const isDownloading = ctx.downloads.has(key);
                  const isInstalled = installedKeys.has(f.path);
                  const prog = ctx.progress.get(key);
                  const fileDelKey = `gguf:${m.id}/${f.path}`;
                  const isDeleting = ctx.deleting === fileDelKey;
                  const err = ctx.errors.get(key);
                  const quant = parseGgufQuant(f.path);
                  const sizeBytes = f.lfs?.size ?? f.size ?? 0;
                  const pct = prog && prog.total_bytes > 0
                    ? Math.min(100, Math.round((prog.bytes_downloaded / prog.total_bytes) * 100))
                    : 0;
                  return (
                    <div
                      key={key}
                      className="hfl-gguf-file"
                      data-testid={`gguf-file-${m.id}-${f.path}`}
                    >
                      <div className="hfl-gguf-file-info">
                        <div className="hfl-gguf-file-name">{f.path}</div>
                        <div className="hfl-gguf-file-meta">
                          {quant && <span className="hfl-gguf-quant">{quant}</span>}
                          <span className="hfl-gguf-size">
                            {sizeBytes > 0 ? fmtBytes(sizeBytes) : "—"}
                          </span>
                          {isInstalled && (
                            <span className="mb-tag mb-installed-tag" title="Already downloaded"><Check size={12} /> installed</span>
                          )}
                        </div>
                        {isDownloading && prog && (
                          <div className="hfl-gguf-progress">
                            {fmtBytes(prog.bytes_downloaded)}
                            {prog.total_bytes > 0 && <> / {fmtBytes(prog.total_bytes)} · {pct}%</>}
                          </div>
                        )}
                        {err && <div className="hfl-card-err">{err}</div>}
                      </div>
                      <div className="hfl-gguf-file-actions">
                        {isInstalled ? (
                          <button
                            type="button"
                            className="hfl-btn hfl-btn-delete"
                            onClick={() => ctx.onDeleteFile(m.id, f.path)}
                            disabled={isDeleting || !!ctx.deleting}
                          >
                            {ctx.confirmDelete === fileDelKey ? "Click again to confirm" : "Remove"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="hfl-btn"
                            onClick={() => ctx.onDownloadFile(m.id, f.path)}
                            disabled={isDownloading}
                            data-testid={`gguf-download-${m.id}-${f.path}`}
                          >
                            {isDownloading
                              ? (prog && prog.total_bytes > 0 ? `Downloading… ${pct}%` : "Downloading…")
                              : "Download"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </ModelCard>
            );
          })}
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
