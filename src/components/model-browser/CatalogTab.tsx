import { useMemo, useState } from "react";
import { Check, Cloud, Download, Trash2 } from "lucide-react";
import { resolveCloudPullId } from "../../lib/cloud-tags";
import { CAP_COLORS } from "../OllamaLibraryView";
import type { ModelEntry, OllamaPullProgress, SystemInfo } from "../../types";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  fitBadgeLabel,
  fitSortRank,
  fitTier,
  inCategory,
  isCloudEntry,
  parseSizeBytes,
  SIZE_TIER_LABEL,
  SIZE_TIER_ORDER,
  sizeTier,
  type CatalogCategory,
  type CatalogEntry,
} from "./catalog";

/* ── Curated Catalog tab ─────────────────────────────────────────────────────
 *
 * A hand-picked, RAM-aware discovery view over the SAME curated `OLLAMA`
 * catalog the Ollama tab falls back to. Closes the "what should I even install"
 * gap vs LM Studio: every entry shows a size, a one-line description, and a
 * one-click install — and is badged comfortable / tight / won't-fit against the
 * user's detected RAM using the SHARED `classify()` (identical to the model
 * picker + setup wizard). Install reuses the parent's existing Ollama pull /
 * progress / remove plumbing — this view is purely presentational, no new
 * download path.
 */

interface Props {
  /** The curated catalog (ModelBrowser's `OLLAMA` const). */
  catalog: CatalogEntry[];
  /** Locally-installed Ollama models — drives the Installed/Remove state. */
  installedOllama: ModelEntry[];
  /** Detected machine RAM for the fit badges; null until probed. */
  machine: Pick<SystemInfo, "total_ram_gb"> | null;
  /** Filter text from the parent search box. */
  query: string;
  /** Trigger a pull via the parent's existing Ollama flow. */
  pull: (name: string) => void;
  /** Trigger a remove (two-click confirm) via the parent. */
  requestRemove: (name: string) => void;
  /** Model id currently being pulled (parent state). */
  pulling: string | null;
  /** Live progress for the in-flight pull (matches the active card by name). */
  pullProgress?: OllamaPullProgress | null;
  /** Model id currently being deleted. */
  deleting: string | null;
  /** Model ids that finished pulling this session. */
  done: Set<string>;
  /** Map of model id → error from a failed pull/remove. */
  errors: Map<string, string>;
  /** id currently armed for two-click delete confirm. */
  confirmDelete: string | null;
}

/** A small colored capability chip, reusing the Ollama-tab palette. */
function TagChip({ label }: { label: string }) {
  const color = CAP_COLORS[label.toLowerCase()] ?? "#6b7280";
  return (
    <span className="mb-tag" style={{ background: `${color}30`, color }}>
      {label}
    </span>
  );
}

