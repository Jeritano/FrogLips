import { useEffect, useState } from "react";
import { api } from "../../lib/tauri-api";
import { logDiag } from "../../lib/diagnostics";
import type { ImageGenOpts } from "../../types";
import type { ImageGenProgress } from "../../hooks/useImageGeneration";

interface Props {
  /** Submitted when the user clicks Generate. Parent owns the actual IPC call. */
  onGenerate: (args: { prompt: string; model: string; opts: ImageGenOpts }) => void;
  /** Whether a generate is currently running — drives disable + spinner state. */
  running: boolean;
  /** Live progress from the Rust event stream. */
  progress: ImageGenProgress;
  /** Last error message; null hides the inline error row. */
  error: string | null;
  /**
   * Optional controlled prompt-state pair. When provided, the parent owns
   * the prompt string — needed so the LoRA panel's trigger-word chips can
   * append text into the same textarea. When omitted, the panel falls back
   * to its original internal-state behavior (tests + standalone use).
   */
  prompt?: string;
  onPromptChange?: (next: string) => void;
  /**
   * Optional controlled model-state pair. The LoRA panel needs to know which
   * base model is currently selected (to pass as `baseRepo` to lora_merge)
   * and the ImageView needs to read the model so it can substitute in the
   * merged `<base>+lora:<sha>` id when a LoRA is applied.
   */
  model?: string;
  onModelChange?: (next: string) => void;
}

const SIZE_OPTIONS: ReadonlyArray<string> = [
  "512x512",
  "768x768",
  "1024x1024",
  "1024x1536",
  "1536x1024",
];

/**
 * Model options shown in the dropdown. The string `value` is sent verbatim to
 * the Rust side, which maps friendly shorthands to canonical HuggingFace
 * repo ids. Only the two upstream BFL repos are wired today — community
 * GGUF / single-file fp8 quants don't ship the multi-file safetensors
 * layout mistralrs 0.8.1's `FluxLoader` requires, so they fail with
 * "Expected at least 1 .safetensors file matching the FLUX regex".
 * Restoring them needs either a richer upstream loader or our own vendored
 * sampler.
 */
const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "schnell", label: "FLUX.1 schnell (fast, 4 steps)" },
  { value: "dev", label: "FLUX.1 dev (higher quality, 28 steps)" },
];

/**
 * Hints rotated through the status line during the cold-load phase. Until
 * BACK starts emitting structured `Loading{stage:"downloading", bytes, total}`
 * events, we cycle these messages on a short interval so the UI feels alive
 * during the 10+ minutes a fresh HF cache spends downloading weights.
 *
 * TODO(image-gen-back-ready): when `Loading{stage:"downloading"}` arrives,
 * surface a real "Downloading: X.X / Y.Y GB" line in place of these hints.
 */
const LOADING_HINTS: ReadonlyArray<string> = [
  "Loading FLUX weights…",
  "First run downloads ~14 GB from HuggingFace",
  "Subsequent runs are instant — model stays warm",
  "Initializing Metal kernels…",
];

/**
 * Composer + parameters for the Image view. Prompt is the only required input.
 * The "Advanced" disclosure was removed in the 2026-05-23 UI rework — mistralrs
 * 0.8.1 ignores steps/cfg/seed regardless, so surfacing those inputs misled
 * users into thinking the engine honored them. A single hint line under
 * Generate communicates the real defaults instead.
 */
