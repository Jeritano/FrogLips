import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatSizeParen as formatSize } from "../lib/format";
import { api } from "../lib/tauri-api";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useSettingsField } from "../contexts/SettingsContext";
import { useHardwareProfile } from "../hooks/useHardwareProfile";
import type { HeadroomTier } from "../lib/hardware-profile";
import { suggestSmallerModel } from "../lib/hardware-profile";
import { HardwareWarningBanner } from "./HardwareWarningBanner";
import {
  classifyToolFitness,
  formatContextTokens,
  modelSupportsVision,
} from "../lib/model-capabilities";
import { modelContextTokens } from "../lib/agent-loop/context-manager";
import type {
  AllModels,
  CustomBackend,
  ModelEntry,
  ServerStatus,
} from "../types";

/**
 * Compact per-row capability suffix for an `<option>` label. Native `<option>`
 * elements render plain text only (no JSX), so capability hints in the dropdown
 * list itself are appended as a terse text tail: a context-window marker, a
 * vision marker, and a tool-calling caution. Resolved from the same name
 * heuristics the agent loop + composer already use (model-capabilities.ts /
 * context-manager.ts) — fast, backend-independent, and good enough for a hint.
 * The richer, colored badge cluster (incl. RAM headroom) is rendered as real
 * JSX for the CURRENTLY-SELECTED model beside the picker.
 */
function optionCapabilitySuffix(modelId: string): string {
  const parts: string[] = [];
  const ctx = formatContextTokens(modelContextTokens(modelId));
  if (ctx) parts.push(ctx);
  if (modelSupportsVision(modelId)) parts.push("vision");
  if (classifyToolFitness(modelId) === "weak") parts.push("weak tools");
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Payload of the `backend-gave-up` Tauri event (item 3) — mirrors
 * `BackendGaveUp` in `src-tauri/src/backend_process.rs`. Emitted once
 * auto-restart is exhausted so the picker can offer actionable recovery
 * instead of a dead-end terminal status.
 */
interface BackendGaveUp {
  model: string;
  backend: string;
  attempts: number;
  stderr_tail: string;
}

/** Compact label for the inline headroom badge (full verdict on hover). */
const HEADROOM_SHORT: Record<HeadroomTier, string> = {
  comfortable: "Fits",
  tight: "Tight",
  thrash: "Heavy",
  impossible: "Too big",
};

/**
 * Title-cased display name for a backend id. The raw status carries lowercase
 * backend strings ("ollama" / "mlx" / …); the status pill reads as a polished
 * product label ("Ollama", "MLX") rather than a debug token.
 */
const BACKEND_LABELS: Record<string, string> = {
  ollama: "Ollama",
  mlx: "MLX",
  native: "Native",
  custom: "Cloud",
  openrouter: "OpenRouter",
};

function backendLabel(backend: string | null | undefined): string {
  if (!backend) return "";
  return (
    BACKEND_LABELS[backend] ??
    backend.charAt(0).toUpperCase() + backend.slice(1)
  );
}

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
  /**
   * Self-healing send (2026-06-11): registers an imperative "start whatever
   * is selected" handle with the parent so the composer can warm the model
   * on first send instead of sitting disabled behind the Start ceremony.
   * Resolves true when the backend came up.
   */
  exposeStart?: (fn: () => Promise<boolean>) => void;
}

