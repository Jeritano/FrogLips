import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/tauri-api";

/* ── Civitai browser tab ──────────────────────────────────────────────────
 *
 * Extracted from ModelBrowser. Owns its own debounced fetch / abort / state
 * so a search here is self-contained. Civitai is mostly diffusion (image
 * gen) — rows just deep-link out to civitai.com; nothing installs locally.
 */

interface CivitaiImage {
  url: string;
}

interface CivitaiFile {
  sizeKB?: number;
  primary?: boolean;
  pickleScanResult?: string;
  virusScanResult?: string;
  metadata?: { format?: string; size?: string; fp?: string };
  hashes?: { SHA256?: string; AutoV2?: string };
}

interface CivitaiVersion {
  name?: string;
  baseModel?: string;
  baseModelType?: string;
  files?: CivitaiFile[];
  images?: CivitaiImage[];
  publishedAt?: string;
  updatedAt?: string;
  trainedWords?: string[];
  availability?: string;
}

interface CivitaiModel {
  id: number;
  name: string;
  description?: string;
  type: string;
  nsfw: boolean;
  nsfwLevel?: number;
  tags?: string[];
  creator?: { username: string };
  stats?: {
    downloadCount?: number;
    thumbsUpCount?: number;
    ratingCount?: number;
    rating?: number;
    commentCount?: number;
    favoriteCount?: number;
  };
  modelVersions?: CivitaiVersion[];
  allowCommercialUse?: string | string[];
  allowDerivatives?: boolean;
  mode?: string;
}

const TAG_COLORS: Record<string, string> = {
  chat: "#3b82f6",
  code: "#22c55e",
  reasoning: "#a855f7",
  vision: "#f59e0b",
  embed: "#6b7280",
  tools: "#ec4899",
  math: "#06b6d4",
  rag: "#10b981",
  safety: "#f97316",
  uncensored: "#ef4444",
  cloud: "#0ea5e9",
  rp: "#d946ef",
  nsfw: "#dc2626",
};

