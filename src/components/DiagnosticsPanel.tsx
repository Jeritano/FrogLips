import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearDiag,
  listDiag,
  subscribeDiag,
  type DiagEntry,
  type DiagLevel,
} from "../lib/diagnostics";
import { useModalA11y } from "../lib/use-modal-a11y";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";

/* ── Diagnostics modal ────────────────────────────────────────────────────
 *
 * Surfaces the in-memory ring buffer kept by `src/lib/diagnostics.ts`.
 *
 * Read-only by design — per the spec, this panel cannot take action on the
 * errored systems. Filters + sort + copy-for-bug-report + clear (two-click
 * confirm) are the only controls.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

const LEVEL_FILTERS: readonly ("all" | DiagLevel)[] = ["all", "info", "warn", "error"] as const;

const LEVEL_COLORS: Record<DiagLevel, string> = {
  info: "var(--text-muted, #888)",
  warn: "var(--warning, #d9a86c)",
  error: "var(--accent, #c66)",
};

const COPY_TAIL = 50;

function fmtTs(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function detailToString(d: unknown): string {
  if (d === undefined) return "";
  if (typeof d === "string") return d;
  try {
    return JSON.stringify(d, null, 2);
  } catch {
    try { return String(d); } catch { return "[unserialisable]"; }
  }
}

export function DiagnosticsPanel({ open, onClose }: Props) {
  const [entries, setEntries] = useState<DiagEntry[]>(() => listDiag());
  const [level, setLevel] = useState<"all" | DiagLevel>("all");
  const [source, setSource] = useState<string>("");
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  // Two-click confirm for the destructive Clear action (window.confirm is
  // disabled in Tauri 2's webview).
  const clearConfirm = useTwoClickConfirm();
  const clearArmed = clearConfirm.armed === "clear";

  // Subscribe to live updates while the panel is open. We always render off
  // the latest snapshot so a warning that fires while the modal is showing
  // appears without a manual refresh.
  useEffect(() => {
    if (!open) return;
    const off = subscribeDiag((snap) => setEntries(snap));
    return () => {
      off();
    };
  }, [open]);

  // Disarm the two-click-confirm when the panel closes so it doesn't carry
  // over to the next open.
  useEffect(() => {
    if (!open) clearConfirm.reset();
  }, [open, clearConfirm]);

  const sourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.source);
    return Array.from(set).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const src = source.trim();
    const rows = entries.filter((e) => {
      if (level !== "all" && e.level !== level) return false;
      if (src && e.source !== src) return false;
      return true;
    });
    rows.sort((a, b) => (sortNewestFirst ? b.ts - a.ts : a.ts - b.ts));
    return rows;
  }, [entries, level, source, sortNewestFirst]);

  const handleCopy = useCallback(async () => {
    // Always copy the LAST COPY_TAIL entries by timestamp regardless of
    // current sort direction — bug reports want newest first.
    const tail = [...entries].sort((a, b) => b.ts - a.ts).slice(0, COPY_TAIL);
    const json = JSON.stringify(tail, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopyStatus(`Copied ${tail.length} entr${tail.length === 1 ? "y" : "ies"}`);
    } catch {
      // Fallback: select-and-copy via a hidden textarea so the user still
      // gets something usable when the clipboard API is blocked.
      try {
        const ta = document.createElement("textarea");
        ta.value = json;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        setCopyStatus(`Copied ${tail.length} entr${tail.length === 1 ? "y" : "ies"} (fallback)`);
      } catch {
        setCopyStatus("Copy failed — see console");
        // eslint-disable-next-line no-console
        console.warn("[diagnostics] copy fallback failed:", json);
      }
    }
    setTimeout(() => setCopyStatus(null), 2500);
  }, [entries]);

  const handleClear = useCallback(() => {
    // Two-click confirm — first click arms (button label changes), second
    // click within the window actually clears.
    clearConfirm.request("clear", () => clearDiag());
  }, [clearConfirm]);

  if (!open) return null;

  return (
    <DiagnosticsOverlay open={open} onClose={onClose}>
      <div className="dashboard-modal diag-modal">
        <header className="dashboard-header">
          <h2>Diagnostics</h2>
          <div className="dashboard-controls diag-controls">
            <label className="diag-field">
              Level:&nbsp;
              <select
                data-testid="diag-level"
                value={level}
                onChange={(e) => setLevel(e.target.value as "all" | DiagLevel)}
              >
                {LEVEL_FILTERS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="diag-field">
              Source:&nbsp;
              <select
                data-testid="diag-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">any</option>
                {sourceOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="diag-sort"
              onClick={() => setSortNewestFirst((v) => !v)}
              title="Toggle sort by timestamp"
            >
              {sortNewestFirst ? "Newest first ↓" : "Oldest first ↑"}
            </button>
            <button
              type="button"
              data-testid="diag-copy"
              onClick={() => void handleCopy()}
              title={`Copy last ${COPY_TAIL} entries as JSON for bug report`}
            >
              Copy for bug report
            </button>
            <button
              type="button"
              data-testid="diag-clear"
              onClick={handleClear}
              title="Clear all diagnostic entries (two-click confirm)"
              className={clearArmed ? "diag-clear-armed" : undefined}
            >
              {clearConfirm.labelFor("clear", "Clear")}
            </button>
            <button
              className="dashboard-close"
              data-testid="diag-close"
              onClick={onClose}
              aria-label="Close diagnostics"
            >
              ✕
            </button>
          </div>
        </header>

        {copyStatus && (
          <div className="dashboard-error diag-copy-status" data-testid="diag-copy-status">
            {copyStatus}
          </div>
        )}

        <div className="dashboard-card diag-list" data-testid="diag-list">
          {filtered.length === 0 ? (
            <div className="dashboard-empty">
              {entries.length === 0
                ? "No diagnostics recorded yet — the app is quiet."
                : "No entries match the current filters."}
            </div>
          ) : (
            <table className="diag-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => {
                  const detail = detailToString(e.detail);
                  return (
                    <tr
                      key={`${e.ts}-${i}`}
                      data-testid="diag-row"
                      data-level={e.level}
                      data-source={e.source}
                    >
                      <td className="diag-cell-nowrap">{fmtTs(e.ts)}</td>
                      <td style={{ color: LEVEL_COLORS[e.level] }}>{e.level}</td>
                      <td className="diag-cell-nowrap">{e.source}</td>
                      <td>
                        <div>{e.message}</div>
                        {detail && (
                          <pre className="diag-detail">
                            {detail}
                          </pre>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer className="dashboard-empty diag-footer">
          {entries.length} entr{entries.length === 1 ? "y" : "ies"} held in ring buffer (cap 500).
          Persisted across reloads via localStorage (last 100).
        </footer>
      </div>
    </DiagnosticsOverlay>
  );
}

/**
 * Diagnostics overlay wrapper — splits the modal container out so the
 * a11y hook can own the ref + key handling without entangling the panel.
 */
function DiagnosticsOverlay({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open, onClose, containerRef: ref });
  return (
    <div
      className="dashboard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Diagnostics"
      data-testid="diagnostics-panel"
      ref={ref}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}