export function ModelPicker({
  status,
  onStatusChange,
  desiredModel,
  exposeStart,
}: Props) {
  const [models, setModels] = useState<AllModels>({ mlx: [], ollama: [] });
  const [selected, setSelected] = useState<ModelEntry | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Native models load in-process (no host:port), so their progress only
  // surfaces via Tauri events rather than the polled ServerStatus.
  const [nativeLoading, setNativeLoading] = useState<string | null>(null);
  // Item 3: terminal-failure recovery. Set from the `backend-gave-up` event
  // emitted after auto-restart is exhausted; drives the actionable recovery
  // panel (stderr tail + Retry + a smaller-model suggestion). Cleared on the
  // next successful start / stop.
  const [gaveUp, setGaveUp] = useState<BackendGaveUp | null>(null);
  // Configured custom OpenAI-compatible cloud backends (OpenRouter/Groq/…).
  // Sourced from the central settings store; selecting one synthesizes a
  // status (no local process) and routes chat through `streamCustomChat`. The
  // store owns the single `settings-changed` listener that used to live here,
  // so this slice refreshes automatically after any settings save.
  const customBackends = useSettingsField((s) => s?.custom_backends ?? []);
  const [selectedCustom, setSelectedCustom] = useState<CustomBackend | null>(
    null,
  );

  // Hardware-aware sizing: classify the picked model against this Mac's RAM so
  // the user sees an honest "fits / tight / too big" verdict BEFORE Start.
  // `profile` also drives the post-crash "try a smaller model" suggestion.
  const { headroomFor, profile } = useHardwareProfile();

  // Timestamp of the last successful model-list fetch. The dropdown's
  // onFocus + onMouseDown both fire `loadModels` (so the list is fresh
  // when opened), but without a guard that's two full `listAllModels`
  // IPCs per open — and Ollama's `ollama list` shell-out is not free.
  // Skip a refetch when the cache is younger than STALE_MS unless the
  // caller forces it (post-pull / post-close, where the list genuinely
  // changed). Audit MED (2026-05-28).
  const lastLoadRef = useRef<number>(0);
  const LIST_STALE_MS = 30_000;

  useEffect(() => {
    void loadModels(true);
  }, []);

  // Native models load in-process: progress only surfaces via Tauri events.
  useTauriEvent<string>(
    "native-loading",
    useCallback((e) => setNativeLoading(e.payload), []),
  );
  useTauriEvent<string>(
    "native-loaded",
    useCallback(() => setNativeLoading(null), []),
  );
  // The backend emits `native-error` when an in-process load fails. Without a
  // listener the spinner sat on "loading · native" forever (only a later
  // SUCCESSFUL load cleared it). Clear it here too. MED (2026-05-29).
  useTauriEvent<{ model?: string; error?: string }>(
    "native-error",
    useCallback((e) => {
      setNativeLoading(null);
      if (e.payload?.error)
        setErr(`Could not load native model: ${e.payload.error}`);
    }, []),
  );
  // Item 3: auto-restart exhausted. Surface the structured recovery payload so
  // the user gets the captured stderr tail, a Retry, and a fitting-model
  // suggestion instead of a silent dead status.
  useTauriEvent<BackendGaveUp>(
    "backend-gave-up",
    useCallback((e) => {
      if (e.payload?.model) setGaveUp(e.payload);
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
      const match = all.find(
        (m) => m.id === status.model && m.backend === status.backend,
      );
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
    if (v === "__browse__") {
      setBrowserOpen(true);
      return;
    }
    // Custom cloud backend: value is `__custom__:<id>`. These aren't
    // ModelEntry rows; track them separately and clear the normal pick.
    if (v.startsWith("__custom__:")) {
      const id = v.slice("__custom__:".length);
      const cb = customBackends.find((b) => b.id === id) ?? null;
      setSelectedCustom(cb);
      setSelected(null);
      // Live switch (self-healing send, 2026-06-11): picking a different
      // model while one runs swaps it in place — no Stop ceremony.
      if (cb && status?.running) void liveSwitch(null, cb);
      return;
    }
    const [backend, ...rest] = v.split(":");
    const id = rest.join(":");
    const all = [...models.mlx, ...models.ollama];
    const entry = all.find((m) => m.id === id && m.backend === backend);
    setSelected(entry ?? null);
    setSelectedCustom(null);
    if (entry && status?.running && entry.id !== status.model) {
      void liveSwitch(entry, null);
    }
  }

  /** Stop whatever runs, then start the given pick — one user gesture. */
  async function liveSwitch(
    entry: ModelEntry | null,
    cb: CustomBackend | null,
  ) {
    // M6: if the target is still downloading, start() bails AFTER stop() and
    // leaves NOTHING running where a model was working. Check before tearing
    // down the current model.
    if (entry && (entry.backend === "mlx" || entry.backend === "native")) {
      try {
        if (await api.modelDownloadActive(entry.id)) {
          setErr(
            `"${entry.id}" is still downloading — it'll be ready to Start once the pull finishes.`,
          );
          return;
        }
      } catch {
        // Non-fatal: fall through — start()/the Rust gate still backstop.
      }
    }
    await stop();
    await start(entry ?? undefined, cb ?? undefined);
  }

  /**
   * Start the given (or currently-selected) pick. Returns true when the
   * backend actually came up — the contract `exposeStart` consumers rely on.
   */
  async function start(
    entryArg?: ModelEntry,
    customArg?: CustomBackend,
  ): Promise<boolean> {
    const custom = customArg ?? selectedCustom;
    const entry = entryArg ?? selected;
    // Custom cloud backend: no local process to start — synthesize a
    // ready status. `model` carries the backend id so `useChatSend`'s
    // custom dispatch can resolve it; the chat header shows the friendly
    // name via the running pill text below.
    if (custom) {
      onStatusChange({
        running: true,
        ready: true,
        model: custom.id,
        backend: "custom",
        host: "",
        port: 0,
        last_error: null,
      });
      return true;
    }
    if (!entry) return false;
    // Don't start (or auto-start-on-select) a local model that is still being
    // pulled — launching the backend would spawn a SECOND HuggingFace download
    // racing the in-flight pull and corrupt it. The Rust side enforces this too
    // (backend_process::start refuses), but checking here avoids the failed
    // spawn and shows a gentle "still downloading" notice instead of an error.
    if (entry.backend === "mlx" || entry.backend === "native") {
      try {
        if (await api.modelDownloadActive(entry.id)) {
          setErr(
            `"${entry.id}" is still downloading — it'll be ready to Start once the pull finishes.`,
          );
          return false;
        }
      } catch {
        // Non-fatal: if the check itself fails, fall through — the Rust gate
        // still backstops the race.
      }
    }
    setBusy(true);
    setErr(null);
    // A fresh start attempt supersedes any prior gave-up recovery panel.
    setGaveUp(null);
    try {
      if (entry.backend === "native") {
        await api.nativeLoadModel(entry.id);
        // Synthesize a status object — native runs in-process, no host:port.
        onStatusChange({
          running: true,
          ready: true,
          model: entry.id,
          backend: "native",
          host: "",
          port: 0,
          last_error: null,
        });
        return true;
      }
      const s = await api.startServer(entry.id, entry.backend);
      onStatusChange(s);
      // startServer can resolve with a non-running status when the backend
      // process failed to come up — surface last_error so the user sees why.
      if (!s.running) {
        setErr(
          s.last_error
            ? `Could not start ${entry.backend}: ${s.last_error}`
            : `${entry.backend} did not start. Check that the backend is installed and the model "${entry.id}" exists.`,
        );
      }
      return !!s.running;
    } catch (e) {
      setErr(
        `Could not start "${entry.id}" on ${entry.backend}: ${e}. Press Start to retry.`,
      );
      // A failed native load rejects here; clear the in-process loading
      // spinner so it doesn't hang on "loading · native". MED (2026-05-29).
      setNativeLoading(null);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Hand the parent a fresh start handle every render so the closure always
  // sees the current selection (self-healing send).
  useEffect(() => {
    exposeStart?.(() => start());
  });

  async function stop() {
    setBusy(true);
    setGaveUp(null);
    try {
      if (status?.backend === "custom" || status?.backend === "openrouter") {
        // No local process — just clear the synthesized status.
        setSelectedCustom(null);
        onStatusChange({
          running: false,
          ready: false,
          model: null,
          backend: null,
          host: "",
          port: 0,
          last_error: null,
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
    } finally {
      setBusy(false);
    }
  }

  const selValue = selectedCustom
    ? `__custom__:${selectedCustom.id}`
    : selected
      ? `${selected.backend}:${selected.id}`
      : "";

  // Headroom verdict for the picked local model (cloud/custom have no size).
  const headroom = selected ? headroomFor(selected) : null;

  // Item 3 recovery: after auto-restart gives up, suggest the largest installed
  // model that comfortably fits this Mac and is smaller than the one that
  // failed (a likely OOM/too-big cause). Null when nothing better fits.
  const recoverySuggestion = gaveUp
    ? suggestSmallerModel(
        gaveUp.model,
        [...models.mlx, ...models.ollama],
        profile,
      )
    : null;

  /** Recovery action: pick + start the suggested smaller model. */
  async function startSuggested(entry: ModelEntry) {
    setSelected(entry);
    setSelectedCustom(null);
    await start(entry);
  }

  // Capability badges for the currently-selected pick (item 1). Cloud/custom
  // backends carry their model id in `selectedCustom`; resolve from whichever
  // is active. Uses the synchronous name heuristics (model-capabilities.ts /
  // context-manager.ts) — the same source the composer + agent loop already
  // trust as the safe fallback. Cloud/custom rows have no on-disk size, so the
  // RAM headroom badge above already self-suppresses for them.
  const badgeModelId = selected?.id ?? selectedCustom?.model ?? null;
  const caps = badgeModelId
    ? {
        tool: classifyToolFitness(badgeModelId),
        vision: modelSupportsVision(badgeModelId),
        ctx: formatContextTokens(modelContextTokens(badgeModelId)),
      }
    : null;

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
          onMouseDown={() => {
            void loadModels();
          }}
          onFocus={() => {
            void loadModels();
          }}
          disabled={busy}
        >
          <option value="">— pick a model —</option>
          {models.ollama.length > 0 && (
            <optgroup label="Ollama (local)">
              {models.ollama.map((m) => (
                <option key={`ollama:${m.id}`} value={`ollama:${m.id}`}>
                  {m.id}
                  {optionCapabilitySuffix(m.id)}
                </option>
              ))}
            </optgroup>
          )}
          {models.mlx.length > 0 && (
            <optgroup label="MLX / HuggingFace">
              {models.mlx.map((m) => (
                <option key={`mlx:${m.id}`} value={`mlx:${m.id}`}>
                  {m.id}
                  {formatSize(m.size_bytes)}
                  {optionCapabilitySuffix(m.id)}
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
          <button onClick={stop} disabled={busy}>
            Stop
          </button>
        ) : (
          <button
            onClick={() => void start()}
            disabled={busy || (!selected && !selectedCustom)}
            className="start-btn"
          >
            Start
          </button>
        )}
        <span
          className={`status-dot ${status?.running ? "on" : "off"}`}
          role="img"
          aria-label={status?.running ? "Server running" : "Server stopped"}
        />
        <span className="status-text">
          {nativeLoading
            ? "Loading · Native"
            : status?.running
              ? status.ready
                ? `${backendLabel(status.backend)} · Running`
                : `Loading · ${backendLabel(status.backend)}`
              : "Stopped"}
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
        {caps && !status?.running && (
          <>
            {caps.ctx && (
              <span
                className="cap-badge"
                title={`Estimated context window ≈ ${caps.ctx} tokens`}
              >
                {caps.ctx} ctx
              </span>
            )}
            {caps.vision && (
              <span
                className="cap-badge"
                title="This model can accept image attachments"
              >
                Vision
              </span>
            )}
            {caps.tool !== "untested" && (
              <span
                className={`cap-badge${caps.tool === "good" ? "" : " is-caution"}`}
                title={
                  caps.tool === "good"
                    ? "Reliable at tool calling — good for Agent mode & Flows"
                    : "Often mangles or skips tool calls — Agent mode may struggle"
                }
              >
                {caps.tool === "good" ? "Tools" : "Weak tools"}
              </span>
            )}
          </>
        )}
        {err && (
          <div className="error" role="alert">
            <span>{err}</span>
            <button
              type="button"
              className="error-retry"
              onClick={() => {
                setErr(null);
                void loadModels(true);
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {gaveUp && (
        <div className="backend-recovery" role="alert">
          <div className="backend-recovery-head">
            <strong>
              {gaveUp.model} ({gaveUp.backend}) kept crashing — auto-restart
              gave up after {gaveUp.attempts}{" "}
              {gaveUp.attempts === 1 ? "attempt" : "attempts"}.
            </strong>
            <button
              type="button"
              className="backend-recovery-dismiss"
              aria-label="Dismiss"
              onClick={() => setGaveUp(null)}
            >
              ✕
            </button>
          </div>
          <div className="backend-recovery-actions">
            <button
              type="button"
              className="start-btn"
              disabled={busy}
              onClick={() => {
                const entry = [...models.mlx, ...models.ollama].find(
                  (m) => m.id === gaveUp.model && m.backend === gaveUp.backend,
                );
                if (entry) void startSuggested(entry);
                else void start();
              }}
            >
              Retry {gaveUp.model}
            </button>
            {recoverySuggestion && (
              <button
                type="button"
                disabled={busy}
                title={`Switch to a model that fits this Mac comfortably (${formatSize(
                  recoverySuggestion.size_bytes,
                ).trim()})`}
                onClick={() => void startSuggested(recoverySuggestion)}
              >
                Try smaller: {recoverySuggestion.id}
              </button>
            )}
          </div>
          <p className="backend-recovery-hint">
            {recoverySuggestion
              ? "The model likely needs more memory than this Mac can give it. Try the smaller model above, or lower its context window."
              : "The model likely needs more memory than this Mac can give it, or its files are incomplete. Try re-downloading it or picking a smaller model."}
          </p>
          {gaveUp.stderr_tail.trim() && (
            <details className="backend-recovery-log">
              <summary>Show the last backend log lines</summary>
              <pre>{gaveUp.stderr_tail}</pre>
            </details>
          )}
        </div>
      )}

      {!status?.running && <HardwareWarningBanner headroom={headroom} />}

      {browserOpen && (
        <Suspense
          fallback={<div className="lazy-loading">Loading model browser…</div>}
        >
          <ModelBrowser
            // Always re-list on close: the user may have pulled / removed
            // models via a path that didn't fire onPulled (e.g. CLI alongside
            // the app, or a remove). Cheaper than missing freshly-installed
            // entries.
            onClose={() => {
              setBrowserOpen(false);
              void loadModels(true);
            }}
            onPulled={() => {
              void loadModels(true);
              setBrowserOpen(false);
            }}
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