function abbrev(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function fmtSize(kb?: number): string | null {
  if (!kb) return null;
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${kb} KB`;
}

// Civitai CDN URLs embed sizing as a path segment ("original=true" or "width=N").
// Rewrite to a small thumbnail size so we don't pull multi-MB originals.
function civitaiThumbUrl(url: string, width = 144): string {
  return url.replace(/\/(original=true|width=\d+|height=\d+|fit=[\w-]+)\//, `/width=${width}/`);
}

function relativeTime(iso?: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function parseCommercialUse(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  // Civitai returns Postgres array literal: "{Image,RentCivit,Rent}"
  return v.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

function civitaiLicenseShort(m: CivitaiModel): string {
  const commercial = parseCommercialUse(m.allowCommercialUse).length > 0;
  if (commercial && m.allowDerivatives) return "permissive";
  if (commercial && !m.allowDerivatives) return "comm-only";
  if (!commercial && m.allowDerivatives) return "non-comm";
  return "restricted";
}

interface Props {
  /** Filter text from the parent search box. */
  query: string;
}

export function CivitaiBrowserTab({ query }: Props) {
  const [civitaiModels, setCivitaiModels] = useState<CivitaiModel[]>([]);
  const [civitaiLoading, setCivitaiLoading] = useState(false);
  const [civitaiErr, setCivitaiErr] = useState<string | null>(null);
  const [civitaiVisible, setCivitaiVisible] = useState(20);

  const debounceRef = useRef<number | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  async function loadCivitai(q: string) {
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    setCivitaiLoading(true);
    setCivitaiErr(null);
    try {
      const params = new URLSearchParams({
        limit: "100",
        sort: "Highest Rated",
        types: "Checkpoint",
      });
      if (q.trim()) params.set("query", q.trim());
      const url = `https://civitai.com/api/v1/models?${params.toString()}`;
      const timeoutId = window.setTimeout(() => ctrl.abort(new DOMException("Civitai request timed out", "TimeoutError")), 15_000);
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally { window.clearTimeout(timeoutId); }
      if (!res.ok) throw new Error(`Civitai API ${res.status}`);
      const data = await res.json();
      if (ctrl.signal.aborted) return;
      const items = Array.isArray(data?.items) ? data.items.slice(0, 200) : [];
      setCivitaiModels(items);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setCivitaiErr(String(e?.message || e));
    } finally {
      if (fetchAbortRef.current === ctrl) fetchAbortRef.current = null;
      setCivitaiLoading(false);
    }
  }

  // Debounced fetch when query changes.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => loadCivitai(query), 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      fetchAbortRef.current?.abort();
    };
  }, [query]);

  // Reset pagination when results change (new search).
  useEffect(() => { setCivitaiVisible(20); }, [civitaiModels]);

  // Precompute resized thumbnail URLs once per fetch, not per render.
  const civitaiCards = useMemo(
    () => civitaiModels.slice(0, civitaiVisible).map((m) => {
      const url = m.modelVersions?.[0]?.images?.find((i) => i.url)?.url;
      return { m, thumbResized: url ? civitaiThumbUrl(url, 144) : null };
    }),
    [civitaiModels, civitaiVisible],
  );

  return (
    <>
      {civitaiLoading && civitaiModels.length === 0 && (
        <div className="mb-empty"><span className="mb-spinner mb-spinner-lg" /> Loading from Civitai…</div>
      )}
      {civitaiErr && (
        <div className="mb-empty mb-empty-err" role="alert">
          <div>Could not reach Civitai: {civitaiErr}</div>
          <button
            type="button"
            className="mb-retry-btn"
            onClick={() => void loadCivitai(query)}
          >
            Retry
          </button>
        </div>
      )}
      {!civitaiLoading && !civitaiErr && civitaiModels.length === 0 && (
        <div className="mb-empty">No Civitai models match "{query}"</div>
      )}
      {civitaiModels.length > 0 && (
        <div className="mb-empty" style={{ padding: "8px 0 12px", textAlign: "left", fontSize: 11 }}>
          Note: Civitai is mostly diffusion (image gen). Click "Open ↗" to view in browser — direct MLX loading not supported.
        </div>
      )}
      {civitaiCards.map(({ m, thumbResized }) => {
        const v0 = m.modelVersions?.[0];
        const baseModel = v0?.baseModel;
        const baseModelType = v0?.baseModelType;
        const primaryFile = v0?.files?.find((f) => f.primary) ?? v0?.files?.[0];
        const fileSize = fmtSize(primaryFile?.sizeKB);
        const fileFormat = primaryFile?.metadata?.format;
        const fileFp = primaryFile?.metadata?.fp;
        const fileQuant = primaryFile?.metadata?.size;
        const pickleOk = primaryFile?.pickleScanResult === "Success";
        const virusOk = primaryFile?.virusScanResult === "Success";
        const versionName = v0?.name;
        const triggerWords = (v0?.trainedWords ?? []).slice(0, 4);
        const desc = m.description ? stripHtml(m.description) : "";
        const descShort = desc.length > 140 ? desc.slice(0, 140).trim() + "…" : desc;
        const topTags = (m.tags ?? []).slice(0, 3);
        const tags: string[] = [m.type.toLowerCase()];
        if (m.nsfw) tags.push("nsfw");
        const licenseShort = civitaiLicenseShort(m);
        const published = relativeTime(v0?.publishedAt);
        const versionCount = m.modelVersions?.length ?? 0;

        return (
          <div key={m.id} className="mb-card civitai-card">
            {thumbResized && (
              <img
                className="civitai-thumb"
                src={thumbResized}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            )}
            <div className="mb-card-info">
              <div className="mb-card-top">
                <span className="mb-card-label">
                  {m.name}
                  {versionName && <span className="civitai-version"> · {versionName}</span>}
                </span>
                <div className="mb-tags">
                  {baseModel && (
                    <span className="mb-tag civitai-base">
                      {baseModel}{baseModelType && baseModelType !== "Standard" ? ` ${baseModelType}` : ""}
                    </span>
                  )}
                  {tags.map((t) => (
                    <span key={t} className="mb-tag" style={{ background: (TAG_COLORS[t] ?? "#6b7280") + "22", color: TAG_COLORS[t] ?? "#9ca3af" }}>
                      {t}
                    </span>
                  ))}
                  {fileFormat && (
                    <span
                      className="mb-tag"
                      title="File format"
                      style={{
                        background: fileFormat === "SafeTensor" ? "#22c55e22" : "#ef444422",
                        color: fileFormat === "SafeTensor" ? "#22c55e" : "#ef4444",
                      }}
                    >
                      {fileFormat}
                    </span>
                  )}
                  {topTags.map((t) => (
                    <span key={t} className="mb-tag civitai-soft">{t}</span>
                  ))}
                </div>
              </div>
              {descShort && <div className="mb-card-desc civitai-desc">{descShort}</div>}
              {triggerWords.length > 0 && (
                <div className="mb-card-desc" style={{ fontSize: 11 }}>
                  triggers: {triggerWords.map((w) => (
                    <code key={w} style={{
                      background: "var(--surface-hover)",
                      padding: "1px 5px",
                      borderRadius: 3,
                      marginRight: 4,
                      fontFamily: "SF Mono, Menlo, monospace",
                      fontSize: 10,
                    }}>{w}</code>
                  ))}
                </div>
              )}
              <div className="mb-card-desc civitai-stats">
                by <strong>{m.creator?.username ?? "unknown"}</strong>
                {m.stats?.downloadCount != null && <> · ↓ {abbrev(m.stats.downloadCount)}</>}
                {m.stats?.thumbsUpCount != null && <> · 👍 {abbrev(m.stats.thumbsUpCount)}</>}
                {m.stats?.commentCount != null && m.stats.commentCount > 0 && <> · 💬 {abbrev(m.stats.commentCount)}</>}
                {m.stats?.favoriteCount != null && m.stats.favoriteCount > 0 && <> · ★ {abbrev(m.stats.favoriteCount)}</>}
                {m.stats?.rating != null && m.stats.ratingCount != null && m.stats.ratingCount > 0 && (
                  <> · {m.stats.rating.toFixed(2)}/5 ({abbrev(m.stats.ratingCount)})</>
                )}
                {published && <> · pub {published}</>}
                {v0?.updatedAt && relativeTime(v0.updatedAt) && relativeTime(v0.updatedAt) !== published && (
                  <> · upd {relativeTime(v0.updatedAt)}</>
                )}
                {versionCount > 1 && <> · {versionCount} versions</>}
                {v0?.availability && v0.availability !== "Public" && <> · {v0.availability}</>}
                {m.mode && <> · {m.mode}</>}
                {" · license: "}<span title={`commercial: ${parseCommercialUse(m.allowCommercialUse).join(", ") || "no"}; derivatives: ${m.allowDerivatives ? "yes" : "no"}`}>{licenseShort}</span>
                {primaryFile?.hashes?.SHA256 && (
                  <span style={{ marginLeft: 6, opacity: 0.5, fontFamily: "var(--mono, monospace)", fontSize: 10 }}
                        title={`SHA256: ${primaryFile.hashes.SHA256}`}>
                    sha {primaryFile.hashes.SHA256.slice(0, 8)}
                  </span>
                )}
                {(!pickleOk || !virusOk) && (
                  <span style={{ color: "#ef4444", marginLeft: 6 }} title={`pickle: ${primaryFile?.pickleScanResult}, virus: ${primaryFile?.virusScanResult}`}>⚠ scan</span>
                )}
              </div>
            </div>
            <div className="mb-card-actions">
              {fileSize && (
                <span className="mb-card-size">
                  {fileSize}
                  {(fileQuant || fileFp) && <span style={{ display: "block", fontSize: 10, opacity: 0.7 }}>
                    {[fileQuant, fileFp].filter(Boolean).join(" · ")}
                  </span>}
                </span>
              )}
              <button
                className="mb-pull-btn"
                onClick={() => api.openExternal(`https://civitai.com/models/${m.id}`).catch(() => {})}
              >
                Open ↗
              </button>
            </div>
          </div>
        );
      })}
      {civitaiVisible < civitaiModels.length && (
        <div style={{ textAlign: "center", padding: "12px 0" }}>
          <button className="mb-pull-btn" onClick={() => setCivitaiVisible((n) => n + 20)}>
            Show more ({civitaiModels.length - civitaiVisible} remaining)
          </button>
        </div>
      )}
    </>
  );
}
