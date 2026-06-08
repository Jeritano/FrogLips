import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { formatSizeParen as formatSize } from "../lib/format";
import { api } from "../lib/tauri-api";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useHardwareProfile } from "../hooks/useHardwareProfile";
import type { HeadroomTier } from "../lib/hardware-profile";
import { HardwareWarningBanner } from "./HardwareWarningBanner";
import type { AllModels, CustomBackend, ModelEntry, ServerStatus } from "../types";

/** Compact label for the inline headroom badge (full verdict on hover). */
const HEADROOM_SHORT: Record<HeadroomTier, string> = {
  comfortable: "Fits",
  tight: "Tight",
  thrash: "Heavy",
  impossible: "Too big",
};

// ModelBrowser bundles several large tabs (HF, GGUF, OpenRouter) plus their
// data fetchers. Lazy-load so the picker shell stays in the first-paint chunk and
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

export function ModelPicker({ status, onStatusChange, desiredModel }: Props) {
  const [models, setModels] = useState<AllModels>({ mlx: [], ollama: [] });
  const [selected, setSelected] = useState<ModelEntry | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Native models load in-process (no host:port), so their progress only
  // surfaces via Tauri events rather than the polled ServerStatus.
  const [nativeLoading, setNativeLoading] = useState<string | null>(null);
  // Configured custom OpenAI-compatible cloud backends (OpenRouter/Groq/…).
  // Loaded from settings; selecting one synthesizes a status (no local
  // process) and routes chat through `streamCustomChat`.
  const [customBackends, setCustomBackends] = useState<CustomBackend[]>([]);
  const [selectedCustom, setSelectedCustom] = useState<CustomBackend | null>(null);

  // Hardware-aware sizing: classify the picked model against this Mac's RAM so
  // the user sees an honest "fits / tight / too big" verdict BEFORE Start.
  const { headroomFor } = useHardwareProfile();

  // Timestamp of the last successful model-list fetch. The dropdown's
  // onFocus + onMouseDown both fire `loadModels` (so the list is fresh
  // when opened), but without a guard that's two full `listAllModels`
  // IPCs per open — and Ollama's `ollama list` shell-out is not free.
  // Skip a refetch when the cache is younger than STALE_MS unless the
  // caller forces it (post-pull / post-close, where the list genuinely
  // changed). Audit MED (2026-05-28).
  const lastLoadRef = useRef<number>(0);
  const LIST_STALE_MS = 30_000;

  useEffect(() => { void loadModels(true); }, []);

  // Load configured custom backends + refresh when settings change (the
  // settings panel emits `settings-changed` after a save).
  const loadCustomBackends = useCallback(async () => {
    try {
      const s = await api.settingsGet();
      setCustomBackends(s.custom_backends ?? []);
    } catch {
      setCustomBackends([]);
    }
  }, []);
  useEffect(() => { void loadCustomBackends(); }, [loadCustomBackends]);
  useTauriEvent<unknown>("settings-changed", useCallback(() => { void loadCustomBackends(); }, [loadCustomBackends]));

  // Native models load in-process: progress only surfaces via Tauri events.
  useTauriEvent<string>("native-loading", useCallback((e) => setNativeLoading(e.payload), []));
  useTauriEvent<string>("native-loaded", useCallback(() => setNativeLoading(null), []));
  // The backend emits `native-error` when an in-process load fails. Without a
  // listener the spinner sat on "loading · native" forever (only a later
  // SUCCESSFUL load cleared it). Clear it here too. MED (2026-05-29).
  useTauriEvent<{ model?: string; error?: string }>(
    "native-error",
    useCallback((e) => {
      setNativeLoading(null);
      if (e.payload?.error) setErr(`Could not load native model: ${e.payload.error}`);
    }, []),
  );

  async function loadModels(force = false) {
    // `performance.now()` is monotonic — immune to wall-clock jumps that
    // could otherwise make the cache look perpetually fresh or stale.
    const now = performance.now();
    if (!force && now - lastLoadRef.current < LIST_STALE_MS) {
      return; // cache still fresh; skip the redundant IPC
    }
    try {
      const m = await api.listAllModels();
      lastLoadRef.current = performance.now();
      setModels(m);
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
    // Custom cloud backend: value is `__custom__:<id>`. These aren't
    // ModelEntry rows; track them separately and clear the normal pick.
    if (v.startsWith("__custom__:")) {
      const id = v.slice("__custom__:".length);
      const cb = customBackends.find((b) => b.id === id) ?? null;
      setSelectedCustom(cb);
      setSelected(null);
      return;
    }
    const [backend, ...rest] = v.split(":");
    const id = rest.join(":");
    const all = [...models.mlx, ...models.ollama];
    const entry = all.find(m => m.id === id && m.backend === backend);
    setSelected(entry ?? null);
    setSelectedCustom(null);
  }

  async function start() {
    // Custom cloud backend: no local process to start — synthesize a
    // ready status. `model` carries the backend id so `useChatSend`'s
    // custom dispatch can resolve it; the chat header shows the friendly
    // name via the running pill text below.
    if (selectedCustom) {
      onStatusChange({
        running: true,
        ready: true,
        model: selectedCustom.id,
        backend: "custom",
        host: "",
        port: 0,
        last_error: null,
      });
      return;
    }
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
      // A failed native load rejects here; clear the in-process loading
      // spinner so it doesn't hang on "loading · native". MED (2026-05-29).
      setNativeLoading(null);
    }
    finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    try {
      if (status?.backend === "custom" || status?.backend === "openrouter") {
        // No local process — just clear the synthesized status.
        setSelectedCustom(null);
        onStatusChange({
          running: false, ready: false, model: null, backend: null,
          host: "", port: 0, last_error: null,
        });
      } else if (status?.backend === "native") {
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

  const selValue = selectedCustom
    ? `__custom__:${selectedCustom.id}`
    : selected
    ? `${selected.backend}:${selected.id}`
    : "";

  // Headroom verdict for the picked local model (cloud/custom have no size).
  const headroom = selected ? headroomFor(selected) : null;

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
          {customBackends.length > 0 && (
            <optgroup label="Custom (cloud)">
              {customBackends.map((b) => (
                <option key={`__custom__:${b.id}`} value={`__custom__:${b.id}`}>
                  ☁ {b.name}
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
          <button onClick={start} disabled={busy || (!selected && !selectedCustom)} className="start-btn">Start</button>
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
        {headroom?.label && !status?.running && (
          <span
            className="headroom-badge"
            data-tier={headroom.tier}
            title={`${headroom.label} — ${headroom.detail} of RAM`}
          >
            {HEADROOM_SHORT[headroom.tier]}
          </span>
        )}
        {err && (
          <div className="error" role="alert">
            <span>{err}</span>
            <button
              type="button"
              className="error-retry"
              onClick={() => { setErr(null); void loadModels(true); }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {!status?.running && <HardwareWarningBanner headroom={headroom} />}

      {browserOpen && (
        <Suspense fallback={<div className="lazy-loading">Loading model browser…</div>}>
          <ModelBrowser
            // Always re-list on close: the user may have pulled / removed
            // models via a path that didn't fire onPulled (e.g. CLI alongside
            // the app, or a remove). Cheaper than missing freshly-installed
            // entries.
            onClose={() => { setBrowserOpen(false); void loadModels(true); }}
            onPulled={() => { void loadModels(true); setBrowserOpen(false); }}
            onSelectOpenRouter={(modelId) => {
              // Cloud model — no local process. Activate immediately and
              // close the library; chat routes through the OpenRouter
              // built-in backend with this model.
              setBrowserOpen(false);
              onStatusChange({
                running: true,
                ready: true,
                model: modelId,
                backend: "openrouter",
                host: "",
                port: 0,
                last_error: null,
              });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
