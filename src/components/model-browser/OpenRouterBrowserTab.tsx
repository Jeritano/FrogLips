import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/tauri-api";
import { logDiag } from "../../lib/diagnostics";

interface ORModel {
  id: string;
  name: string;
  context_length: number;
  prompt_price: string;
  completion_price: string;
  vision: boolean;
}

interface Props {
  /** External filter text from the Model Library search box. */
  query: string;
  /** Chosen OpenRouter model id → parent activates it + closes. */
  onSelect: (modelId: string) => void;
}

/**
 * OpenRouter source for the Model Library. Enter the API key once
 * (Keychain), then scroll the live catalogue and click a model — same
 * flow as the Ollama/HF tabs. No per-model base_url/model forms.
 */
export function OpenRouterBrowserTab({ query, onSelect }: Props) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<ORModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [models, query]);

  if (hasKey === null) return <div className="lazy-loading">Checking…</div>;

  if (!hasKey) {
    return (
      <div className="openrouter-keygate">
        <p className="profile-intro">
          Enter your OpenRouter API key once. Stored in the macOS Keychain;
          never leaves this machine except to OpenRouter. Get one at{" "}
          <code>openrouter.ai/keys</code>.
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
    );
  }

  return (
    <>
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
            onClick={() => onSelect(m.id)}
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
        {!loading && shown.length === 0 && !err && <div className="mb-empty">No models match.</div>}
      </div>
      <button className="agent-settings-btn" style={{ marginTop: 8 }} onClick={() => setHasKey(false)}>
        Change API key
      </button>
    </>
  );
}
