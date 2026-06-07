import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, Trash2, X } from "lucide-react";
import type { ModelEntry, ServerStatus } from "../types";
import { api } from "../lib/tauri-api";
import { loadAllPresets } from "../lib/agent-presets";
import {
  createConfig,
  deleteConfig,
  duplicateConfig,
  getActiveConfigId,
  loadConfigs,
  routeChatMessage,
  setActiveConfigId,
  updateConfig,
  type ChatRoute,
  type RouteDecision,
} from "../lib/chat-router";

/**
 * Editor for the multi-model router's CONFIGURATIONS + routes.
 *
 * A configuration is a named, note-able bundle of routes ("Hybrid cloud+local",
 * "All-local private", …). The active config drives chat routing. Each route
 * binds a model/backend/Role to a "when to use" description, optional keyword
 * fast-path triggers, and optional example utterances (embedded into a
 * prototype for the semantic stage). The Test box runs the real router so the
 * user can see + calibrate which route a message would take.
 */
export function RoutesSettings({
  status,
  onClose,
}: {
  status: ServerStatus | null;
  onClose: () => void;
}) {
  const [configs, setConfigs] = useState(() => loadConfigs());
  const [activeId, setActiveId] = useState<string | null>(() => getActiveConfigId());
  const [models, setModels] = useState<ModelEntry[]>([]);
  const presets = loadAllPresets();

  const active = useMemo(
    () => configs.find((c) => c.id === activeId) ?? configs[0] ?? null,
    [configs, activeId],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .listAllModels()
      .then((m) => {
        if (!cancelled) setModels([...m.mlx, ...m.ollama]);
      })
      .catch(() => {/* dropdowns fall back to a free-text pin */});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Re-read storage after a CRUD op so state matches what the router sees. */
  function refresh() {
    setConfigs(loadConfigs());
    setActiveId(getActiveConfigId());
  }

  function switchTo(id: string) {
    setActiveConfigId(id);
    setActiveId(id);
  }

  function newConfig() {
    createConfig("New configuration");
    refresh();
  }

  function patchActive(patch: Partial<{ label: string; notes: string; routes: ChatRoute[] }>) {
    if (!active) return;
    updateConfig(active.id, patch);
    refresh();
  }

  function updateRoute(routeId: string, patch: Partial<ChatRoute>) {
    if (!active) return;
    patchActive({ routes: active.routes.map((r) => (r.id === routeId ? { ...r, ...patch } : r)) });
  }

  function addRoute() {
    if (!active) return;
    const route: ChatRoute = {
      id: `route-${crypto.randomUUID().slice(0, 8)}`,
      label: "New route",
      whenToUse: "",
      model: "",
      backend: "ollama",
      preset: null,
    };
    patchActive({ routes: [...active.routes, route] });
  }

  function removeRoute(routeId: string) {
    if (!active) return;
    patchActive({ routes: active.routes.filter((r) => r.id !== routeId) });
  }

  function setDefaultRoute(routeId: string) {
    if (!active) return;
    patchActive({ routes: active.routes.map((r) => ({ ...r, isDefault: r.id === routeId })) });
  }

  return (
    <div className="routes-panel">
      <div className="routes-panel-head">
        <span className="routes-panel-title">Router configurations</span>
        <button type="button" className="wf-form-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {/* ── Configuration switcher + actions ── */}
      <div className="routes-config-bar">
        <select
          className="routes-config-select"
          value={active?.id ?? ""}
          onChange={(e) => switchTo(e.target.value)}
          disabled={configs.length === 0}
        >
          {configs.length === 0 && <option value="">No configurations</option>}
          {configs.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        <button type="button" className="routes-config-action" onClick={newConfig} title="New configuration">
          <Plus size={14} /> New
        </button>
        <button
          type="button"
          className="routes-config-action"
          onClick={() => { if (active) { duplicateConfig(active.id); refresh(); } }}
          disabled={!active}
          title="Duplicate this configuration"
        >
          <Copy size={14} /> Duplicate
        </button>
        <button
          type="button"
          className="routes-config-action danger"
          onClick={() => { if (active) { deleteConfig(active.id); refresh(); } }}
          disabled={!active}
          title="Delete this configuration"
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>

      {!active ? (
        <p className="routes-empty">No configurations yet — click <strong>New</strong> to create one.</p>
      ) : (
        <>
          {/* Rename + notes for the active config */}
          <input
            className="routes-config-name"
            value={active.label}
            placeholder="Configuration name"
            onChange={(e) => patchActive({ label: e.target.value })}
          />
          <details className="routes-notes" open={!!active.notes}>
            <summary>Notes</summary>
            <textarea
              rows={2}
              placeholder="Why / when to use this configuration…"
              value={active.notes ?? ""}
              onChange={(e) => patchActive({ notes: e.target.value })}
            />
          </details>

          <p className="routes-panel-hint">
            Auto-route picks the best-fit route per message: keyword fast-path →
            semantic match (from utterances) → LLM classifier → default. Fast
            multi-model routing works best with Ollama (loads on demand) and cloud
            backends. Mark one route as the default fallback.
          </p>

          {active.routes.length === 0 && (
            <p className="routes-empty">No routes yet — add one to start auto-routing.</p>
          )}

          <div className="routes-list">
            {active.routes.map((r) => (
              <div key={r.id} className="route-card">
                <div className="route-card-row">
                  <input
                    className="route-label-input"
                    value={r.label}
                    placeholder="Label (e.g. Coder)"
                    onChange={(e) => updateRoute(r.id, { label: e.target.value })}
                  />
                  <label className="route-default">
                    <input
                      type="radio"
                      name={`route-default-${active.id}`}
                      checked={r.isDefault === true}
                      onChange={() => setDefaultRoute(r.id)}
                    />
                    default
                  </label>
                  <button type="button" className="wf-btn" onClick={() => removeRoute(r.id)} title="Remove route">
                    <X size={14} />
                  </button>
                </div>
                <textarea
                  className="route-when-input"
                  rows={2}
                  value={r.whenToUse}
                  placeholder="When to use… (e.g. questions about code, debugging, programming)"
                  onChange={(e) => updateRoute(r.id, { whenToUse: e.target.value })}
                />
                <input
                  className="route-kw-input"
                  value={(r.keywords ?? []).join(", ")}
                  placeholder="Keywords for instant routing (comma-separated, optional)"
                  onChange={(e) =>
                    updateRoute(r.id, {
                      keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                />
                <textarea
                  className="route-utt-input"
                  rows={2}
                  value={(r.utterances ?? []).join("\n")}
                  placeholder="Example messages for semantic routing — one per line (e.g. 'fix this stack trace')"
                  onChange={(e) =>
                    updateRoute(r.id, {
                      utterances: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
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
                      updateRoute(r.id, { backend, model: v.slice(sep + 2) });
                    }}
                  >
                    <option value="">Pick a model…</option>
                    {models.map((m) => (
                      <option key={`${m.backend}::${m.id}`} value={`${m.backend}::${m.id}`}>
                        {m.id} ({m.backend})
                      </option>
                    ))}
                    {r.model && !models.some((m) => m.id === r.model) && (
                      <option value={`${r.backend}::${r.model}`}>{r.model} ({r.backend})</option>
                    )}
                  </select>
                  <select
                    className="route-preset-select"
                    value={r.preset ?? ""}
                    onChange={(e) => updateRoute(r.id, { preset: e.target.value || null })}
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

          {/* ── Test routing ── */}
          <RouteTester status={status} routes={active.routes} />
        </>
      )}
    </div>
  );
}

/** Live "what would this route to?" tester for the active config. */
function RouteTester({ status, routes }: { status: ServerStatus | null; routes: ChatRoute[] }) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<RouteDecision | "none" | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!q.trim() || routes.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const st: ServerStatus =
        status ?? { running: false, ready: false, model: null, backend: "ollama", host: "127.0.0.1", port: 11434 };
      const d = await routeChatMessage(q, routes, { status: st, stickyRouteId: null });
      setResult(d ?? "none");
    } catch {
      setResult("none");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="routes-tester">
      <span className="routes-tester-title">Test routing</span>
      <div className="routes-tester-row">
        <input
          value={q}
          placeholder="Type a message to see which route it takes…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
        />
        <button type="button" className="wf-btn" onClick={run} disabled={busy || !q.trim() || routes.length === 0}>
          {busy ? "Testing…" : "Test"}
        </button>
      </div>
      {result === "none" && <div className="routes-tester-result none">No route matched.</div>}
      {result && result !== "none" && (
        <div className="routes-tester-result">
          → <strong>{result.label}</strong> · <code>{result.model}</code>
          <span className="route-method"> · {result.method}</span>
          {result.reason && <span className="routes-tester-reason"> — {result.reason}</span>}
        </div>
      )}
    </div>
  );
}
