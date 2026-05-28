import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/tauri-api";
import { announce } from "../../lib/announce";
import { logDiag } from "../../lib/diagnostics";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import type { LoraMergeRow, LoraMetadata } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";

interface Props {
  /**
   * Friendly base-model id from the composer ("schnell" / "dev" / etc.).
   * Threaded through to `api.loraMerge` as `baseRepo`; the Rust side
   * canonicalises it the same way image_generate does.
   */
  baseRepo: string;
  /** Currently-applied merge row, if any — drives the header status + Clear. */
  appliedLora: LoraMergeRow | null;
  /** Called when a merge completes (or a cached row's Apply is clicked). */
  onApplied: (row: LoraMergeRow) => void;
  /** Called when the Clear LoRA button is pressed. */
  onCleared: () => void;
  /** Called when a trigger-word chip is clicked — append text to the prompt. */
  onInsertTrigger: (text: string) => void;
}

type MergeStage =
  | "reading_lora"
  | "reading_base"
  | "applying_deltas"
  | "writing"
  | "indexing";

interface ProgressEvent {
  op_id: string;
  stage: MergeStage;
  progress: number;
}

interface DoneEvent {
  op_id: string;
  row: LoraMergeRow;
}

interface ErrorEvent {
  op_id: string;
  message: string;
}

interface EvictedEvent {
  sha: string;
}

