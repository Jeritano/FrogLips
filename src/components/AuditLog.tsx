import { useCallback, useEffect, useMemo, useState } from "react";
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
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

  const refresh = useCallback(async () => {
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
      setRows(list);
      setStats(s);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
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
    <div className="audit-log-panel" style={{ borderTop: "1px solid var(--border, #333)", padding: 8 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontWeight: 600 }}>Audit log</span>
        <span style={{ fontSize: 11, color: "var(--text-muted, #888)" }}>
          {open ? "[hide]" : "[show]"}
        </span>
        {stats && (
          <span style={{ fontSize: 11, color: "var(--text-muted, #888)" }}>
            {stats.total_calls_24h} calls / 24h
          </span>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>
          {stats && (
            <div style={{ fontSize: 11, color: "var(--text-muted, #888)", marginBottom: 8 }}>
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

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <label style={{ fontSize: 11 }}>
              Tool:&nbsp;
              <input
                list="audit-tools"
                value={tool}
                onChange={(e) => setTool(e.target.value)}
                placeholder="any"
                style={{ width: 140 }}
              />
              <datalist id="audit-tools">
                {toolOptions.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label style={{ fontSize: 11 }}>
              Conv:&nbsp;
              <input
                value={conv}
                onChange={(e) => setConv(e.target.value)}
                placeholder="any"
                style={{ width: 100 }}
              />
            </label>
            <label style={{ fontSize: 11 }}>
              Time:&nbsp;
              <select value={timeIdx} onChange={(e) => setTimeIdx(Number(e.target.value))}>
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
            <span style={{ marginLeft: "auto", fontSize: 11 }}>
              Purge older than&nbsp;
              <input
                type="number"
                min={1}
                value={purgeDays}
                onChange={(e) => setPurgeDays(Number(e.target.value))}
                style={{ width: 56 }}
              />
              d&nbsp;
              <button onClick={() => void purge()} disabled={busy}>
                Purge
              </button>
            </span>
          </div>

          {err && (
            <div style={{ fontSize: 11, color: "var(--accent, #c66)", marginBottom: 6 }}>{err}</div>
          )}

          <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid var(--border, #333)" }}>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface, #1a1a1a)" }}>
                  <th style={{ textAlign: "left", padding: "2px 6px" }}>Time</th>
                  <th style={{ textAlign: "left", padding: "2px 6px" }}>Tool</th>
                  <th style={{ textAlign: "left", padding: "2px 6px" }}>Approval</th>
                  <th style={{ textAlign: "left", padding: "2px 6px" }}>Outcome</th>
                  <th style={{ textAlign: "right", padding: "2px 6px" }}>ms</th>
                  <th style={{ textAlign: "right", padding: "2px 6px" }}>Size</th>
                  <th style={{ textAlign: "left", padding: "2px 6px" }}>Conv</th>
                  <th style={{ textAlign: "left", padding: "2px 6px" }}>Args</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ padding: 8, color: "var(--text-muted, #888)" }}>
                      {busy ? "Loading…" : "No audit rows."}
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--border, #2a2a2a)" }}>
                    <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>{fmtTs(r.ts)}</td>
                    <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>{r.tool_name}</td>
                    <td style={{ padding: "2px 6px" }}>{r.approval}</td>
                    <td
                      style={{
                        padding: "2px 6px",
                        color:
                          r.outcome === "ok"
                            ? undefined
                            : r.outcome === "denied"
                            ? "var(--accent, #c66)"
                            : r.outcome === "dry_run"
                            ? "var(--info, #6cb6ff)"
                            : "var(--warning, #d9a86c)",
                      }}
                      title={r.outcome === "dry_run" ? "Tool side-effect suppressed by dry-run mode" : undefined}
                    >
                      {r.outcome === "dry_run" ? "dry-run" : r.outcome}
                      {r.error_kind ? `:${r.error_kind}` : ""}
                    </td>
                    <td style={{ padding: "2px 6px", textAlign: "right" }}>{r.duration_ms}</td>
                    <td style={{ padding: "2px 6px", textAlign: "right" }}>{fmtBytes(r.result_size)}</td>
                    <td style={{ padding: "2px 6px" }}>{r.conversation_id ?? ""}</td>
                    <td
                      style={{
                        padding: "2px 6px",
                        fontFamily: "monospace",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={r.args_json}
                    >
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
