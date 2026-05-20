import { useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import type { AllModels, ModelEntry, ServerStatus } from "../types";
import { ModelBrowser } from "./ModelBrowser";

interface Props {
  status: ServerStatus | null;
  onStatusChange: (s: ServerStatus) => void;
}

function formatSize(bytes: number) {
  if (!bytes) return "";
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return ` (${v.toFixed(1)} ${units[i]})`;
}

export function ModelPicker({ status, onStatusChange }: Props) {
  const [models, setModels] = useState<AllModels>({ mlx: [], ollama: [] });
  const [selected, setSelected] = useState<ModelEntry | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { loadModels(); }, []);

  async function loadModels() {
    try {
      const m = await api.listAllModels();
      setModels(m);
      // Surface backend-specific list errors as a short hint, not a hard error
      const hints: string[] = [];
      if (m.ollama_error) hints.push(`Ollama: ${m.ollama_error}`);
      if (m.mlx_error) hints.push(`MLX: ${m.mlx_error}`);
      setErr(hints.length ? hints.join(" · ") : null);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    if (status?.model && status?.backend && !selected) {
      const all = [...models.mlx, ...models.ollama];
      const match = all.find(m => m.id === status.model && m.backend === status.backend);
      if (match) setSelected(match);
    }
  }, [status, models]);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === "__browse__") { setBrowserOpen(true); return; }
    const [backend, ...rest] = v.split(":");
    const id = rest.join(":");
    const all = [...models.mlx, ...models.ollama];
    const entry = all.find(m => m.id === id && m.backend === backend);
    setSelected(entry ?? null);
  }

  async function start() {
    if (!selected) return;
    setBusy(true); setErr(null);
    try {
      const s = await api.startServer(selected.id, selected.backend);
      onStatusChange(s);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    try {
      await api.stopServer();
      onStatusChange(await api.serverStatus());
    } finally { setBusy(false); }
  }

  const selValue = selected ? `${selected.backend}:${selected.id}` : "";

  return (
    <>
      <div className="model-picker">
        <select value={selValue} onChange={onChange} disabled={busy || !!status?.running}>
          <option value="">— pick a model —</option>
          {models.ollama.length > 0 && (
            <optgroup label="Ollama (local)">
              {models.ollama.map((m) => (
                <option key={`ollama:${m.id}`} value={`ollama:${m.id}`}>{m.id}</option>
              ))}
            </optgroup>
          )}
          {models.mlx.length > 0 && (
            <optgroup label="MLX / HuggingFace">
              {models.mlx.map((m) => (
                <option key={`mlx:${m.id}`} value={`mlx:${m.id}`}>
                  {m.id}{formatSize(m.size_bytes)}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Add model">
            <option value="__browse__">⬇ Browse &amp; download models…</option>
          </optgroup>
        </select>

        {status?.running ? (
          <button onClick={stop} disabled={busy}>Stop</button>
        ) : (
          <button onClick={start} disabled={busy || !selected} className="start-btn">Start</button>
        )}
        <span className={`status-dot ${status?.running ? "on" : "off"}`} />
        <span className="status-text">
          {status?.running
            ? status.ready
              ? `${status.backend} · ${status.model}`
              : `loading · ${status.backend} · ${status.model}`
            : "stopped"}
        </span>
        {err && <div className="error">{err}</div>}
      </div>

      {browserOpen && (
        <ModelBrowser
          onClose={() => setBrowserOpen(false)}
          onPulled={() => { loadModels(); setBrowserOpen(false); }}
        />
      )}
    </>
  );
}