const STAGE_LABEL: Record<MergeStage, string> = {
  reading_lora: "Reading LoRA…",
  reading_base: "Reading base model…",
  applying_deltas: "Applying deltas…",
  writing: "Writing merged variant…",
  indexing: "Indexing merge…",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function basename(p: string): string {
  // Path may use either separator depending on platform; strip both.
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * LoRA composer subpanel. Sits inside the ImageView composer above the
 * prompt controls. Lets the user:
 *   1. Pick a `.safetensors` LoRA file via the native dialog.
 *   2. Inspect convention / trigger words / size up-front (lora_inspect).
 *   3. Choose a weight (0..1.5, default 1.0) + click Merge.
 *   4. Track the Rust merger via `lora-merge-progress` events.
 *   5. Apply / delete cached merges from earlier sessions.
 *
 * Feature-detected: when `"loraInspect" in api` is false the Rust side
 * has not yet shipped the handlers — we render an "Unavailable" hint
 * and never invoke any lora_* IPC.
 */
export function LoraPanel({
  baseRepo,
  appliedLora,
  onApplied,
  onCleared,
  onInsertTrigger,
}: Props) {
  const supported = "loraInspect" in api;

  // Body collapse — open by default the first time so users discover it.
  const [open, setOpen] = useState(true);

  // Picked-file state. `loraPath` is the absolute path string; `meta` is
  // the inspect result. Cleared whenever the user picks a new file.
  const [loraPath, setLoraPath] = useState<string | null>(null);
  const [meta, setMeta] = useState<LoraMetadata | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectErr, setInspectErr] = useState<string | null>(null);

  // Merge slider state.
  const [weight, setWeight] = useState<number>(1.0);

  // In-flight merge state.
  const [opId, setOpId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [stage, setStage] = useState<MergeStage | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [mergeErr, setMergeErr] = useState<string | null>(null);

  // Cached merges section state.
  const [cachedOpen, setCachedOpen] = useState(false);
  const [cached, setCached] = useState<LoraMergeRow[]>([]);
  const [cachedErr, setCachedErr] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LoraMergeRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Event listeners ──────────────────────────────────────────────────
  // Listeners are registered unconditionally for the lifetime of the panel
  // (cheap — Tauri multiplexes), filtered by op_id inside the handler so
  // a stale event from a previous run can't clobber current state.
  useTauriEvent<ProgressEvent>(
    "lora-merge-progress",
    (e) => {
      const p = e.payload;
      if (!p || p.op_id !== opId) return;
      setStage(p.stage);
      setProgress(typeof p.progress === "number" ? p.progress : 0);
    },
    [opId],
  );

  useTauriEvent<DoneEvent>(
    "lora-merge-done",
    (e) => {
      const p = e.payload;
      if (!p || p.op_id !== opId) return;
      setMerging(false);
      setStage(null);
      setProgress(0);
      setOpId(null);
      setMergeErr(null);
      onApplied(p.row);
      announce(`LoRA merged · ${p.row.sha.slice(0, 8)}`);
      // Refresh the cached list so the new row shows up if the section
      // is expanded.
      if (supported) {
        api
          .loraListMerges()
          .then(setCached)
          .catch((err) =>
            logDiag({
              level: "info",
              source: "lora-panel",
              message: "loraListMerges (post-merge refresh) failed",
              detail: err,
            }),
          );
      }
    },
    [opId, onApplied, supported],
  );

  useTauriEvent<ErrorEvent>(
    "lora-merge-error",
    (e) => {
      const p = e.payload;
      if (!p || p.op_id !== opId) return;
      setMerging(false);
      setStage(null);
      setProgress(0);
      setOpId(null);
      setMergeErr(typeof p.message === "string" ? p.message : "Merge failed");
    },
    [opId],
  );

  useTauriEvent<EvictedEvent>(
    "lora-merge-evicted",
    (e) => {
      const p = e.payload;
      if (!p || typeof p.sha !== "string") return;
      // Drop the evicted row from the cached list (best-effort; the next
      // refresh will reconcile anyway).
      setCached((rows) => rows.filter((r) => r.sha !== p.sha));
    },
    [],
  );

  // ── Cached-merges refresh ────────────────────────────────────────────
  const refreshCached = useCallback(async () => {
    if (!supported) return;
    setCachedErr(null);
    try {
      const rows = await api.loraListMerges();
      setCached(rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCachedErr(msg);
      logDiag({
        level: "warn",
        source: "lora-panel",
        message: "loraListMerges failed",
        detail: err,
      });
    }
  }, [supported]);

  useEffect(() => {
    if (cachedOpen) void refreshCached();
  }, [cachedOpen, refreshCached]);

  // ── Handlers ─────────────────────────────────────────────────────────
  const pickFile = useCallback(async () => {
    if (!supported) return;
    try {
      const picked = await openDialog({
        filters: [{ name: "safetensors", extensions: ["safetensors"] }],
        multiple: false,
      });
      if (typeof picked !== "string" || picked.length === 0) return;
      setLoraPath(picked);
      setMeta(null);
      setInspecting(true);
      setInspectErr(null);
      try {
        const m = await api.loraInspect(picked);
        setMeta(m);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setInspectErr(msg);
        logDiag({
          level: "warn",
          source: "lora-panel",
          message: "loraInspect failed",
          detail: err,
        });
      } finally {
        setInspecting(false);
      }
    } catch (err) {
      logDiag({
        level: "warn",
        source: "lora-panel",
        message: "open dialog failed",
        detail: err,
      });
    }
  }, [supported]);

  const startMerge = useCallback(async () => {
    if (!supported) return;
    if (!loraPath || !meta) return;
    if (meta.convention === "unknown") return;
    setMergeErr(null);
    setMerging(true);
    setStage("reading_lora");
    setProgress(0);
    const nextOpId = `lora-${crypto.randomUUID()}`;
    setOpId(nextOpId);
    try {
      // The IPC resolves only when the merge completes — but we also gate
      // state transitions on the `lora-merge-done` event so the row update
      // funnels through one path regardless of which fires first.
      const row = await api.loraMerge(baseRepo, loraPath, weight, nextOpId);
      // Defensive: if the done-event already ran the success path, this is
      // a no-op (opId was cleared). Otherwise mirror the event-driven
      // success path so callers see the row even when events arrived
      // before the IPC resolved.
      setMerging((wasMerging) => {
        if (!wasMerging) return wasMerging;
        setStage(null);
        setProgress(0);
        setOpId(null);
        setMergeErr(null);
        onApplied(row);
        announce(`LoRA merged · ${row.sha.slice(0, 8)}`);
        if (supported) {
          api
            .loraListMerges()
            .then(setCached)
            .catch(() => {});
        }
        return false;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMerging(false);
      setStage(null);
      setProgress(0);
      setOpId(null);
      setMergeErr(msg);
      logDiag({
        level: "warn",
        source: "lora-panel",
        message: "loraMerge failed",
        detail: err,
      });
    }
  }, [baseRepo, loraPath, meta, weight, onApplied, supported]);

  const applyCached = useCallback(
    (row: LoraMergeRow) => {
      onApplied(row);
      // Best-effort touch — Rust uses this for LRU eviction order. Don't
      // block the UI on it.
      if (supported) {
        api.loraRecordUsed(row.sha).catch((err) =>
          logDiag({
            level: "info",
            source: "lora-panel",
            message: "loraRecordUsed failed",
            detail: err,
          }),
        );
      }
      announce(`LoRA applied · ${row.sha.slice(0, 8)}`);
    },
    [onApplied, supported],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !supported) return;
    setDeleting(true);
    try {
      await api.loraDeleteMerge(pendingDelete.sha);
      setPendingDelete(null);
      await refreshCached();
      announce("Cached merge deleted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCachedErr(msg);
      logDiag({
        level: "warn",
        source: "lora-panel",
        message: "loraDeleteMerge failed",
        detail: err,
      });
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refreshCached, supported]);

  // ── Render ───────────────────────────────────────────────────────────

  // Feature-detection hint — Rust handlers not yet wired. Renders the
  // header line + an inline note so the panel is discoverable but
  // inactive.
  if (!supported) {
    return (
      <section
        className="lora-panel lora-panel-unsupported"
        aria-label="LoRA"
        data-testid="lora-panel"
      >
        <div className="lora-header">
          <span className="lora-header-title">LoRA</span>
          <span
            className="lora-header-meta lora-unavailable"
            data-testid="lora-panel-unsupported"
          >
            Unavailable in this build
          </span>
        </div>
      </section>
    );
  }

  const filename = loraPath ? basename(loraPath) : null;
  const canMerge =
    !!loraPath && !!meta && meta.convention !== "unknown" && !merging;

  return (
    <section className="lora-panel" aria-label="LoRA" data-testid="lora-panel">
      <button
        type="button"
        className="lora-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="lora-panel-body"
        data-testid="lora-panel-toggle"
      >
        <span className="lora-header-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="lora-header-title">LoRA</span>
        {appliedLora && (
          <span className="lora-header-meta" data-testid="lora-applied-meta">
            Applied: {basename(appliedLora.lora_path)} · α=
            {appliedLora.weight.toFixed(2)}
          </span>
        )}
      </button>

      {appliedLora && (
        <button
          type="button"
          className="lora-clear-btn"
          onClick={onCleared}
          data-testid="lora-clear-btn"
        >
          Clear LoRA
        </button>
      )}

      {open && (
        <div id="lora-panel-body" className="lora-body">
          {/* File pick row */}
          <div className="lora-pick-row">
            <button
              type="button"
              className="image-action-btn lora-pick-btn"
              onClick={() => void pickFile()}
              data-testid="lora-pick-btn"
            >
              Pick LoRA file…
            </button>
            {!loraPath && !appliedLora && (
              <span
                className="lora-empty-hint"
                data-testid="lora-empty-hint"
              >
                No LoRA applied
              </span>
            )}
            {inspecting && (
              <span className="image-status-line" role="status">
                <span className="image-spinner" aria-hidden="true" /> Inspecting…
              </span>
            )}
          </div>

          {inspectErr && (
            <div className="image-error-row" role="alert">
              Inspect failed: {inspectErr}
            </div>
          )}

          {/* Inspect output */}
          {filename && meta && (
            <div className="lora-inspect" data-testid="lora-inspect">
              <div className="lora-inspect-line">
                <span className="lora-inspect-label">File:</span>{" "}
                <span
                  className="lora-inspect-value"
                  data-testid="lora-filename"
                >
                  {filename}
                </span>
              </div>
              <div className="lora-inspect-line">
                <span className="lora-inspect-label">Size:</span>{" "}
                <span
                  className="lora-inspect-value"
                  data-testid="lora-bytes"
                >
                  {formatBytes(meta.bytes)}
                </span>{" "}
                <span className="lora-inspect-label">Keys:</span>{" "}
                <span
                  className="lora-inspect-value"
                  data-testid="lora-key-count"
                >
                  {meta.key_count}
                </span>
              </div>
              <div className="lora-inspect-line">
                <span className="lora-inspect-label">Convention:</span>{" "}
                <span
                  className={`lora-convention-badge lora-convention-${meta.convention}`}
                  title={
                    meta.convention === "unknown"
                      ? "Format not recognised — merge may fail"
                      : undefined
                  }
                  data-testid="lora-convention-badge"
                >
                  {meta.convention}
                </span>
              </div>
              {meta.base_model_hint && (
                <div className="lora-inspect-line">
                  <span className="lora-inspect-label">Base hint:</span>{" "}
                  <span
                    className="lora-inspect-value"
                    data-testid="lora-base-hint"
                  >
                    {meta.base_model_hint}
                  </span>
                </div>
              )}
              {meta.triggers.length > 0 && (
                <div
                  className="lora-trigger-row"
                  data-testid="lora-trigger-row"
                >
                  <span className="lora-inspect-label">Triggers:</span>
                  {meta.triggers.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="lora-trigger-chip"
                      onClick={() => onInsertTrigger(t)}
                      data-testid={`lora-trigger-chip-${t}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Weight slider — visible whenever there's a picked file. */}
          {loraPath && (
            <div className="lora-weight-row">
              <label
                className="lora-inspect-label"
                htmlFor="lora-weight-slider"
              >
                Weight (α)
              </label>
              <input
                id="lora-weight-slider"
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={weight}
                onChange={(e) =>
                  setWeight(parseFloat(e.target.value) || 0)
                }
                disabled={merging}
                aria-label="LoRA weight"
                data-testid="lora-weight-slider"
              />
              <input
                type="number"
                min={0}
                max={1.5}
                step={0.05}
                value={weight}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v)) {
                    // Clamp so an out-of-range entry can't escape the slider's
                    // [0, 1.5] domain and confuse the Rust merger.
                    setWeight(Math.max(0, Math.min(1.5, v)));
                  }
                }}
                disabled={merging}
                aria-label="LoRA weight value"
                data-testid="lora-weight-input"
                className="lora-weight-input"
              />
            </div>
          )}

          {/* Merge action */}
          {loraPath && (
            <div className="lora-merge-row">
              <button
                type="button"
                className="image-generate-btn"
                onClick={() => void startMerge()}
                disabled={!canMerge}
                data-testid="lora-merge-btn"
              >
                {merging ? "Merging…" : "Merge & apply"}
              </button>
              {meta?.convention === "unknown" && (
                <span className="lora-merge-disabled-hint">
                  Unknown convention — pick a diffusers or kohya file.
                </span>
              )}
              {merging && stage && (
                <div
                  className="lora-progress"
                  data-testid="lora-progress"
                >
                  <div
                    className="lora-progress-bar"
                    data-testid="lora-progress-bar"
                  >
                    <div
                      className="lora-progress-bar-fill"
                      data-testid="lora-progress-bar-fill"
                      style={{
                        width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
                      }}
                    />
                  </div>
                  <span
                    className="lora-progress-label"
                    data-testid="lora-progress-label"
                  >
                    {STAGE_LABEL[stage]}
                  </span>
                </div>
              )}
            </div>
          )}

          {mergeErr && (
            <div
              className="image-error-row"
              role="alert"
              data-testid="lora-merge-error"
            >
              Merge failed: {mergeErr}
            </div>
          )}

          {/* Cached merges */}
          <div className="lora-cached-section">
            <button
              type="button"
              className="lora-cached-toggle"
              onClick={() => setCachedOpen((v) => !v)}
              aria-expanded={cachedOpen}
              aria-controls="lora-cached-body"
              data-testid="lora-cached-toggle"
            >
              <span aria-hidden="true">{cachedOpen ? "▾" : "▸"}</span> Cached
              merges
            </button>
            {cachedOpen && (
              <div
                id="lora-cached-body"
                className="lora-cached-body"
                data-testid="lora-cached-body"
              >
                {cachedErr && (
                  <div className="image-error-row" role="alert">
                    {cachedErr}
                  </div>
                )}
                {cached.length === 0 ? (
                  <div className="lora-cached-empty">
                    No cached merges yet.
                  </div>
                ) : (
                  <ul className="lora-cached-list">
                    {cached.map((row) => (
                      <li
                        key={row.sha}
                        className="lora-cached-row"
                        data-testid={`lora-cached-row-${row.sha}`}
                      >
                        <span className="lora-cached-name">
                          {basename(row.lora_path)}
                        </span>
                        <span className="lora-cached-meta">
                          {row.base_repo} · α={row.weight.toFixed(2)} ·{" "}
                          {row.sha.slice(0, 8)} · {formatBytes(row.bytes)}
                        </span>
                        <div className="lora-cached-actions">
                          <button
                            type="button"
                            className="image-action-btn"
                            onClick={() => applyCached(row)}
                            data-testid={`lora-cached-apply-${row.sha}`}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="image-action-btn lora-cached-delete-btn"
                            onClick={() => setPendingDelete(row)}
                            data-testid={`lora-cached-delete-${row.sha}`}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          ariaLabel="Confirm delete cached merge"
          title={<span>Delete cached merge?</span>}
          boxClassName="risk-destructive"
          data-testid="lora-delete-confirm"
          onDismiss={() => (deleting ? undefined : setPendingDelete(null))}
          actions={
            <>
              <button
                type="button"
                className="image-action-btn"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                data-testid="lora-delete-confirm-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="image-action-btn image-delete-btn"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                data-testid="lora-delete-confirm-allow"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p className="lora-delete-body">
            Will remove the merged variant at{" "}
            <code>{pendingDelete.merged_path}</code>. The original LoRA file
            is untouched. Re-merging is possible but takes the full merge
            time again.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
