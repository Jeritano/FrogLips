import { EmptyState } from "../EmptyState";
import { Package, Trash2 } from "lucide-react";
import type { GgufFile, ModelEntry } from "../../types";

/* ── Installed-models tab ─────────────────────────────────────────────────
 *
 * Extracted from ModelBrowser. Presentational sibling (mirrors the
 * OllamaLibraryView precedent): the live model lists + the shared
 * delete/error/confirm state stay owned by ModelBrowser and flow in as
 * props, since the Ollama / HF tabs share that delete flow.
 */

function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes === 0) return "—";
  return `${bytes} B`;
}

/** Parse `Q4_K_M`, `Q5_K_S`, `Q8_0`, `IQ3_XXS`, etc. from a GGUF filename. */
function parseGgufQuant(filename: string): string | null {
  const m = filename.match(/\b(IQ\d+_[A-Z]+|Q\d+_[A-Z0-9_]+|F16|F32|BF16)\b/i);
  return m ? m[1].toUpperCase() : null;
}

interface Props {
  installedOllama: ModelEntry[];
  installedMlx: ModelEntry[];
  ggufInstalled: GgufFile[];
  installedErr: string | null;
  ggufInstalledErr: string | null;
  deleting: string | null;
  errors: Map<string, string>;
  /** id currently armed for two-click delete confirm. */
  confirmDelete: string | null;
  /** Filter text from the parent search box. */
  query: string;
  requestRemove: (id: string, backend: "ollama" | "mlx") => void;
  requestRemoveGguf: (repo: string, filename: string) => void;
  /** Re-runs the installed-model + GGUF scans. */
  onRetry: () => void;
}

