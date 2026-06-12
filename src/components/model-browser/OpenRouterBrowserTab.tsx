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
  audio: boolean;
  tools: boolean;
  reasoning: boolean;
  description: string;
  moderated: boolean;
  max_output: number;
}

interface Props {
  /** External filter text from the Model Library search box. */
  query: string;
  /** Chosen OpenRouter model id → parent activates it + closes. */
  onSelect: (modelId: string) => void;
}

/**
 * OpenRouter source for the Model Library. The `/models` catalogue is PUBLIC —
 * browse it without a key. A key is only needed to actually RUN a model, so it
 * is surfaced as an optional "add to run these models" affordance, not a gate.
 * Stored in the local `secrets.json`. Same browse flow as Ollama/HF.
 */
export function OpenRouterBrowserTab({ query, onSelect }: Props) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  // A model the user picked while keyless — activated once a key is saved.
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [models, setModels] = useState<ORModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Picking a model = "connect" it (parent sets it active + closes). Browsing
  // is keyless, but RUNNING needs a key — so a keyless pick opens the key input
  // first, then activates on save.
  function pick(modelId: string) {
    if (hasKey) {
      onSelect(modelId);
    } else {
      setPendingSelect(modelId);
      setShowKeyInput(true);
    }
  }

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
    // Catalogue is public — load immediately, no key required to browse.
    void loadModels();
    api
      .openrouterHasKey()
      .then((has) => {
        if (!cancelled) setHasKey(has);
      })
      .catch(() => {
        if (!cancelled) setHasKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadModels]);

  async function saveKey() {
    const k = keyDraft.trim();
    if (!k) return;
    try {
      await api.openrouterSetKey(k);
      setKeyDraft("");
      setHasKey(true);
      setShowKeyInput(false);
      // If the key was entered to use a specific model, activate it now.
      if (pendingSelect) {
        const id = pendingSelect;
        setPendingSelect(null);
        onSelect(id);
      }
    } catch (e) {
      setErr(`Couldn't save key: ${e}`);
      logDiag({
        level: "warn",
        source: "openrouter",
        message: "set key failed",
        detail: e,
      });
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        (q === "tools" && m.tools) ||
        (q === "vision" && m.vision) ||
        (q === "reasoning" && m.reasoning) ||
        (q === "free" && m.prompt_price === "free"),
    );
  }, [models, query]);

  return (
    <>
      {/* Optional key affordance — browsing is free; a key is only needed to
          RUN a model. Never blocks the catalogue. */}
      {hasKey === false && (
        <div className="openrouter-keynote" style={{ flexWrap: "wrap" }}>
          {showKeyInput && pendingSelect && (
            <div style={{ width: "100%", marginBottom: 4 }}>
              Add your OpenRouter key to use <code>{pendingSelect}</code> (and
              any model):
            </div>
          )}
          {showKeyInput ? (
            <div className="openrouter-key-row">
              <input
                type="password"
                value={keyDraft}
                placeholder="sk-or-..."
                aria-label="OpenRouter API key"
                autoFocus
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveKey();
                }}
              />
              <button
                className="agent-settings-btn primary"
                disabled={!keyDraft.trim()}
                onClick={saveKey}
              >
                Save key
              </button>
              <button
                className="mcp-link"
                onClick={() => {
                  setShowKeyInput(false);
                  setKeyDraft("");
                  setPendingSelect(null);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <span>
              Browsing the public catalogue.{" "}
              <button
                className="mcp-link"
                onClick={() => setShowKeyInput(true)}
              >
                Add an API key
              </button>{" "}
              to run these models (get one at <code>openrouter.ai/keys</code>).
            </span>
          )}
        </div>
      )}
      {loading && <div className="lazy-loading">Loading catalogue…</div>}
      {err && (
        <div className="image-error-row" role="alert">
          {err}{" "}
          <button className="mb-retry-btn" onClick={() => void loadModels()}>
            Retry
          </button>
        </div>
      )}
      <div className="openrouter-list">
        {shown.map((m) => (
          <button
            key={m.id}
            type="button"
            className="openrouter-row"
            onClick={() => pick(m.id)}
            title={hasKey ? `Use ${m.id}` : `${m.id} — add an API key to use`}
          >
            <div className="openrouter-row-main">
              <span className="openrouter-row-name">{m.name}</span>
              {m.tools && (
                <span className="openrouter-chip or-chip-tools">tools</span>
              )}
              {m.reasoning && (
                <span className="openrouter-chip or-chip-reason">
                  reasoning
                </span>
              )}
              {m.vision && <span className="openrouter-chip">vision</span>}
              {m.audio && <span className="openrouter-chip">audio</span>}
              {m.prompt_price === "free" && (
                <span className="openrouter-chip or-chip-free">free</span>
              )}
              {!m.moderated && (
                <span className="openrouter-chip or-chip-unmod">
                  unmoderated
                </span>
              )}
            </div>
            {m.description && (
              <div className="openrouter-row-desc">{m.description}</div>
            )}
            <div className="openrouter-row-meta">
              <code>{m.id}</code>
              <span>{(m.context_length / 1000).toFixed(0)}K ctx</span>
              {m.max_output > 0 && (
                <span>{(m.max_output / 1000).toFixed(0)}K out</span>
              )}
              {m.prompt_price && (
                <span>
                  {m.prompt_price === "free"
                    ? "free"
                    : `${m.prompt_price}/${m.completion_price} per 1M`}
                </span>
              )}
            </div>
          </button>
        ))}
        {!loading && shown.length === 0 && !err && (
          <div className="mb-empty">No models match.</div>
        )}
      </div>
      {hasKey && !showKeyInput && (
        <button
          className="agent-settings-btn"
          style={{ marginTop: 8 }}
          onClick={() => setShowKeyInput(true)}
        >
          Change API key
        </button>
      )}
      {hasKey && showKeyInput && (
        <div className="openrouter-key-row" style={{ marginTop: 8 }}>
          <input
            type="password"
            value={keyDraft}
            placeholder="sk-or-..."
            aria-label="OpenRouter API key"
            autoFocus
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
          />
          <button
            className="agent-settings-btn primary"
            disabled={!keyDraft.trim()}
            onClick={saveKey}
          >
            Save key
          </button>
          <button
            className="mcp-link"
            onClick={() => {
              setShowKeyInput(false);
              setKeyDraft("");
              setPendingSelect(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
