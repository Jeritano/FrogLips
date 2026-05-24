import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { isNonChatRepo } from "../lib/chat-model-filter";
import type { AllModels, ModelEntry, ServerStatus } from "../types";

// ModelBrowser bundles three large tabs (HF, Civitai, GGUF) plus their data
// fetchers. Lazy-load so the picker shell stays in the first-paint chunk and
// the browser only downloads when the user opens "Browse & download models".
const ModelBrowser = lazy(() =>
  import("./ModelBrowser").then((m) => ({ default: m.ModelBrowser })),
);

interface Props {
  status: ServerStatus | null;
  onStatusChange: (s: ServerStatus) => void;
  /**
   * The model that was used in the currently-selected conversation. When the
   * user picks an old conversation we restore that model in the dropdown so
   * the next message goes to the same backend they had last time. If the
   * model is no longer installed we silently fall back (no-op).
   */
  desiredModel?: string | null;
}

function formatSize(bytes: number) {
  if (!bytes) return "";
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return ` (${v.toFixed(1)} ${units[i]})`;
}

export function ModelPicker({ status, onStatusChange, desiredModel }: Props) {
  const [models, setModels] = useState<AllModels>({ mlx: [], ollama: [] });
  const [selected, setSelected] = useState<ModelEntry | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nativeRepo, setNativeRepo] = useState<string | null>(null);
  // Native models load in-process (no host:port), so their progress only
  // surfaces via Tauri events rather than the polled ServerStatus.
  const [nativeLoading, setNativeLoading] = useState<string | null>(null);

  useEffect(() => { loadModels(); }, []);

  // Native models load in-process: progress only surfaces via Tauri events.
  useTauriEvent<string>("native-loading", useCallback((e) => setNativeLoading(e.payload), []));
  useTauriEvent<string>("native-loaded", useCallback(() => setNativeLoading(null), []));

  async function loadModels() {
    try {
      const m = await api.listAllModels();
      // Strip image-gen weight sets + their dep encoders even if the Rust
      // backend filter is missing (older binary). Matches the patterns in
      // `is_non_chat_repo` in src-tauri/src/models.rs — keep in sync.
      const filtered: AllModels = {
        ...m,
        mlx: m.mlx.filter((entry) => !isNonChatRepo(entry.id)),
      };
      setModels(filtered);
      // Surface backend-specific list errors as a short hint, not a hard error
      const hints: string[] = [];
      if (m.ollama_error) hints.push(`Ollama: ${m.ollama_error}`);
      if (m.mlx_error) hints.push(`MLX: ${m.mlx_error}`);
      setErr(hints.length ? hints.join(" · ") : null);
    } catch (e) {
      setErr(`Could not list installed models: ${e}`);
    }
  }

  useEffect(() => {
    if (status?.model && status?.backend && !selected) {
      const all = [...models.mlx, ...models.ollama];
      const match = all.find(m => m.id === status.model && m.backend === status.backend);
      if (match) setSelected(match);
    }
  }, [status, models]);

  // Tracks the desiredModel value already restored, so a restore that can't
  // run yet (models still loading) retries once models arrive — even if
  // status.running flipped true in between.
  const appliedDesiredRef = useRef<string | null>(null);

  // Restore the model used in the currently-selected conversation. Fires
  // whenever the parent passes a new `desiredModel` (i.e. user clicked
  // another conversation in the sidebar). Skips the swap if:
  //   - desiredModel is null/empty (new chat — leave picker alone)
  //   - the model isn't installed anymore (stale config — silent fallback)
  //   - the model is already what's running/selected (no-op)
  //   - a model is currently running (don't yank under the user's feet)
  useEffect(() => {
    if (!desiredModel) {
      appliedDesiredRef.current = null;
      return;
    }
    // A fresh desiredModel resets the applied marker so the new value gets
    // its own restore attempt.
    if (appliedDesiredRef.current !== desiredModel) {
      appliedDesiredRef.current = null;
    }
    if (status?.running) return;
    if (selected?.id === desiredModel) {
      appliedDesiredRef.current = desiredModel;
      return;
    }
    if (appliedDesiredRef.current === desiredModel) return;
    const all = [...models.mlx, ...models.ollama];
    const match = all.find((m) => m.id === desiredModel);
    if (match) {
      setSelected(match);
      appliedDesiredRef.current = desiredModel;
    }
    // Not found yet = models may still be loading; leave the marker unset so
    // the effect retries when `models` populates. Stale config silently
    // keeps whatever was there once models are confirmed loaded.
  }, [desiredModel, models, selected, status?.running]);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === "__browse__") { setBrowserOpen(true); return; }
    if (v === "__native__") {
      // window.prompt is blocked in the Tauri webview — use an inline input.
      setNativeRepo((r) => r ?? "NousResearch/Llama-3.2-1B");
      return;
    }
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
      if (selected.backend === "native") {
        await api.nativeLoadModel(selected.id);
        // Synthesize a status object — native runs in-process, no host:port.
        onStatusChange({
          running: true,
          ready: true,
          model: selected.id,
          backend: "native",
          host: "",
          port: 0,
          last_error: null,
        });
      } else {
        const s = await api.startServer(selected.id, selected.backend);
        onStatusChange(s);
        // startServer can resolve with a non-running status when the backend
        // process failed to come up — surface last_error so the user sees why.
        if (!s.running) {
          setErr(
            s.last_error
              ? `Could not start ${selected.backend}: ${s.last_error}`
              : `${selected.backend} did not start. Check that the backend is installed and the model "${selected.id}" exists.`,
          );
        }
      }
    } catch (e) {
      setErr(`Could not start "${selected.id}" on ${selected.backend}: ${e}. Press Start to retry.`);
    }
    finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    try {
      if (status?.backend === "native") {
        await api.nativeUnloadModel();
        onStatusChange({
          running: false,
          ready: false,
          model: null,
          backend: null,
          host: "",
          port: 0,
          last_error: null,
        });
      } else {
        await api.stopServer();
        onStatusChange(await api.serverStatus());
      }
    } catch (e) {
      setErr(`Could not stop the model: ${e}`);
    } finally { setBusy(false); }
  }

  const selValue = selected ? `${selected.backend}:${selected.id}` : "";

  return (
    <>
      <div className="model-picker">
        {/* Off-screen target for the global Cmd+L shortcut (App.tsx). */}
        <button
          type="button"
          data-shortcut="open-library"
          className="sr-only-shortcut"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setBrowserOpen(true)}
        />
        <select
          data-shortcut="focus-model"
          value={selValue}
          onChange={onChange}
          onMouseDown={() => { void loadModels(); }}
          onFocus={() => { void loadModels(); }}
          disabled={busy || !!status?.running}
        >
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
        </select>
        {/* UX re-review U-C3 / H6: the previous design tucked
            "__native__" + "__browse__" as side-effect options INSIDE the
            <select>, so selecting them mutated surrounding UI (opened a
            repo input or a heavy modal). Assistive tech announced them
            as model choices. Split into real buttons so the dropdown
            contains only models. */}
        <button
          type="button"
          className="topbar-btn topbar-action-secondary"
          onClick={() => setNativeRepo((r) => r ?? "NousResearch/Llama-3.2-1B")}
          title="Load a HuggingFace model into the in-process Metal native runtime"
          data-testid="model-picker-load-native"
          disabled={busy || !!status?.running}
        >
          ⚡ Native…
        </button>
        <button
          type="button"
          className="topbar-btn topbar-action-secondary"
          data-shortcut="open-library"
          onClick={() => setBrowserOpen(true)}
          title="Browse & download models (HuggingFace, Civitai, Ollama)"
          data-testid="model-picker-open-library"
          disabled={busy || !!status?.running}
        >
          ⬇ Browse
        </button>

        {nativeRepo !== null && (
          <>
            <input
              type="text"
              value={nativeRepo}
              placeholder="HuggingFace repo id"
              aria-label="HuggingFace repo id for native inference"
              autoFocus
              onChange={(e) => setNativeRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nativeRepo.trim()) {
                  setSelected({ id: nativeRepo.trim(), size_bytes: 0, backend: "native" });
                  setNativeRepo(null);
                } else if (e.key === "Escape") {
                  setNativeRepo(null);
                }
              }}
            />
            <button
              onClick={() => {
                if (nativeRepo.trim()) {
                  setSelected({ id: nativeRepo.trim(), size_bytes: 0, backend: "native" });
                  setNativeRepo(null);
                }
              }}
              disabled={!nativeRepo.trim()}
            >
              Use
            </button>
            <button onClick={() => setNativeRepo(null)}>Cancel</button>
          </>
        )}

        {status?.running ? (
          <button onClick={stop} disabled={busy}>Stop</button>
        ) : (
          <button onClick={start} disabled={busy || !selected} className="start-btn">Start</button>
        )}
        <span
          className={`status-dot ${status?.running ? "on" : "off"}`}
          role="img"
          aria-label={status?.running ? "Server running" : "Server stopped"}
        />
        <span className="status-text">
          {nativeLoading
            ? "loading · native"
            : status?.running
              ? status.ready
                ? `${status.backend} · running`
                : `loading · ${status.backend}`
              : "stopped"}
        </span>
        {err && (
          <div className="error" role="alert">
            <span>{err}</span>
            <button
              type="button"
              className="error-retry"
              onClick={() => { setErr(null); void loadModels(); }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {browserOpen && (
        <Suspense fallback={<div className="lazy-loading">Loading model browser…</div>}>
          <ModelBrowser
            // Always re-list on close: the user may have pulled / removed
            // models via a path that didn't fire onPulled (e.g. CLI alongside
            // the app, or a remove). Cheaper than missing freshly-installed
            // entries.
            onClose={() => { setBrowserOpen(false); loadModels(); }}
            onPulled={() => { loadModels(); setBrowserOpen(false); }}
          />
        </Suspense>
      )}
    </>
  );
}