export function InstalledModelsTab({
  installedOllama,
  installedMlx,
  ggufInstalled,
  installedErr,
  ggufInstalledErr,
  deleting,
  errors,
  confirmDelete,
  query,
  requestRemove,
  requestRemoveGguf,
  onRetry,
}: Props) {
  const total = installedOllama.length + installedMlx.length + ggufInstalled.length;

  return (
    <>
      {installedErr && (
        <div className="mb-empty mb-empty-err" role="alert">
          <div>Could not list installed models: {installedErr}</div>
          <button type="button" className="mb-retry-btn" onClick={onRetry}>Retry</button>
        </div>
      )}
      {total === 0 && (
        <EmptyState
          icon={<Package size={16} />}
          heading="No models installed"
          sub="Switch to Ollama or HuggingFace tabs above to pull a model."
        />
      )}
      {total > 0 && (
        <div className="mb-disk-summary">
          Total: <strong>
            {fmtBytes(
              installedOllama.reduce((s, m) => s + (m.size_bytes || 0), 0) +
              installedMlx.reduce((s, m) => s + (m.size_bytes || 0), 0) +
              ggufInstalled.reduce((s, f) => s + (f.size_bytes || 0), 0),
            )}
          </strong> across {total} models
        </div>
      )}
      {installedOllama.length > 0 && (
        <div className="mb-section-title">Ollama ({installedOllama.length})</div>
      )}
      {installedOllama
        .filter((m) => !query.trim() || m.id.toLowerCase().includes(query.toLowerCase()))
        .map((m) => {
          const isDeleting = deleting === m.id;
          const err = errors.get(m.id);
          const isCloud = m.id.endsWith(":cloud");
          return (
            <div key={`ol-${m.id}`} className="mb-card">
              <div className="mb-card-info">
                <div className="mb-card-top">
                  <span className="mb-card-label">{m.id}</span>
                  <div className="mb-tags">
                    <span
                      className="mb-tag"
                      style={{
                        background: "var(--mb-tag-ollama-bg, #3b82f622)",
                        color: "var(--mb-tag-ollama-fg, #3b82f6)",
                      }}
                    >
                      ollama
                    </span>
                    {isCloud && (
                      <span
                        className="mb-tag"
                        style={{
                          background: "var(--mb-tag-cloud-bg, #0ea5e922)",
                          color: "var(--mb-tag-cloud-fg, #0ea5e9)",
                        }}
                      >
                        cloud
                      </span>
                    )}
                  </div>
                </div>
                {err && <div className="mb-card-err">{err}</div>}
              </div>
              <div className="mb-card-actions">
                <span className="mb-card-size">{m.size_bytes > 0 ? fmtBytes(m.size_bytes) : (isCloud ? "cloud" : "—")}</span>
                <button
                  className="mb-delete-btn"
                  onClick={() => requestRemove(m.id, "ollama")}
                  disabled={isDeleting || !!deleting}
                  title="Delete from disk"
                >
                  {isDeleting ? <span className="mb-spinner" /> : (confirmDelete === m.id ? "Click again to confirm" : <><Trash2 size={14} /> Remove</>)}
                </button>
              </div>
            </div>
          );
        })}
      {installedMlx.length > 0 && (
        <div className="mb-section-title">MLX / HuggingFace ({installedMlx.length})</div>
      )}
      {installedMlx
        .filter((m) => !query.trim() || m.id.toLowerCase().includes(query.toLowerCase()))
        .map((m) => {
          const isDeleting = deleting === m.id;
          const err = errors.get(m.id);
          return (
            <div key={`mlx-${m.id}`} className="mb-card">
              <div className="mb-card-info">
                <div className="mb-card-top">
                  <span className="mb-card-label">{m.id}</span>
                  <div className="mb-tags">
                    <span
                      className="mb-tag"
                      style={{
                        background: "var(--mb-tag-mlx-bg, #a855f722)",
                        color: "var(--mb-tag-mlx-fg, #a855f7)",
                      }}
                    >
                      mlx
                    </span>
                  </div>
                </div>
                {err && <div className="mb-card-err">{err}</div>}
              </div>
              <div className="mb-card-actions">
                <span className="mb-card-size">{fmtBytes(m.size_bytes)}</span>
                <button
                  className="mb-delete-btn"
                  onClick={() => requestRemove(m.id, "mlx")}
                  disabled={isDeleting || !!deleting}
                  title="Delete from disk"
                >
                  {isDeleting ? <span className="mb-spinner" /> : (confirmDelete === m.id ? "Click again to confirm" : <><Trash2 size={14} /> Remove</>)}
                </button>
              </div>
            </div>
          );
        })}
      {ggufInstalled.length > 0 && (
        <div className="mb-section-title" data-testid="installed-gguf-title">
          GGUF (native) ({ggufInstalled.length})
        </div>
      )}
      {ggufInstalledErr && (
        <div className="mb-empty mb-empty-err" role="alert">
          <div>Could not list local GGUF files: {ggufInstalledErr}</div>
          <button type="button" className="mb-retry-btn" onClick={onRetry}>Retry</button>
        </div>
      )}
      {ggufInstalled
        .filter((f) =>
          !query.trim() ||
          f.filename.toLowerCase().includes(query.toLowerCase()) ||
          f.repo.toLowerCase().includes(query.toLowerCase()),
        )
        .map((f) => {
          const id = `gguf:${f.repo}/${f.filename}`;
          const isDeleting = deleting === id;
          const err = errors.get(id);
          const quant = parseGgufQuant(f.filename);
          return (
            <div key={id} className="mb-card" data-testid={`installed-gguf-card-${f.repo}-${f.filename}`}>
              <div className="mb-card-info">
                <div className="mb-card-top">
                  <span className="mb-card-label">{f.filename}</span>
                  <div className="mb-tags">
                    <span
                      className="mb-tag"
                      style={{
                        background: "var(--green-bg, #22c55e22)",
                        color: "var(--green, #22c55e)",
                      }}
                    >
                      gguf
                    </span>
                    {quant && <span className="mb-tag mb-tag-quant">{quant}</span>}
                  </div>
                </div>
                <div className="mb-card-desc" style={{ fontSize: 11, opacity: 0.7 }}>{f.repo}</div>
                {err && <div className="mb-card-err">{err}</div>}
              </div>
              <div className="mb-card-actions">
                <span className="mb-card-size">{fmtBytes(f.size_bytes)}</span>
                <button
                  className="mb-delete-btn"
                  onClick={() => requestRemoveGguf(f.repo, f.filename)}
                  disabled={isDeleting || !!deleting}
                  title="Delete GGUF from disk"
                >
                  {isDeleting ? <span className="mb-spinner" /> : (confirmDelete === id ? "Click again to confirm" : <><Trash2 size={14} /> Remove</>)}
                </button>
              </div>
            </div>
          );
        })}
    </>
  );
}
