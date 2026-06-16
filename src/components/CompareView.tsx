import { useEffect, useMemo, useState } from "react";
import { Columns, Send, Square, X } from "lucide-react";
import { api } from "../lib/tauri-api";
import { useSettingsField } from "../contexts/SettingsContext";
import { logDiag } from "../lib/diagnostics";
import {
  useCompare,
  type CompareColumn,
  type CompareTarget,
} from "../hooks/useCompare";
import type { AllModels, Message, ServerStatus } from "../types";

/** Max models the user can line up side-by-side. Three columns is the practical
 *  ceiling on a laptop width and keeps a local compare from queueing too deep. */
const MAX_TARGETS = 3;
const MIN_TARGETS = 2;

interface Props {
  /** Live running status — supplies host/port for the loopback (mlx/ollama)
   *  clients and gates the run when no backend is up. */
  status: ServerStatus | null;
  /** Chat history to prepend as context (system prompt + prior turns). Compare
   *  reads it but NEVER mutates or persists it. */
  history: Message[];
  /** Per-conversation numeric params (temperature / top_p / max_tokens). */
  params: {
    temperature?: number | null;
    top_p?: number | null;
    max_tokens?: number | null;
  };
  /** Leave compare mode (back to normal single-model chat). */
  onClose: () => void;
}

/** A pickable model row in the compare selector. */
interface PickOption {
  /** `<backend>:<id>` (or `__custom__:<id>`) — unique select value. */
  value: string;
  backend: string;
  /** Effective model id passed to the client (CustomBackend id for custom). */
  model: string;
  label: string;
  /** OpenRouter/custom catalogue model, when distinct from `model`. */
  customModel?: string;
}

/**
 * SIDE-BY-SIDE multi-model COMPARE (W5B-COMPARE).
 *
 * Pick 2–3 installed models, type ONE prompt, watch each model stream its answer
 * in its own column. Exploratory: results are never written to the conversation,
 * so the normal chat history stays clean. Streaming reuses the exact per-backend
 * clients the normal send uses and respects the shared inference gate (local
 * serial / cloud parallel) — see {@link useCompare}.
 */
