import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytesBinary as fmtBytes } from "../lib/format";
import { api } from "../lib/tauri-api";
import type { AgentAuditRow, AgentAuditStats } from "../types";

const DEFAULT_LIMIT = 100;

const TIME_FILTERS: { label: string; sinceDeltaMs: number | null }[] = [
  { label: "All", sinceDeltaMs: null },
  { label: "1h", sinceDeltaMs: 60 * 60 * 1000 },
  { label: "24h", sinceDeltaMs: 24 * 60 * 60 * 1000 },
  { label: "7d", sinceDeltaMs: 7 * 24 * 60 * 60 * 1000 },
];

function fmtTs(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function AuditLog() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AgentAuditRow[]>([]);
  const [stats, setStats] = useState<AgentAuditStats | null>(null);
  const [tool, setTool] = useState<string>("");
  const [conv, setConv] = useState<string>("");
  const [timeIdx, setTimeIdx] = useState<number>(2); // default 24h
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [purgeDays, setPurgeDays] = useState<number>(30);

  // Out-of-order guard: rapid filter edits can resolve an older list after a
  // newer one and paint stale rows. Drop any result that isn't the latest
  // request (same pattern as MemoryPanel).
  const refreshSeqRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    setBusy(true);
    setErr(null);
    try {
      const since = TIME_FILTERS[timeIdx]?.sinceDeltaMs ?? null;
      const filter = {
        conversation_id: conv.trim() || null,
        tool_name: tool.trim() || null,
        since_ts: since == null ? null : Date.now() - since,
        limit: DEFAULT_LIMIT,
      };
      const [list, s] = await Promise.all([
        api.agentAuditList(filter),
        api.agentAuditStats(),
      ]);
      if (seq !== refreshSeqRef.current) return; // superseded by a newer refresh
      setRows(list);
      setStats(s);
    } catch (e) {
      if (seq === refreshSeqRef.current) setErr(String(e));
    } finally {
      if (seq === refreshSeqRef.current) setBusy(false);
    }
  }, [tool, conv, timeIdx]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function purge() {
    if (!Number.isFinite(purgeDays) || purgeDays < 1) {
      setErr("purge: days must be >= 1");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const n = await api.agentAuditPurge(purgeDays);
      setErr(`Purged ${n} rows older than ${purgeDays}d.`);
      await refresh();
    } catch (e) {
      setErr(`Purge failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  // Distinct tool list for the filter dropdown — derived from current rows.
  const toolOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.tool_name);
    return Array.from(set).sort();
  }, [rows]);

  return (
    <div className="audit-log-panel">
      <div className="audit-log-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="audit-log-title">Audit log</span>
        <span className="audit-log-hint">{open ? "[hide]" : "[show]"}</span>
        {stats && (
          <span className="audit-log-hint">
            {stats.total_calls_24h} calls / 24h
          </span>
        )}
      </div>

      {open && (
        <div className="audit-log-body">
          {stats && (
            <div className="audit-log-stats">
              <div>
                Top tools (24h):{" "}
                {stats.top_tools_24h.length === 0
                  ? "—"
                  : stats.top_tools_24h
                      .map((t) => `${t.tool_name} (${t.count})`)
                      .join(", ")}
              </div>
              {stats.avg_duration_ms_24h.length > 0 && (
                <div>
                  Avg ms:{" "}
                  {stats.avg_duration_ms_24h
                    .slice(0, 5)
                    .map((t) => `${t.tool_name} ${Math.round(t.avg_ms)}`)
                    .join(", ")}
                </div>
              )}
            </div>
          )}

          <div className="audit-log-filters">
            <label className="audit-log-field">
              Tool:&nbsp;
              <input
                list="audit-tools"
                value={tool}
                onChange={(e) => setTool(e.target.value)}
                placeholder="any"
                className="audit-input-tool"
              />
              <datalist id="audit-tools">
                {toolOptions.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className="audit-log-field">
              Conv:&nbsp;
              <input
                value={conv}
                onChange={(e) => setConv(e.target.value)}
                placeholder="any"
                className="audit-input-conv"
              />
            </label>
            <label className="audit-log-field">
              Time:&nbsp;
              <select
                value={timeIdx}
                onChange={(e) => setTimeIdx(Number(e.target.value))}
              >
                {TIME_FILTERS.map((f, i) => (
                  <option key={f.label} value={i}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => void refresh()} disabled={busy}>
              {busy ? "..." : "Refresh"}
            </button>
            <span className="audit-log-purge">
              Purge older than&nbsp;
              <input
                type="number"
                min={1}
                value={purgeDays}
                onChange={(e) => setPurgeDays(Number(e.target.value))}
                className="audit-input-days"
              />
              d&nbsp;
              <button onClick={() => void purge()} disabled={busy}>
                Purge
              </button>
            </span>
          </div>

          {err && <div className="audit-log-err">{err}</div>}

          <div className="audit-log-table-wrap">
            <table className="audit-log-table">
              <thead>
                <tr>
                  <th className="audit-col-l">Time</th>
                  <th className="audit-col-l">Tool</th>
                  <th className="audit-col-l">Approval</th>
                  <th className="audit-col-l">Outcome</th>
                  <th className="audit-col-r">ms</th>
                  <th className="audit-col-r">Size</th>
                  <th className="audit-col-l">Conv</th>
                  <th className="audit-col-l">Args</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="audit-log-empty">
                      {busy ? "Loading…" : "No audit rows."}
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="audit-cell-nowrap">{fmtTs(r.ts)}</td>
                    <td className="audit-cell-nowrap">{r.tool_name}</td>
                    <td>{r.approval}</td>
                    <td
                      className={
                        r.outcome === "ok"
                          ? undefined
                          : r.outcome === "denied"
                            ? "audit-outcome-denied"
                            : r.outcome === "dry_run"
                              ? "audit-outcome-dryrun"
                              : "audit-outcome-warn"
                      }
                      title={
                        r.outcome === "dry_run"
                          ? "Tool side-effect suppressed by dry-run mode"
                          : undefined
                      }
                    >
                      {r.outcome === "dry_run" ? "dry-run" : r.outcome}
                      {r.error_kind ? `:${r.error_kind}` : ""}
                    </td>
                    <td className="audit-col-r">{r.duration_ms}</td>
                    <td className="audit-col-r">{fmtBytes(r.result_size)}</td>
                    <td>{r.conversation_id ?? ""}</td>
                    <td className="audit-cell-args" title={r.args_json}>
                      {r.args_json}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