export function ImagePromptPanel({
  onGenerate,
  running,
  progress,
  error,
  prompt: controlledPrompt,
  onPromptChange,
  model: controlledModel,
  onModelChange,
}: Props) {
  // Dual-mode prompt state: when the parent passes `prompt` + `onPromptChange`,
  // it owns the string (LoRA trigger-word chips need to append into it). When
  // unset, we keep the original internal-state behavior so existing call
  // sites and tests don't need updates.
  const [internalPrompt, setInternalPrompt] = useState("");
  const isPromptControlled = controlledPrompt !== undefined && onPromptChange !== undefined;
  const prompt = isPromptControlled ? controlledPrompt : internalPrompt;
  const setPrompt = (next: string) => {
    if (isPromptControlled) onPromptChange(next);
    else setInternalPrompt(next);
  };
  const [internalModel, setInternalModel] = useState<string>("schnell");
  const isModelControlled = controlledModel !== undefined && onModelChange !== undefined;
  const model = isModelControlled ? controlledModel : internalModel;
  const setModel = (next: string) => {
    if (isModelControlled) onModelChange(next);
    else setInternalModel(next);
  };
  const [size, setSize] = useState<string>("1024x1024");
  const [offload, setOffload] = useState(false);
  const [unloadStatus, setUnloadStatus] = useState<string | null>(null);
  const [unloadBusy, setUnloadBusy] = useState(false);
  // Index into LOADING_HINTS — rotated by an effect while running+loading.
  const [hintIdx, setHintIdx] = useState(0);

  const trimmedPrompt = prompt.trim();
  const canSubmit = !running && trimmedPrompt.length > 0;

  function submit() {
    if (!canSubmit) return;
    const opts: ImageGenOpts = {
      size,
      offload,
      // Steps/cfg/seed deliberately omitted — the engine ignores them and
      // surfacing the inputs misled users. The Rust side accepts a missing
      // field as "use defaults".
      // TODO(image-gen-back-ready): re-add when C1/M1 land and the seed/steps
      // controls actually drive the sampler.
      steps: null,
      cfg: null,
      seed: null,
    };
    onGenerate({ prompt: trimmedPrompt, model, opts });
  }

  async function unloadModel() {
    setUnloadStatus(null);
    setUnloadBusy(true);
    try {
      // L-F7 cleanup (2026-05-28): `imageUnload` IPC is stable on `api`;
      // dropped the feature-detect path.
      await api.imageUnload();
      setUnloadStatus("Model unloaded. Next generate will reload (~30-90s).");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUnloadStatus(`Unload failed: ${msg}`);
      logDiag({
        level: "warn",
        source: "image-prompt",
        message: "imageUnload failed",
        detail: err,
      });
    } finally {
      setUnloadBusy(false);
    }
  }

  // Drive the rotating loading hint while a generate is in flight and we're
  // still in the cold-load phase. The hook short-circuits when inactive so
  // the interval handle is cleared promptly on phase transitions.
  useRotateHints(running && progress.phase === "loading", setHintIdx);

  const statusLine = (() => {
    if (!running) return null;
    if (progress.phase === "loading") {
      // TODO(image-gen-back-ready): once Rust emits
      // `Loading{stage:"downloading", bytes, total}`, format the bytes here
      // as "Downloading: X.X / Y.Y GB" instead of the rotating hint copy.
      if (progress.stage === "downloading") {
        return "Downloading weights…";
      }
      return LOADING_HINTS[hintIdx % LOADING_HINTS.length];
    }
    if (progress.phase === "sampling") {
      if (typeof progress.step === "number" && typeof progress.total === "number") {
        return `Generating step ${progress.step}/${progress.total}…`;
      }
      return "Generating…";
    }
    return "Working…";
  })();

  // Whether to show the imageUnload button. Feature-detect at render so the
  // button only appears once BACK ships the wrapper.
  const unloadAvailable = typeof (api as Record<string, unknown>).imageUnload === "function";

  return (
    <div className="image-prompt-panel">
      <label className="image-prompt-label" htmlFor="image-prompt-textarea">
        Prompt
      </label>
      <textarea
        id="image-prompt-textarea"
        className="image-prompt-textarea"
        data-testid="image-prompt-textarea"
        placeholder="Describe the image you want to generate…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        disabled={running}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter submits — same convention as ChatInput.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        aria-label="Image prompt"
      />

      <div className="image-prompt-row">
        <label className="image-prompt-field">
          <span>Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
            aria-label="Image model"
            data-testid="image-model-select"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>

        <label className="image-prompt-field">
          <span>Size</span>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value)}
            disabled={running}
            aria-label="Image size"
            data-testid="image-size-select"
          >
            {SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <label className="image-prompt-checkbox" title="Reduces VRAM at the cost of speed — useful on 8 GB Macs.">
          <input
            type="checkbox"
            checked={offload}
            onChange={(e) => setOffload(e.target.checked)}
            disabled={running}
            aria-label="Use CPU offload"
          />
          <span>CPU offload</span>
        </label>
      </div>

      <div className="image-prompt-actions">
        <button
          type="button"
          className="image-generate-btn"
          onClick={submit}
          disabled={!canSubmit}
          aria-label="Generate image"
          data-testid="image-generate-btn"
        >
          Generate
        </button>
        {running && progress.phase === "loading" && (
          <span className="image-loading-note" role="status" aria-live="polite">
            First run can take a few minutes — feel free to keep using other tabs.
          </span>
        )}
        {/* TODO(image-gen-back-ready): when cancellation is actually wired (C3),
            put the Cancel button back. Today it was decorative end-to-end. */}
        {statusLine && (
          <span className="image-status-line" role="status" aria-live="polite">
            <span className="image-spinner" aria-hidden="true" /> {statusLine}
          </span>
        )}
      </div>
      <p className="image-hint" data-testid="image-prompt-hint">
        Schnell uses 4 steps; Dev uses 28. Seed and CFG are model-defined in the current engine.
      </p>
      {unloadAvailable && (
        <div className="image-prompt-unload">
          <button
            type="button"
            className="image-action-btn"
            onClick={() => void unloadModel()}
            disabled={unloadBusy || running}
            data-testid="image-unload-btn"
            aria-label="Unload image model"
          >
            {unloadBusy ? "Unloading…" : "Unload model"}
          </button>
          {unloadStatus && (
            <span className="image-status-line" role="status">{unloadStatus}</span>
          )}
        </div>
      )}
      {error && (
        <div className="image-error-row" role="alert">{error}</div>
      )}
    </div>
  );
}

// ── Local helpers ─────────────────────────────────────────────────────────

/**
 * Rotate the loading-hint index every ~3 s while `active` is true. Pulled
 * into its own hook so the main component stays readable and the timer can
 * be cleaned up deterministically across phase transitions.
 */
function useRotateHints(active: boolean, setIdx: (fn: (n: number) => number) => void) {
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => setIdx((n) => n + 1), 3000);
    return () => clearInterval(handle);
  }, [active, setIdx]);
}
