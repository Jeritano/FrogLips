import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import { useModalA11y } from "../lib/use-modal-a11y";
import { logDiag } from "../lib/diagnostics";

interface ORModel {
  id: string;
  name: string;
  context_length: number;
  prompt_price: string;
  completion_price: string;
  vision: boolean;
}

interface Props {
  onClose: () => void;
  /** Called with the chosen OpenRouter model id. Parent activates it
   *  (status.backend = "openrouter", status.model = id). */
  onSelect: (modelId: string) => void;
}

/**
 * OpenRouter model browser — the "simple as Ollama/HF" path.
 *
 * Flow: enter the API key ONCE (gated; stored in the Keychain via Rust),
 * then scroll the live catalogue, filter, click a model → go. No
 * per-model base_url/model forms. One key, browse, select.
 */
export function OpenRouterPicker({ onClose, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open: true, onClose, containerRef: ref });

  const [hasKey, setHasKey] = useState<boolean | null>(null); // null = checking
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<ORModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const loadModels = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setModels(await api.openrouterListModels());
    } catch (e) {
      setErr(`Couldn't load the OpenRouter catalogue: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.openrouterHasKey()
      .then((has) => {
        if (cancelled) return;
        setHasKey(has);
        if (has) void loadModels();
      })
      .catch(() => { if (!cancelled) setHasKey(false); });
    return () => { cancelled = true; };
  }, [loadModels]);

  async function saveKey() {
    const k = keyDraft.trim();
    if (!k) return;
    try {
      await api.openrouterSetKey(k);
      setKeyDraft("");
      setHasKey(true);
      void loadModels();
    } catch (e) {
      setErr(`Couldn't save key: ${e}`);
      logDiag({ level: "warn", source: "openrouter", message: "set key failed", detail: e });
    }
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [models, filter]);

  return (
    <div
      className="memories-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="OpenRouter models"
    >
      <div ref={ref} className="memories-modal openrouter-modal">
        <div className="memories-modal-header">
          <span>OpenRouter</span>
          <button onClick={onClose} aria-label="Close" className="memories-close">×</button>
        </div>

        {hasKey === null ? (
          <div className="lazy-loading">Checking…</div>
        ) : !hasKey ? (
          <div className="openrouter-keygate">
            <p className="profile-intro">
              Enter your OpenRouter API key once. It's stored in the macOS
              Keychain and never leaves this machine except to OpenRouter.
              Get one at <code>openrouter.ai/keys</code>.
            </p>
            <div className="openrouter-key-row">
              <input
                type="password"
                value={keyDraft}
                placeholder="sk-or-..."
                aria-label="OpenRouter API key"
                autoFocus
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); }}
              />
              <button className="agent-settings-btn primary" disabled={!keyDraft.trim()} onClick={saveKey}>
                Save key
              </button>
            </div>
            {err && <div className="image-error-row" role="alert">{err}</div>}
          </div>
        ) : (
          <>
            <input
              className="conv-search openrouter-filter"
              type="search"
              placeholder="Filter models…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {loading && <div className="lazy-loading">Loading catalogue…</div>}
            {err && (
              <div className="image-error-row" role="alert">
                {err} <button className="mb-retry-btn" onClick={() => void loadModels()}>Retry</button>
              </div>
            )}
            <div className="openrouter-list">
              {shown.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="openrouter-row"
                  onClick={() => { onSelect(m.id); onClose(); }}
                  title={m.id}
                >
                  <div className="openrouter-row-main">
                    <span className="openrouter-row-name">{m.name}</span>
                    {m.vision && <span className="openrouter-chip">vision</span>}
                  </div>
                  <div className="openrouter-row-meta">
                    <code>{m.id}</code>
                    <span>{(m.context_length / 1000).toFixed(0)}K ctx</span>
                    {m.prompt_price && (
                      <span>{m.prompt_price === "free" ? "free" : `${m.prompt_price}/${m.completion_price} per 1M`}</span>
                    )}
                  </div>
                </button>
              ))}
              {!loading && shown.length === 0 && !err && (
                <div className="mb-empty">No models match.</div>
              )}
            </div>
            <button
              className="agent-settings-btn"
              style={{ marginTop: 8 }}
              onClick={() => { setHasKey(false); }}
            >
              Change API key
            </button>
          </>
        )}
      </div>
    </div>
  );
}
