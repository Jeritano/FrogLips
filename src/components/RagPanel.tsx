import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
import type { RagCorpusInfo, RagHit, RagIngestReport } from "../types";

/* ── RAG (project knowledge) settings pane ──────────────────────────────
 *
 * Lets the user index a local folder and inspect/delete existing corpora.
 * Indexing runs synchronously on the backend (no streaming progress yet — a
 * 10k-file repo takes 5–20s); the UI shows a spinner + final report.
 *
 * The picker is a plain text input for v1.2 — Tauri's dialog plugin isn't
 * yet in this app's dependency tree. Drag-drop support is exposed via
 * Tauri's webview file-drop event (handled below).
 */

interface Props {
  /** Called whenever a corpus is added/removed so the parent can refresh. */
  onCorporaChanged?: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtAge(unix: number): string {
  if (!unix) return "—";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unix);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function RagPanel({ onCorporaChanged }: Props) {
  const [corpora, setCorpora] = useState<RagCorpusInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Ingest form
  const [draftName, setDraftName] = useState("");
  const [draftRoot, setDraftRoot] = useState("");
  const [draftGlob, setDraftGlob] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);

  // Debug search
  const [searchCorpus, setSearchCorpus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<RagHit[]>([]);
  const [searching, setSearching] = useState(false);
  // Tauri 2 webview disables window.confirm — use an inline two-click pattern
  // for corpus deletion so the destructive flow can't short-circuit silently.
  const deleteConfirm = useTwoClickConfirm();

  const refresh = useCallback(async () => {
    try {
      const list = await api.ragListCorpora();
      setCorpora(Array.isArray(list) ? list : []);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleIngest = useCallback(async () => {
    const name = draftName.trim();
    const root = draftRoot.trim();
    if (!name || !root) {
      setErr("Name and folder path are required.");
      return;
    }
    setIngesting(true);
    setErr(null);
    setInfo(null);
    try {
      const report: RagIngestReport = await api.ragIngestFolder(
        name,
        root,
        draftGlob.trim() || undefined,
      );
      setInfo(
        `Indexed '${name}': ${report.files_indexed}/${report.files_seen} files → ` +
          `${report.chunks_created} chunks (${fmtBytes(report.total_bytes)}) ` +
          `in ${report.duration_ms} ms.`,
      );
      setDraftName("");
      setDraftRoot("");
      setDraftGlob("");
      await refresh();
      onCorporaChanged?.();
    } catch (e) {
      setErr(`Ingest failed: ${e}`);
    } finally {
      setIngesting(false);
    }
  }, [draftName, draftRoot, draftGlob, refresh, onCorporaChanged]);

  const handleDelete = useCallback(
    async (name: string) => {
      try {
        await api.ragDeleteCorpus(name);
        await refresh();
        onCorporaChanged?.();
      } catch (e) {
        setErr(`Delete failed: ${e}`);
      }
    },
    [refresh, onCorporaChanged],
  );

  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    const c = searchCorpus.trim();
    if (!q || !c) {
      setErr("Pick a corpus and enter a query.");
      return;
    }
    setSearching(true);
    setErr(null);
    try {
      const hits = await api.ragSearch(c, q, 5);
      setSearchHits(hits);
    } catch (e) {
      setErr(`Search failed: ${e}`);
      setSearchHits([]);
    } finally {
      setSearching(false);
    }
  }, [searchCorpus, searchQuery]);

  return (
    <div className="rag-panel" data-testid="rag-panel">
      <h4 className="rag-title">Project knowledge (RAG)</h4>
      <p className="rag-intro">
        Index a local folder so the agent can semantically search it via{" "}
        <code>search_project_knowledge</code>.
      </p>

      {err && (
        <div role="alert" className="rag-msg rag-msg-err">
          {err}
        </div>
      )}
      {info && (
        <div className="rag-msg rag-msg-info" role="status">{info}</div>
      )}

      {/* Ingest form */}
      <div
        ref={dropZoneRef}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          // Best-effort web drop. Tauri's webview also delivers paths via the
          // 'tauri://file-drop' event — this branch is a fallback for when
          // the browser exposes a usable path through dataTransfer.
          const items = e.dataTransfer?.items;
          if (items && items.length > 0) {
            for (const it of Array.from(items)) {
              const f = it.getAsFile?.();
              const p = (f as unknown as { path?: string })?.path;
              if (typeof p === "string" && p.length > 0) {
                setDraftRoot(p);
                if (!draftName.trim()) {
                  const last = p.split("/").filter(Boolean).pop() ?? "";
                  setDraftName(last);
                }
                break;
              }
            }
          }
        }}
        className={`rag-ingest-form${dragOver ? " drag-over" : ""}`}
      >
        <input
          type="text"
          placeholder="Corpus name (e.g. my-project)"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          disabled={ingesting}
          data-testid="rag-name"
        />
        <input
          type="text"
          placeholder="Absolute folder path (e.g. /Users/me/Code/my-project)"
          value={draftRoot}
          onChange={(e) => setDraftRoot(e.target.value)}
          disabled={ingesting}
          data-testid="rag-root"
        />
        <input
          type="text"
          placeholder="Optional glob filter (e.g. **/*.{ts,tsx})"
          value={draftGlob}
          onChange={(e) => setDraftGlob(e.target.value)}
          disabled={ingesting}
        />
        <button
          onClick={handleIngest}
          disabled={ingesting || !draftName.trim() || !draftRoot.trim()}
          data-testid="rag-ingest"
        >
          {ingesting ? "Indexing…" : "Ingest folder"}
        </button>
      </div>

      {/* Corpora list */}
      <div className="rag-corpora">
        {corpora.length === 0 ? (
          <div className="rag-empty">No corpora indexed yet.</div>
        ) : (
          <table className="rag-table">
            <thead>
              <tr>
                <th className="rag-col-l">Name</th>
                <th className="rag-col-r">Chunks</th>
                <th className="rag-col-r">Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {corpora.map((c) => (
                <tr key={c.id} data-testid={`rag-row-${c.name}`}>
                  <td title={c.root_path}>{c.name}</td>
                  <td className="rag-col-r">{c.chunk_count}</td>
                  <td className="rag-col-r">{fmtAge(c.updated_at)}</td>
                  <td className="rag-col-r">
                    <button
                      onClick={() =>
                        deleteConfirm.request(c.name, (n) => { void handleDelete(n); })
                      }
                      title={
                        deleteConfirm.armed === c.name
                          ? "Click again to confirm deletion"
                          : "Delete corpus"
                      }
                      aria-label={
                        deleteConfirm.armed === c.name
                          ? `Click again to confirm deleting ${c.name}`
                          : `Delete ${c.name}`
                      }
                    >
                      {deleteConfirm.labelFor(c.name, "×")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Debug search */}
      {corpora.length > 0 && (
        <div className="rag-search">
          <div className="rag-search-label">
            Test search (debug):
          </div>
          <div className="rag-search-row">
            <select
              value={searchCorpus}
              onChange={(e) => setSearchCorpus(e.target.value)}
              className="rag-search-corpus"
              aria-label="Corpus to search"
            >
              <option value="">— pick —</option>
              {corpora.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Query"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rag-search-query"
              data-testid="rag-query"
            />
            <button
              onClick={handleSearch}
              disabled={searching || !searchCorpus || !searchQuery.trim()}
              data-testid="rag-search-btn"
            >
              {searching ? "…" : "Search"}
            </button>
          </div>
          {searchHits.length > 0 && (
            <ol className="rag-hits">
              {searchHits.map((h, i) => (
                <li key={i}>
                  <div className="rag-hit-path">
                    {h.path}{" "}
                    <span className="rag-hit-score">
                      ({h.score.toFixed(3)})
                    </span>
                  </div>
                  <div className="rag-hit-snippet">
                    {h.snippet}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
