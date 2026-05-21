/**
 * Single repo card for the HF library grid.
 *
 * Per HF.co's layout: repo id, pipeline chip, param size pill, "Updated …",
 * downloads/likes counts, lightning bolt for warm-inference repos, and one
 * action button keyed off the most-relevant format tag.
 */
import { PIPELINE_COLOR } from "./constants";
import type { HfModel } from "./loader";
import { extractParams } from "./loader";

interface Props {
  model: HfModel;
  installed: boolean;
  pulling: boolean;
  done: boolean;
  err?: string;
  onPull: (id: string) => void;
  onOpenHf: (id: string) => void;
  onViewGguf: (id: string) => void;
  onRemove: (id: string) => void;
  confirmDelete: string | null;
}

function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Abbreviate parameter count to a HF-style pill ("7B", "1.5B", "405B"). */
function paramPill(n: number | null): string | null {
  if (n === null) return null;
  if (n >= 1_000_000_000) {
    const v = n / 1_000_000_000;
    return v >= 100 ? `${Math.round(v)}B` : `${v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, "")}B`;
  }
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return null;
}

function relTime(iso?: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const day = Math.floor((Date.now() - then) / 86_400_000);
  if (day < 1) return "today";
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.floor(day / 365);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

export function ModelCard(props: Props) {
  const { model: m } = props;
  const tags = (m.tags ?? []).map((t) => t.toLowerCase());
  const isMlx = tags.includes("mlx") || m.id.startsWith("mlx-community/");
  const isGguf = tags.includes("gguf");
  const hasInference = tags.some((t) => t === "inference" || t.startsWith("inference_provider:") || t === "warm");
  const params = paramPill(extractParams(m));
  const updated = relTime(m.lastModified);
  const pipeline = m.pipeline_tag ?? null;
  const pColor = pipeline ? PIPELINE_COLOR[pipeline] ?? "#6b7280" : null;
  const initial = m.id.charAt(0).toUpperCase();

  let action: { label: string; cls?: string; on: () => void; disabled?: boolean };
  if (props.installed) {
    action = {
      label: props.confirmDelete === m.id ? "Click again to confirm" : "Remove",
      cls: "hfl-btn-delete",
      on: () => props.onRemove(m.id),
    };
  } else if (isMlx) {
    action = {
      label: props.pulling ? "…" : props.done ? "✓ Done" : "Pull",
      on: () => props.onPull(m.id),
      disabled: props.pulling || props.done,
    };
  } else if (isGguf) {
    action = { label: "View files", on: () => props.onViewGguf(m.id) };
  } else {
    action = { label: "Open on HF ↗", on: () => props.onOpenHf(m.id) };
  }

  return (
    <div className="hfl-card" data-testid="hf-model-card">
      <div className="hfl-card-head">
        <div className="hfl-avatar" aria-hidden>{initial}</div>
        <div className="hfl-card-id" title={m.id}>{m.id}</div>
        {hasInference && (
          <span className="hfl-bolt" title="Inference Available">⚡</span>
        )}
      </div>
      <div className="hfl-card-chips">
        {pipeline && (
          <span
            className="hfl-pipeline"
            style={{ background: `${pColor}22`, color: pColor ?? undefined }}
          >
            {pipeline.replace(/-/g, " ")}
          </span>
        )}
        {params && <span className="hfl-param-pill">{params}</span>}
        {m.library_name && (
          <span className="hfl-lib-pill">{m.library_name}</span>
        )}
      </div>
      <div className="hfl-card-foot">
        <span className="hfl-updated">{updated ? `Updated ${updated}` : "—"}</span>
        <span className="hfl-stats">
          <span title="Downloads">↓ {abbrev(m.downloads)}</span>
          <span title="Likes" style={{ marginLeft: 8 }}>♥ {abbrev(m.likes)}</span>
        </span>
      </div>
      {props.err && <div className="hfl-card-err">{props.err}</div>}
      <div className="hfl-card-actions">
        <button
          type="button"
          className={`hfl-btn ${action.cls ?? ""}`}
          onClick={action.on}
          disabled={action.disabled}
          data-testid={`hfl-action-${m.id}`}
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}
