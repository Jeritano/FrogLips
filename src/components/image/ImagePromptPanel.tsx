import { useState } from "react";
import type { ImageGenOpts } from "../../types";
import type { ImageGenProgress } from "../../hooks/useImageGeneration";

interface Props {
  /** Submitted when the user clicks Generate. Parent owns the actual IPC call. */
  onGenerate: (args: { prompt: string; model: string; opts: ImageGenOpts }) => void;
  /** Best-effort cancel of an in-flight generate. */
  onCancel: () => void;
  /** Whether a generate is currently running — drives disable + spinner state. */
  running: boolean;
  /** Live progress from the Rust event stream. */
  progress: ImageGenProgress;
  /** Last error message; null hides the inline error row. */
  error: string | null;
}

const SIZE_OPTIONS: ReadonlyArray<string> = [
  "512x512",
  "768x768",
  "1024x1024",
  "1024x1536",
  "1536x1024",
];

/**
 * Composer + parameters for the Image view. Prompt is the only required input;
 * steps / cfg / seed live behind a collapsible "Advanced" disclosure because
 * mistralrs 0.8.1 doesn't actually honor them — they persist on the row for
 * reproducibility but the sampler uses its baked-in defaults (schnell=4,
 * dev=28). The disclosure label makes that limitation explicit so users
 * aren't misled about why a 50-step request renders in 4.
 */
export function ImagePromptPanel({
  onGenerate,
  onCancel,
  running,
  progress,
  error,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<"schnell" | "dev">("schnell");
  const [size, setSize] = useState<string>("1024x1024");
  const [offload, setOffload] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // String inputs so empty values can be passed as `null` to the Rust side
  // (rather than 0 / NaN, which the backend would reject).
  const [steps, setSteps] = useState<string>("");
  const [cfg, setCfg] = useState<string>("");
  const [seed, setSeed] = useState<string>("");

  const trimmedPrompt = prompt.trim();
  const canSubmit = !running && trimmedPrompt.length > 0;

  function submit() {
    if (!canSubmit) return;
    const opts: ImageGenOpts = {
      size,
      offload,
      steps: steps.trim() === "" ? null : Number(steps),
      cfg: cfg.trim() === "" ? null : Number(cfg),
      seed: seed.trim() === "" ? null : Number(seed),
    };
    // Strip NaN coercions — a bad numeric input becomes `null` so Rust
    // validation gets a clean payload.
    if (opts.steps != null && !Number.isFinite(opts.steps)) opts.steps = null;
    if (opts.cfg != null && !Number.isFinite(opts.cfg)) opts.cfg = null;
    if (opts.seed != null && !Number.isFinite(opts.seed)) opts.seed = null;
    onGenerate({ prompt: trimmedPrompt, model, opts });
  }

  const statusLine = (() => {
    if (!running) return null;
    if (progress.phase === "loading") {
      return progress.stage
        ? `Loading model — ${progress.stage}…`
        : "Loading model (first time can take minutes if weights aren't cached)…";
    }
    if (progress.phase === "sampling") {
      if (typeof progress.step === "number" && typeof progress.total === "number") {
        return `Generating step ${progress.step}/${progress.total}…`;
      }
      return "Generating…";
    }
    return "Working…";
  })();

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
        rows={3}
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
            onChange={(e) => setModel(e.target.value as "schnell" | "dev")}
            disabled={running}
            aria-label="Image model"
            data-testid="image-model-select"
          >
            <option value="schnell">FLUX.1 schnell (fast, 4 steps)</option>
            <option value="dev">FLUX.1 dev (higher quality, 28 steps)</option>
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
          <span>Use CPU offload</span>
        </label>
      </div>

      <button
        type="button"
        className="image-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((v) => !v)}
      >
        {advancedOpen ? "▾" : "▸"} Advanced — currently informational
      </button>
      {advancedOpen && (
        <div className="image-advanced-grid">
          <p className="image-advanced-note">
            mistralrs 0.8.1 ignores these and uses model defaults (schnell=4 steps, dev=28).
            They persist on the row for reproducibility.
          </p>
          <label className="image-prompt-field">
            <span>Steps</span>
            <input
              type="number"
              min={1}
              max={100}
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              placeholder="default"
              disabled={running}
              aria-label="Sampling steps"
            />
          </label>
          <label className="image-prompt-field">
            <span>CFG</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={cfg}
              onChange={(e) => setCfg(e.target.value)}
              placeholder="default"
              disabled={running}
              aria-label="Classifier-free guidance"
            />
          </label>
          <label className="image-prompt-field">
            <span>Seed</span>
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="random"
              disabled={running}
              aria-label="Seed"
            />
          </label>
        </div>
      )}

      <div className="image-prompt-actions">
        {running ? (
          <button
            type="button"
            className="image-cancel-btn"
            onClick={onCancel}
            aria-label="Cancel image generation"
            title="Cancel is best-effort — mid-diffusion cancel isn't supported by the current backend"
            data-testid="image-cancel-btn"
          >
            Cancel
          </button>
        ) : (
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
        )}
        {statusLine && (
          <span className="image-status-line" role="status" aria-live="polite">
            <span className="image-spinner" aria-hidden="true" /> {statusLine}
          </span>
        )}
      </div>
      {error && (
        <div className="image-error-row" role="alert">{error}</div>
      )}
    </div>
  );
}
