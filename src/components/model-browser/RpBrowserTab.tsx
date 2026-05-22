import { useMemo } from "react";

/* ── RP / Kobold browser tab ──────────────────────────────────────────────
 *
 * Extracted from ModelBrowser. Renders the curated RP/SillyTavern finetune
 * catalog (all on HuggingFace). Presentational sibling: the shared
 * pull/delete/confirm state stays owned by ModelBrowser and flows in.
 */

interface CatalogEntry {
  id: string;
  label: string;
  size: string;
  tags: string[];
  desc: string;
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

/* ───────────────────────────────────────────────────────────────────────────
   RP / Kobold / SillyTavern curated finetunes. All live on HuggingFace.
   ─────────────────────────────────────────────────────────────────────── */
export const RP_CATALOG: CatalogEntry[] = [
  // TheDrummer — top RP author
  { id: "TheDrummer/Anubis-70B-v1",             label: "Anubis 70B v1",            size: "~43 GB", tags: ["rp"],               desc: "TheDrummer's flagship Llama 3.3 RP tune" },
  { id: "TheDrummer/Skyfall-36B-v2",            label: "Skyfall 36B v2",           size: "~22 GB", tags: ["rp"],               desc: "Solar-arch RP, balanced creativity" },
  { id: "TheDrummer/Cydonia-24B-v2.1",          label: "Cydonia 24B v2.1",         size: "~14 GB", tags: ["rp"],               desc: "Mistral Small RP tune, very popular" },
  { id: "TheDrummer/Big-Tiger-Gemma-27B-v1",    label: "Big Tiger Gemma 27B",      size: "~16 GB", tags: ["rp"],               desc: "Gemma 2 27B RP tune" },
  { id: "TheDrummer/Rocinante-12B-v1.1",        label: "Rocinante 12B v1.1",       size: "~7 GB",  tags: ["rp"],               desc: "Nemo-12B compact RP model" },
  { id: "TheDrummer/UnslopNemo-12B-v4",         label: "UnslopNemo 12B v4",        size: "~7 GB",  tags: ["rp"],               desc: "Nemo finetune, removes GPT-isms" },
  { id: "TheDrummer/Tiger-Gemma-9B-v3",         label: "Tiger Gemma 9B v3",        size: "~5 GB",  tags: ["rp"],               desc: "Compact Gemma 2 RP tune" },

  // Sao10K — classic finetuner
  { id: "Sao10K/L3.3-70B-Euryale-v2.3",         label: "Euryale v2.3 70B",         size: "~43 GB", tags: ["rp"],               desc: "Llama 3.3 RP, top-tier" },
  { id: "Sao10K/L3-8B-Stheno-v3.2",             label: "Stheno v3.2 8B",           size: "~5 GB",  tags: ["rp"],               desc: "Llama 3 RP classic, fast" },
  { id: "Sao10K/L3-8B-Lunaris-v1",              label: "Lunaris v1 8B",            size: "~5 GB",  tags: ["rp"],               desc: "Llama 3 RP, balanced" },
  { id: "Sao10K/Fimbulvetr-11B-v2",             label: "Fimbulvetr 11B v2",        size: "~6 GB",  tags: ["rp"],               desc: "Solar 11B classic RP tune" },
  { id: "Sao10K/72B-Qwen2.5-Kunou-v1",          label: "Kunou 72B v1",             size: "~47 GB", tags: ["rp"],               desc: "Qwen2.5 72B RP tune" },

  // Anthracite (Magnum series)
  { id: "anthracite-org/magnum-v4-72b",         label: "Magnum v4 72B",            size: "~47 GB", tags: ["rp"],               desc: "Literary-prose Qwen2.5 tune" },
  { id: "anthracite-org/magnum-v4-22b",         label: "Magnum v4 22B",            size: "~14 GB", tags: ["rp"],               desc: "Mistral Small Magnum" },
  { id: "anthracite-org/magnum-v4-12b",         label: "Magnum v4 12B",            size: "~7 GB",  tags: ["rp"],               desc: "Nemo Magnum, compact" },

  // ReadyArt — uncensored RP
  { id: "ReadyArt/Forgotten-Safeword-70B-v5.0", label: "Forgotten Safeword 70B",   size: "~43 GB", tags: ["rp", "uncensored"], desc: "Heavy uncensored Llama 3.3 RP" },
  { id: "ReadyArt/Forgotten-Abomination-70B-v5.0", label: "Forgotten Abomination 70B", size: "~43 GB", tags: ["rp", "uncensored"], desc: "Sister tune of Safeword, edgier" },

  // Community favorites
  { id: "LatitudeGames/Wayfarer-12B",           label: "Wayfarer 12B",             size: "~7 GB",  tags: ["rp"],               desc: "AI Dungeon's open RP model" },
  { id: "inflatebot/MN-12B-Mag-Mell-R1",        label: "Mag-Mell 12B R1",          size: "~7 GB",  tags: ["rp"],               desc: "Strong Nemo RP merge" },
  { id: "nbeerbower/Mistral-Nemo-Gutenberg-Doppel-12B", label: "Gutenberg Doppel 12B", size: "~7 GB", tags: ["rp"],          desc: "Literary-tuned Nemo" },
  { id: "crestf411/MS-sunfall-v0.5.0",          label: "Sunfall MS v0.5",          size: "~14 GB", tags: ["rp"],               desc: "Mistral Small sunfall series" },
  { id: "aetherwiing/MN-12B-Starcannon-v3",     label: "Starcannon 12B v3",        size: "~7 GB",  tags: ["rp"],               desc: "Nemo merge for creative RP" },
  { id: "KatyTheCutie/EstopianMaid-13B",        label: "EstopianMaid 13B",         size: "~7 GB",  tags: ["rp"],               desc: "Classic Llama 2 13B RP" },
  { id: "Doctor-Shotgun/L3.3-70B-Magnum-v5-Twilight", label: "Magnum v5 Twilight 70B", size: "~43 GB", tags: ["rp"],         desc: "Magnum + Twilight merge" },
  { id: "SicariusSicariiStuff/Negative_LLAMA_70B", label: "Negative LLAMA 70B",    size: "~43 GB", tags: ["rp", "uncensored"], desc: "Heavy debias Llama 3 70B" },
  { id: "mlabonne/NeuralDaredevil-8B-abliterated", label: "NeuralDaredevil 8B",    size: "~5 GB",  tags: ["uncensored"],       desc: "mlabonne abliterated DPO tune" },
];

function filterCatalog(list: CatalogEntry[], query: string): CatalogEntry[] {
  if (!query.trim()) return list;
  const q = query.toLowerCase();
  return list.filter((e) =>
    e.label.toLowerCase().includes(q) ||
    e.id.toLowerCase().includes(q) ||
    e.desc.toLowerCase().includes(q) ||
    e.tags.some((t) => t.includes(q))
  );
}

interface Props {
  query: string;
  installedMlxIds: Set<string>;
  pulling: string | null;
  deleting: string | null;
  done: Set<string>;
  errors: Map<string, string>;
  /** id currently armed for two-click delete confirm. */
  confirmDelete: string | null;
  pull: (id: string) => void;
  requestRemove: (id: string) => void;
}

export function RpBrowserTab({
  query,
  installedMlxIds,
  pulling,
  deleting,
  done,
  errors,
  confirmDelete,
  pull,
  requestRemove,
}: Props) {
  const filteredRp = useMemo(() => filterCatalog(RP_CATALOG, query), [query]);

  return (
    <>
      {filteredRp.length === 0 && (
        <div className="mb-empty">No RP models match "{query}"</div>
      )}
      {filteredRp.map((entry) => {
        const isPulling = pulling === entry.id;
        const isDeleting = deleting === entry.id;
        const isDone = done.has(entry.id);
        const isInstalled = installedMlxIds.has(entry.id);
        const err = errors.get(entry.id);
        return (
          <div key={entry.id} className={`mb-card ${isInstalled ? "installed" : ""}`}>
            <div className="mb-card-info">
              <div className="mb-card-top">
                <span className="mb-card-label">{entry.label}</span>
                <div className="mb-tags">
                  {entry.tags.map((t) => (
                    <span key={t} className="mb-tag" style={{ background: (TAG_COLORS[t] ?? "#6b7280") + "22", color: TAG_COLORS[t] ?? "#9ca3af" }}>
                      {t}
                    </span>
                  ))}
                  {isInstalled && (
                    <span className="mb-tag mb-installed-tag" title="Already pulled">✓ installed</span>
                  )}
                </div>
              </div>
              <div className="mb-card-desc">{entry.desc}</div>
              <div className="mb-card-desc" style={{ opacity: 0.6, fontSize: 11 }}>{entry.id}</div>
              {err && <div className="mb-card-err">{err}</div>}
            </div>
            <div className="mb-card-actions">
              <span className="mb-card-size">{entry.size}</span>
              {isInstalled ? (
                <button
                  className="mb-delete-btn"
                  onClick={() => requestRemove(entry.id)}
                  disabled={isDeleting || !!deleting}
                >
                  {isDeleting ? <span className="mb-spinner" /> : (confirmDelete === entry.id ? "Click again to confirm" : "🗑 Remove")}
                </button>
              ) : (
                <button
                  className={`mb-pull-btn ${isDone ? "done" : ""}`}
                  onClick={() => pull(entry.id)}
                  disabled={isPulling || !!pulling}
                >
                  {isPulling ? <span className="mb-spinner" /> : isDone ? "✓ Done" : "Pull"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