export function CompareView({ status, history, params, onClose }: Props) {
  const [models, setModels] = useState<AllModels>({ mlx: [], ollama: [] });
  const customBackends = useSettingsField((s) => s?.custom_backends ?? []);
  const [picked, setPicked] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const { columns, running, run, abort } = useCompare();

  useEffect(() => {
    api
      .listAllModels()
      .then(setModels)
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "compare",
          message: "listAllModels failed — compare model list empty",
          detail: e,
        }),
      );
  }, []);

  // Flatten every installed/configured model into one pick list. Ollama + MLX
  // are local; custom backends are cloud/self-hosted. OpenRouter models aren't
  // enumerated here (they need a catalogue fetch) — the running OpenRouter model,
  // if any, is offered as a single row so the active cloud model can be compared.
  const options = useMemo<PickOption[]>(() => {
    const out: PickOption[] = [];
    for (const m of models.ollama)
      out.push({
        value: `ollama:${m.id}`,
        backend: "ollama",
        model: m.id,
        label: m.id,
      });
    for (const m of models.mlx)
      out.push({
        value: `mlx:${m.id}`,
        backend: "mlx",
        model: m.id,
        label: m.id,
      });
    for (const b of customBackends)
      out.push({
        value: `__custom__:${b.id}`,
        backend: "custom",
        model: b.id,
        label: `☁ ${b.name}`,
      });
    // The active OpenRouter model has no local row; offer it explicitly.
    if (status?.backend === "openrouter" && status.model)
      out.push({
        value: `openrouter:${status.model}`,
        backend: "openrouter",
        model: status.model,
        customModel: status.model,
        label: `☁ ${status.model}`,
      });
    return out;
  }, [models, customBackends, status?.backend, status?.model]);

  const optionByValue = useMemo(() => {
    const map = new Map<string, PickOption>();
    for (const o of options) map.set(o.value, o);
    return map;
  }, [options]);

  const togglePick = (value: string) => {
    setPicked((prev) => {
      if (prev.includes(value)) return prev.filter((v) => v !== value);
      if (prev.length >= MAX_TARGETS) return prev; // ceiling reached
      return [...prev, value];
    });
  };

  const targets = useMemo<CompareTarget[]>(
    () =>
      picked
        .map((v) => optionByValue.get(v))
        .filter((o): o is PickOption => o != null)
        .map((o, i) => ({
          key: `${o.value}#${i}`,
          backend: o.backend,
          model: o.model,
          label: o.label,
          customModel: o.customModel,
        })),
    [picked, optionByValue],
  );

  const canRun =
    !running &&
    !!status?.running &&
    targets.length >= MIN_TARGETS &&
    prompt.trim().length > 0;

  const onRun = () => {
    if (!canRun || !status) return;
    void run(prompt, targets, history, params, status);
  };

  return (
    <div className="compare-view" data-testid="compare-view">
      <div className="compare-head">
        <span className="compare-title">
          <Columns size={15} /> Compare models
        </span>
        <span className="compare-sub">
          Run one prompt across {MIN_TARGETS}–{MAX_TARGETS} models side by side.
          Nothing here is saved to your chat.
        </span>
        <button
          type="button"
          className="compare-close"
          onClick={onClose}
          title="Exit compare mode"
          aria-label="Exit compare mode"
        >
          <X size={15} />
        </button>
      </div>

      {!status?.running && (
        <div className="compare-hint" role="status">
          Start a model first — compare streams against the running backend.
        </div>
      )}

      <div className="compare-pickbar" data-testid="compare-pickbar">
        {options.length === 0 ? (
          <span className="compare-sub">No installed models found.</span>
        ) : (
          options.map((o) => {
            const on = picked.includes(o.value);
            const full = !on && picked.length >= MAX_TARGETS;
            return (
              <button
                key={o.value}
                type="button"
                className={`compare-chip${on ? " on" : ""}`}
                aria-pressed={on}
                disabled={full || running}
                title={
                  full
                    ? `Pick up to ${MAX_TARGETS} models`
                    : `${o.backend} · ${o.model}`
                }
                onClick={() => togglePick(o.value)}
              >
                {o.label}
              </button>
            );
          })
        )}
      </div>

      <div className="compare-composer">
        <textarea
          className="compare-input"
          data-testid="compare-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onRun();
            }
          }}
          placeholder={`Prompt to run across ${
            targets.length >= MIN_TARGETS ? targets.length : "all picked"
          } models (Cmd+Enter to run)…`}
          rows={2}
        />
        {running ? (
          <button
            type="button"
            className="compare-run compare-stop"
            onClick={abort}
            data-testid="compare-stop"
          >
            <Square size={14} /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="compare-run"
            onClick={onRun}
            disabled={!canRun}
            data-testid="compare-run"
            title={
              targets.length < MIN_TARGETS
                ? `Pick at least ${MIN_TARGETS} models`
                : "Run the prompt across the picked models"
            }
          >
            <Send size={14} /> Run
          </button>
        )}
      </div>

      {columns.length > 0 && (
        <div
          className="compare-grid"
          data-testid="compare-grid"
          style={{
            gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
          }}
        >
          {columns.map((c) => (
            <CompareColumnCard key={c.key} col={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One model's column: header (label + state), streamed text, tok/s footer. */
function CompareColumnCard({ col }: { col: CompareColumn }) {
  return (
    <div className="compare-col" data-testid="compare-col">
      <div className="compare-col-head">
        <span className="compare-col-name" title={`${col.backend} · ${col.model}`}>
          {col.label}
        </span>
        <span className={`compare-col-state state-${col.state}`}>
          {col.state === "streaming"
            ? "…"
            : col.state === "done"
              ? "done"
              : col.state === "aborted"
                ? "stopped"
                : "error"}
        </span>
      </div>
      <div className="compare-col-body">
        {col.state === "error" ? (
          <div className="compare-col-error">{col.error}</div>
        ) : (
          <div className="compare-col-text">
            {col.text}
            {col.state === "streaming" && (
              <span className="compare-caret" aria-hidden="true" />
            )}
          </div>
        )}
      </div>
      {col.stat && (
        <div className="compare-col-foot" data-testid="compare-col-stat">
          {col.stat.tokPerSec != null && (
            <span>{col.stat.tokPerSec} tok/s</span>
          )}
          <span>
            TTFT{" "}
            {col.stat.ttftMs >= 1000
              ? `${(col.stat.ttftMs / 1000).toFixed(1)}s`
              : `${col.stat.ttftMs}ms`}
          </span>
          {col.stat.completionTokens != null && (
            <span>{col.stat.completionTokens} tok</span>
          )}
          {col.stat.coldLoad && (
            <span
              className="compare-col-cold"
              title="The model was loaded from disk for this reply — TTFT reflects the reload."
            >
              cold load
            </span>
          )}
        </div>
      )}
    </div>
  );
}