export function CatalogTab({
  catalog,
  installedOllama,
  machine,
  query,
  pull,
  requestRemove,
  pulling,
  pullProgress,
  deleting,
  done,
  errors,
  confirmDelete,
}: Props) {
  // Capability filter chips (multi-select; empty = all). "Fits my Mac" hides
  // anything that won't fit / would thrash on the detected RAM.
  const [cats, setCats] = useState<Set<CatalogCategory>>(new Set());
  const [fitsOnly, setFitsOnly] = useState(false);

  const installedIds = useMemo(
    () => new Set(installedOllama.map((m) => m.id)),
    [installedOllama],
  );

  function toggleCat(c: CatalogCategory) {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  // Filter → bucket by size tier → sort each bucket RAM-first (comfortable
  // before tight before won't-fit), then by absolute size descending so the
  // most-capable comfortable model leads its tier.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = catalog.filter((e) => {
      for (const c of cats) {
        if (!inCategory(e, c)) return false;
      }
      if (fitsOnly) {
        const t = fitTier(e, machine);
        // Keep cloud rows (no RAM cost) + comfortable/tight; drop heavy/won't-fit.
        if (t === "thrash" || t === "impossible") return false;
      }
      if (!q) return true;
      return (
        e.id.toLowerCase().includes(q) ||
        e.label.toLowerCase().includes(q) ||
        e.desc.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
      );
    });

    const buckets = new Map<string, CatalogEntry[]>();
    for (const e of filtered) {
      const tier = sizeTier(e);
      const arr = buckets.get(tier) ?? [];
      arr.push(e);
      buckets.set(tier, arr);
    }
    for (const arr of buckets.values()) {
      arr.sort((a, b) => {
        const ra = fitSortRank(fitTier(a, machine));
        const rb = fitSortRank(fitTier(b, machine));
        if (ra !== rb) return ra - rb;
        // Within the same fit rank, larger (more capable) first. Compare in
        // bytes so "1.3 GB" sorts above "815 MB" (raw parseFloat wouldn't).
        return parseSizeBytes(b.size) - parseSizeBytes(a.size);
      });
    }
    return buckets;
  }, [catalog, cats, fitsOnly, machine, query]);

  const totalShown = useMemo(
    () => [...grouped.values()].reduce((s, a) => s + a.length, 0),
    [grouped],
  );

  return (
    <div className="mb-ollama-view" data-testid="catalog-view">
      <div className="mb-catalog-intro">
        Curated, ready-to-run models —{" "}
        {machine?.total_ram_gb
          ? `badged for your ${Math.round(machine.total_ram_gb)} GB Mac.`
          : "install one with a single click."}{" "}
        Sized comfortable / tight / won't-fit using the same check as the model
        picker.
      </div>

      {/* Capability filters + "fits my Mac" toggle — reuses Ollama-tab chips. */}
      <div className="mb-ollama-toolbar">
        <div
          className="mb-ollama-chips"
          role="group"
          aria-label="Filter catalog by capability"
        >
          {CATEGORY_ORDER.map((c) => {
            const active = cats.has(c);
            const color = CAP_COLORS[c] ?? "#6b7280";
            return (
              <button
                key={c}
                type="button"
                className={`mb-ollama-chip ${active ? "active" : ""}`}
                onClick={() => toggleCat(c)}
                style={
                  active
                    ? {
                        background: `${color}33`,
                        color,
                        borderColor: `${color}88`,
                      }
                    : undefined
                }
                aria-pressed={active}
                data-testid={`catalog-cat-${c}`}
              >
                {CATEGORY_LABEL[c]}
              </button>
            );
          })}
        </div>
        {machine?.total_ram_gb ? (
          <label className="mb-catalog-fits-toggle">
            <input
              type="checkbox"
              checked={fitsOnly}
              onChange={(e) => setFitsOnly(e.target.checked)}
              data-testid="catalog-fits-only"
            />
            Fits my Mac
          </label>
        ) : null}
      </div>

      {totalShown === 0 && (
        <div className="mb-empty">No catalog models match your filters.</div>
      )}

      {SIZE_TIER_ORDER.map((tier) => {
        const entries = grouped.get(tier);
        if (!entries || entries.length === 0) return null;
        return (
          <div key={tier}>
            <div className="mb-section-title" data-testid={`catalog-tier-${tier}`}>
              {SIZE_TIER_LABEL[tier]} ({entries.length})
            </div>
            {entries.map((e) => (
              <CatalogCard
                key={e.id}
                entry={e}
                installed={installedIds.has(
                  isCloudEntry(e) ? resolveCloudPullId(e.id) : e.id,
                )}
                fit={fitTier(e, machine)}
                pull={pull}
                requestRemove={requestRemove}
                pulling={pulling}
                pullProgress={pullProgress}
                deleting={deleting}
                done={done}
                errors={errors}
                confirmDelete={confirmDelete}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function CatalogCard({
  entry,
  installed,
  fit,
  pull,
  requestRemove,
  pulling,
  pullProgress,
  deleting,
  done,
  errors,
  confirmDelete,
}: {
  entry: CatalogEntry;
  installed: boolean;
  fit: ReturnType<typeof fitTier>;
  pull: (name: string) => void;
  requestRemove: (name: string) => void;
  pulling: string | null;
  pullProgress?: OllamaPullProgress | null;
  deleting: string | null;
  done: Set<string>;
  errors: Map<string, string>;
  confirmDelete: string | null;
}) {
  const cloud = isCloudEntry(entry);
  // Cloud models aren't `<name>:cloud` uniformly — resolve the real pull tag
  // (known map → largest-size heuristic → bare :cloud) exactly like the Ollama
  // tab, so a one-click cloud install never 404s the manifest.
  const pullId = cloud ? resolveCloudPullId(entry.id) : entry.id;
  const isPulling = pulling === pullId;
  const isDeleting = deleting === pullId;
  const isDone = done.has(pullId);
  const err = errors.get(pullId) ?? errors.get(entry.id);

  return (
    <article
      className={`mb-card mb-ollama-card ${installed ? "installed" : ""}`}
      data-testid={`catalog-card-${entry.id}`}
    >
      <div className="mb-card-info">
        <div className="mb-card-top">
          <span className="mb-card-label">{entry.label}</span>
          <div className="mb-tags">
            {entry.tags.map((t) => (
              <TagChip key={t} label={t} />
            ))}
            {/* RAM-fit badge — same component/styling as the picker & wizard. */}
            {fit && (
              <span
                className="headroom-badge"
                data-tier={fit}
                data-testid={`catalog-fit-${entry.id}`}
                title={`Sized against your Mac's RAM: ${fitBadgeLabel(fit)}`}
              >
                {fitBadgeLabel(fit)}
              </span>
            )}
          </div>
        </div>
        <div className="mb-card-desc">{entry.desc}</div>
        <div className="mb-card-desc" style={{ fontSize: 11, opacity: 0.7 }}>
          {entry.id}
        </div>
        {cloud && !installed && (
          <div className="mb-ollama-cloudhint">
            <Cloud size={16} /> Cloud model — runs on Ollama's servers, no local
            download. First install opens Ollama sign-in in your browser
            automatically.
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
        <span className="mb-card-size">{entry.size}</span>
        {installed ? (
          <button
            className="mb-delete-btn"
            onClick={() => requestRemove(pullId)}
            disabled={isDeleting || !!deleting}
            title="Delete from disk"
          >
            {isDeleting ? (
              <span className="mb-spinner" />
            ) : confirmDelete === pullId ? (
              "Click again to confirm"
            ) : (
              <>
                <Trash2 size={14} /> Remove
              </>
            )}
          </button>
        ) : (
          <button
            className={`mb-pull-btn ${isDone ? "done" : ""}`}
            onClick={() => pull(pullId)}
            disabled={isPulling || !!pulling}
            data-testid={`catalog-install-${entry.id}`}
          >
            {isPulling ? (
              <span className="mb-spinner" />
            ) : isDone ? (
              <>
                <Check size={14} /> Done
              </>
            ) : cloud ? (
              "Get cloud"
            ) : (
              <>
                <Download size={14} /> Install
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}
