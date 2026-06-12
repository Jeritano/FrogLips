import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearDiag,
  listDiag,
  subscribeDiag,
  type DiagEntry,
  type DiagLevel,
} from "../lib/diagnostics";
import { X } from "lucide-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
import { api } from "../lib/tauri-api";
import { EmptyState } from "./EmptyState";

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

const LEVEL_FILTERS: readonly ("all" | DiagLevel)[] = [
  "all",
  "info",
  "warn",
  "error",
] as const;

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
    try {
      return String(d);
    } catch {
      return "[unserialisable]";
    }
  }
}

export function DiagnosticsPanel({ open, onClose }: Props) {
  const [entries, setEntries] = useState<DiagEntry[]>(() => listDiag());
  const [level, setLevel] = useState<"all" | DiagLevel>("all");
  const [source, setSource] = useState<string>("");
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  // Crash log — fetched from the Rust `read_crash_log` command on open.
  // `null` while loading, "" when no crashes recorded.
  const [crashLog, setCrashLog] = useState<string | null>(null);
  const [crashLogError, setCrashLogError] = useState<string | null>(null);
  // Two-click confirm for the destructive Clear action (window.confirm is
  // disabled in Tauri 2's webview).
  const clearConfirm = useTwoClickConfirm();
  const clearArmed = clearConfirm.armed === "clear";

  // Data section — backup / export / import. `dataStatus` carries the inline
  // success/failure line; `dataBusy` flags the in-flight op so buttons lock.
  const [dataStatus, setDataStatus] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  // App version (shown in the header + useful when a user files a bug).
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    let alive = true;
    void import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then((v) => {
        if (alive) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  // Import adds data — give it a two-click confirm before the file picker.
  const importConfirm = useTwoClickConfirm();

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

  // Disarm the two-click-confirms when the panel closes so they don't carry
  // over to the next open.
  useEffect(() => {
    if (!open) {
      clearConfirm.reset();
      importConfirm.reset();
      setDataStatus(null);
    }
  }, [open, clearConfirm, importConfirm]);

  // Pull the crash log on open. A non-Tauri host (e.g. plain test/browser)
  // will reject the invoke — treat that as "no crashes" rather than surfacing
  // a noisy error.
  const refreshCrashLog = useCallback(async () => {
    setCrashLogError(null);
    setCrashLog(null);
    try {
      const text = await api.readCrashLog();
      setCrashLog(typeof text === "string" ? text : "");
    } catch (err) {
      setCrashLog("");
      setCrashLogError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshCrashLog();
  }, [open, refreshCrashLog]);

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
      setCopyStatus(
        `Copied ${tail.length} entr${tail.length === 1 ? "y" : "ies"}`,
      );
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
        setCopyStatus(
          `Copied ${tail.length} entr${tail.length === 1 ? "y" : "ies"} (fallback)`,
        );
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

  // Run a write-side data op: prompt for a save path, invoke `run(path)`, and
  // report inline. A null pick (dialog cancelled) is a silent no-op.
  const runSave = useCallback(
    async (
      label: string,
      defaultName: string,
      filters: { name: string; extensions: string[] }[],
      run: (path: string) => Promise<void>,
    ) => {
      setDataStatus(null);
      let dest: string | null = null;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        dest = await save({ defaultPath: defaultName, filters, title: label });
      } catch (err) {
        setDataStatus({
          kind: "err",
          text: `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      if (!dest) return;
      setDataBusy(true);
      try {
        await run(dest);
        setDataStatus({ kind: "ok", text: `${label} written to ${dest}` });
      } catch (err) {
        setDataStatus({
          kind: "err",
          text: `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setDataBusy(false);
      }
    },
    [],
  );

  const handleBackup = useCallback(() => {
    void runSave(
      "Database backup",
      "froglips-backup.db",
      [{ name: "SQLite database", extensions: ["db"] }],
      (path) => api.backupDatabase(path),
    );
  }, [runSave]);

  const handleExport = useCallback(() => {
    void runSave(
      "Data export",
      "froglips-export.json",
      [{ name: "JSON", extensions: ["json"] }],
      (path) => api.exportData(path),
    );
  }, [runSave]);

  const handleExportBundle = useCallback(() => {
    void runSave(
      "Diagnostics bundle",
      "froglips-diagnostics.zip",
      [{ name: "Zip archive", extensions: ["zip"] }],
      (path) => api.exportDiagnosticsBundle(path),
    );
  }, [runSave]);

  // Import is destructive-adjacent (adds rows) — gate it behind a two-click
  // confirm, then open a file picker and merge the chosen JSON export.
  const handleImport = useCallback(() => {
    importConfirm.request("import", () => {
      void (async () => {
        setDataStatus(null);
        let src: string | null = null;
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const res = await open({
            multiple: false,
            directory: false,
            filters: [{ name: "JSON", extensions: ["json"] }],
            title: "Import data",
          });
          src = Array.isArray(res) ? (res[0] ?? null) : res;
        } catch (err) {
          setDataStatus({
            kind: "err",
            text: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        if (!src) return;
        setDataBusy(true);
        try {
          await api.importData(src);
          setDataStatus({ kind: "ok", text: `Imported data from ${src}` });
        } catch (err) {
          setDataStatus({
            kind: "err",
            text: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        } finally {
          setDataBusy(false);
        }
      })();
    });
  }, [importConfirm]);

  if (!open) return null;

  return (
    <DiagnosticsOverlay open={open} onClose={onClose}>
      <div className="dashboard-modal diag-modal">
        <header className="dashboard-header">
          <h2>
            Diagnostics
            {appVersion && (
              <span className="diag-version"> · Froglips v{appVersion}</span>
            )}
          </h2>
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
              <X size={16} />
            </button>
          </div>
        </header>

        {copyStatus && (
          <div
            className="dashboard-error diag-copy-status"
            data-testid="diag-copy-status"
            role="status"
          >
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
                      <td style={{ color: LEVEL_COLORS[e.level] }}>
                        {e.level}
                      </td>
                      <td className="diag-cell-nowrap">{e.source}</td>
                      <td>
                        <div>{e.message}</div>
                        {detail && <pre className="diag-detail">{detail}</pre>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <section className="dashboard-card diag-data" data-testid="diag-data">
          <div className="diag-data-head">
            <h3>Data</h3>
          </div>
          <div className="diag-data-actions">
            <button
              type="button"
              data-testid="diag-data-backup"
              onClick={handleBackup}
              disabled={dataBusy}
              title="Write a single-file copy of the local database"
            >
              Back up database
            </button>
            <button
              type="button"
              data-testid="diag-data-export"
              onClick={handleExport}
              disabled={dataBusy}
              title="Export conversations, messages and memory as JSON"
            >
              Export data (JSON)
            </button>
            <button
              type="button"
              data-testid="diag-data-import"
              onClick={handleImport}
              disabled={dataBusy}
              title="Additively import a JSON data export (two-click confirm)"
              className={
                importConfirm.armed === "import"
                  ? "diag-clear-armed"
                  : undefined
              }
            >
              {importConfirm.labelFor("import", "Import data")}
            </button>
            <button
              type="button"
              data-testid="diag-data-bundle"
              onClick={handleExportBundle}
              disabled={dataBusy}
              title="Export a diagnostics bundle for bug reports"
            >
              Export diagnostics bundle
            </button>
            <a
              className="diag-report-link"
              href="https://github.com/Jeritano/FrogLips/issues/new"
              target="_blank"
              rel="noreferrer"
              title="Open a new issue on GitHub (attach the diagnostics bundle)"
            >
              Report an issue ↗
            </a>
          </div>
          {dataStatus && (
            <div
              className={
                dataStatus.kind === "err"
                  ? "dashboard-error diag-data-status"
                  : "diag-data-status"
              }
              data-testid="diag-data-status"
              role="status"
            >
              {dataStatus.text}
            </div>
          )}
        </section>

        <section className="dashboard-card diag-crash" data-testid="diag-crash">
          <div className="diag-crash-head">
            <h3>Crash log</h3>
            <button
              type="button"
              data-testid="diag-crash-refresh"
              onClick={() => void refreshCrashLog()}
              title="Re-read the local crash log"
            >
              Refresh
            </button>
          </div>
          {crashLog === null ? (
            <div className="dashboard-empty">Loading crash log…</div>
          ) : crashLog.length === 0 ? (
            <EmptyState
              heading="No crashes recorded"
              sub="The local crash log is empty — nothing has crashed."
              data-testid="diag-crash-empty"
            />
          ) : (
            <pre
              className="diag-detail diag-crash-log"
              data-testid="diag-crash-log"
            >
              {crashLog}
            </pre>
          )}
          {crashLogError && crashLog?.length === 0 && (
            <div className="diag-crash-note" data-testid="diag-crash-note">
              Crash log unavailable: {crashLogError}
            </div>
          )}
        </section>

        <footer className="dashboard-empty diag-footer">
          {entries.length} entr{entries.length === 1 ? "y" : "ies"} held in ring
          buffer (cap 500). Persisted across reloads via localStorage (last
          100).
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
