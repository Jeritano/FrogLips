import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ModelEntry } from "../types";
import { api } from "../lib/tauri-api";
import { loadAllPresets } from "../lib/agent-presets";
import { loadRoutes, saveRoutes, type ChatRoute } from "../lib/chat-router";

/**
 * Editor for the multi-model chat router's route table. A route binds a
 * "when to use" description (+ optional keyword fast-path) to a target
 * model/backend and Role. Stored in localStorage (see chat-router.ts).
 *
 * Mirrors the CustomBackendsSettings add/list/remove pattern.
 */
export function RoutesSettings({ onClose }: { onClose: () => void }) {
  const [routes, setRoutes] = useState<ChatRoute[]>(() => loadRoutes());
  const [models, setModels] = useState<ModelEntry[]>([]);
  const presets = loadAllPresets();

  useEffect(() => {
    let cancelled = false;
    api
      .listAllModels()
      .then((m) => {
        if (!cancelled) setModels([...m.mlx, ...m.ollama]);
      })
      .catch(() => {/* dropdown falls back to free-text pin */});
    return () => {
      cancelled = true;
    };
  }, []);

  function persist(next: ChatRoute[]) {
    setRoutes(next);
    saveRoutes(next);
  }

  function addRoute() {
    const id = `route-${crypto.randomUUID().slice(0, 8)}`;
    persist([
      ...routes,
      { id, label: "New route", whenToUse: "", model: "", backend: "ollama", preset: null },
    ]);
  }

  function update(id: string, patch: Partial<ChatRoute>) {
    persist(routes.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function remove(id: string) {
    persist(routes.filter((r) => r.id !== id));
  }

  function setDefault(id: string) {
    persist(routes.map((r) => ({ ...r, isDefault: r.id === id })));
  }

  return (
    <div className="routes-panel">
      <div className="routes-panel-head">
        <span className="routes-panel-title">Model routes</span>
        <button type="button" className="wf-form-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <p className="routes-panel-hint">
        Auto-route picks the best-fit route per message. A route = a model + Role and a
        "when to use" description the classifier reads. Optional keywords give an instant
        fast-path. Mark one route as the default fallback. Fast multi-model routing works
        best with Ollama (loads on demand) and cloud backends.
      </p>

      {routes.length === 0 && (
        <p className="routes-empty">No routes yet — add one to start auto-routing.</p>
      )}

      <div className="routes-list">
        {routes.map((r) => (
          <div key={r.id} className="route-card">
            <div className="route-card-row">
              <input
                className="route-label-input"
                value={r.label}
                placeholder="Label (e.g. Coder)"
                onChange={(e) => update(r.id, { label: e.target.value })}
              />
              <label className="route-default">
                <input
                  type="radio"
                  name="route-default"
                  checked={r.isDefault === true}
                  onChange={() => setDefault(r.id)}
                />
                default
              </label>
              <button type="button" className="wf-btn" onClick={() => remove(r.id)} title="Remove route">
                <X size={14} />
              </button>
            </div>
            <textarea
              className="route-when-input"
              rows={2}
              value={r.whenToUse}
              placeholder="When to use… (e.g. questions about code, debugging, programming)"
              onChange={(e) => update(r.id, { whenToUse: e.target.value })}
            />
            <input
              className="route-kw-input"
              value={(r.keywords ?? []).join(", ")}
              placeholder="Keywords for instant routing (comma-separated, optional)"
              onChange={(e) =>
                update(r.id, {
                  keywords: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
            <div className="route-card-row">
              <select
                className="route-model-select"
                value={r.model ? `${r.backend}::${r.model}` : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  const sep = v.indexOf("::");
                  if (sep < 0) return;
                  const backend = (v.slice(0, sep) || "ollama") as ChatRoute["backend"];
                  update(r.id, { backend, model: v.slice(sep + 2) });
                }}
              >
                <option value="">Pick a model…</option>
                {models.map((m) => (
                  <option key={`${m.backend}::${m.id}`} value={`${m.backend}::${m.id}`}>
                    {m.id} ({m.backend})
                  </option>
                ))}
                {r.model && !models.some((m) => m.id === r.model) && (
                  <option value={`${r.backend}::${r.model}`}>
                    {r.model} ({r.backend})
                  </option>
                )}
              </select>
              <select
                className="route-preset-select"
                value={r.preset ?? ""}
                onChange={(e) => update(r.id, { preset: e.target.value || null })}
              >
                <option value="">No role</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="wf-btn wf-btn-primary" onClick={addRoute} style={{ marginTop: 8 }}>
        + Add route
      </button>
    </div>
  );
}
