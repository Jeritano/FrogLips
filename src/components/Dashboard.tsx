import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCw, X } from "lucide-react";
import { api } from "../lib/tauri-api";
import { useModalA11y } from "../lib/use-modal-a11y";
import { ClaudeSkillsPanel } from "./ClaudeSkillsPanel";
import type {
  AgentSessionMetricsRow,
  ApprovalCount,
  DashboardSummary,
  ToolLatencyRow,
} from "../types";

type WindowKey = "1h" | "24h" | "7d" | "all";

const WINDOW_OPTIONS: { key: WindowKey; label: string; ms: number | null }[] = [
  { key: "1h", label: "1h", ms: 60 * 60 * 1000 },
  { key: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All", ms: null },
];

const REFRESH_INTERVAL_MS = 30_000;

/* Color for each approval slice — matches the audit-log palette.
 * Note: kept as hex (not CSS vars) so the SVG <path fill={…}> attribute
 * resolves at render time. Live with the small theme-parity hit here. */
const APPROVAL_COLORS: Record<string, string> = {
  auto: "#71717a",
  session_allowed: "#22c55e",
  user_allowed: "#6366f1",
  denied: "#ef4444",
  dry_run: "#6cb6ff",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1) return n.toFixed(2);
  if (n < 1000) return `${Math.round(n)}`;
  return `${(n / 1000).toFixed(2)}s`;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

/* Sortable table key for the tool-latency table. */
type LatencyKey =
  | "tool_name"
  | "count"
  | "avg_ms"
  | "p50_ms"
  | "p95_ms"
  | "max_ms";

function bucketSessions(
  rows: AgentSessionMetricsRow[],
  bucketCount = 30,
): { label: string; tokps: number }[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const first = sorted[0].ts;
  const last = sorted[sorted.length - 1].ts;
  const span = Math.max(1, last - first);
  const bw = span / bucketCount;
  const buckets: { sumTok: number; sumMs: number; ts: number }[] = Array.from(
    { length: bucketCount },
    (_, i) => ({ sumTok: 0, sumMs: 0, ts: first + i * bw }),
  );
  for (const r of sorted) {
    let idx = Math.floor((r.ts - first) / bw);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx].sumTok += r.completion_tokens;
    buckets[idx].sumMs += r.total_llm_ms;
  }
  return buckets.map((b) => ({
    label: new Date(b.ts).toLocaleString(),
    tokps: b.sumMs > 0 ? b.sumTok / (b.sumMs / 1000) : 0,
  }));
}

function histogramIterations(
  rows: AgentSessionMetricsRow[],
  maxBucket = 40,
): number[] {
  const buckets = new Array(maxBucket + 1).fill(0);
  for (const r of rows) {
    const i = Math.max(0, Math.min(maxBucket, r.iterations));
    buckets[i]++;
  }
  // Trim trailing zeros for compactness, but keep at least 10 buckets.
  let last = buckets.length - 1;
  while (last > 9 && buckets[last] === 0) last--;
  return buckets.slice(0, last + 1);
}

export function Dashboard({ open, onClose }: Props) {
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sortKey, setSortKey] = useState<LatencyKey>("count");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Claude Skills panel state — owned by the dashboard so the panel
  // auto-closes when the dashboard closes (per spec).
  const [claudeSkillsOpen, setClaudeSkillsOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Out-of-order guard: rapid window switches (or the 30s interval racing a
  // manual switch) can resolve an older heavy summary after a newer one and
  // paint stale data. Drop any result that isn't the latest request.
  const refreshSeqRef = useRef(0);

  const [perfRows, setPerfRows] = useState<
    Array<{
      model: string;
      backend: string;
      samples: number;
      avg_tok_per_sec: number;
      avg_ttft_ms: number;
      last_ts: number;
    }>
  >([]);
  const refresh = useCallback(async () => {
    // Per-model perf ledger (wave D). Replaces the old derivation from
    // agent_session_metrics, whose tok/s folded prefill + every loop
    // iteration into the denominator — a model decoding at 15 tok/s could
    // display 3.
    void api
      .modelPerfSummary()
      .then(setPerfRows)
      .catch(() => {});
    const seq = ++refreshSeqRef.current;
    setBusy(true);
    setErr(null);
    try {
      // Audit M-F6: replace `.find(...)!` non-null assertion with a
      // default-fallback. If a future window key is added without
      // landing it in WINDOW_OPTIONS, the user sees the all-time
      // window instead of a null deref. Default = full history.
      const opt =
        WINDOW_OPTIONS.find((w) => w.key === windowKey) ??
        WINDOW_OPTIONS[WINDOW_OPTIONS.length - 1];
      const since = opt.ms == null ? null : Date.now() - opt.ms;
      const s = await api.agentDashboardSummary({
        since_ts: since,
        until_ts: null,
        limit: 10_000,
      });
      if (seq !== refreshSeqRef.current) return; // superseded by a newer refresh
      setSummary(s);
    } catch (e) {
      if (seq === refreshSeqRef.current) setErr(String(e));
    } finally {
      if (seq === refreshSeqRef.current) setBusy(false);
    }
  }, [windowKey]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    timerRef.current = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open, refresh]);

  // Auto-close the Claude Skills sub-panel when the dashboard itself
  // closes — the dashboard is the natural home for app-wide settings
  // and the panel should not outlive its host.
  useEffect(() => {
    if (!open) setClaudeSkillsOpen(false);
  }, [open]);

  const sortedLatency = useMemo<ToolLatencyRow[]>(() => {
    const rows = summary?.tool_latency ?? [];
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = Number(av);
      const bn = Number(bv);
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return sorted;
  }, [summary, sortKey, sortDir]);

  function toggleSort(k: LatencyKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "tool_name" ? "asc" : "desc");
    }
  }

  if (!open) return null;

  const toolCounts = summary?.tool_counts ?? [];
  const maxToolCount = toolCounts.reduce((m, t) => Math.max(m, t.count), 0);

  const sessions = summary?.session_metrics ?? [];
  const iterHist = histogramIterations(sessions);
  const maxIter = iterHist.reduce((m, c) => Math.max(m, c), 0);
  const throughput = bucketSessions(sessions, 30);
  const maxTokps = throughput.reduce((m, t) => Math.max(m, t.tokps), 0);

  const approvals = summary?.approval_counts ?? [];
  const approvalTotal = approvals.reduce((s, a) => s + a.count, 0);

  return (
    <DashboardOverlay open={open} onClose={onClose}>
      <div className="dashboard-modal">
        <header className="dashboard-header">
          <h2>Usage dashboard</h2>
          <div className="dashboard-controls">
            <div
              className="dashboard-windows"
              role="radiogroup"
              aria-label="Time window"
            >
              {WINDOW_OPTIONS.map((w) => (
                <label
                  key={w.key}
                  className={`dashboard-window ${windowKey === w.key ? "active" : ""}`}
                >
                  <input
                    type="radio"
                    name="dashboard-window"
                    value={w.key}
                    checked={windowKey === w.key}
                    onChange={() => setWindowKey(w.key)}
                  />
                  {w.label}
                </label>
              ))}
            </div>
            <button
              className="dashboard-refresh"
              onClick={() => void refresh()}
              disabled={busy}
              title="Refresh now"
            >
              {busy ? "…" : <RotateCw size={16} />}
            </button>
            <button
              className="dashboard-close"
              onClick={onClose}
              aria-label="Close dashboard"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {err && <div className="dashboard-error">{err}</div>}

        <div className="dashboard-grid">
          {/* 0. Per-model performance leaderboard (pure-decode tok/s; warm-only TTFT) */}
          <section
            className="dashboard-card"
            data-testid="dashboard-model-perf"
          >
            <h3>Model performance</h3>
            {perfRows.length === 0 ? (
              <div className="dashboard-empty">
                No samples yet — send a few messages on a local Ollama model.
              </div>
            ) : (
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>tok/s</th>
                    <th>TTFT</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  {perfRows.slice(0, 8).map((r) => (
                    <tr key={`${r.backend}:${r.model}`}>
                      <td title={`${r.model} (${r.backend})`}>{r.model}</td>
                      <td>{r.avg_tok_per_sec.toFixed(1)}</td>
                      <td>
                        {r.avg_ttft_ms >= 1000
                          ? `${(r.avg_ttft_ms / 1000).toFixed(1)}s`
                          : `${Math.round(r.avg_ttft_ms)}ms`}
                      </td>
                      <td>{r.samples}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          {/* 1. Tool call frequency */}
          <section
            className="dashboard-card"
            data-testid="dashboard-tool-counts"
          >
            <h3>Top tools ({toolCounts.length})</h3>
            {toolCounts.length === 0 ? (
              <div className="dashboard-empty">No tool calls in window.</div>
            ) : (
              <div className="dashboard-bars">
                {toolCounts.map((t) => {
                  const w =
                    maxToolCount > 0 ? (t.count / maxToolCount) * 100 : 0;
                  return (
                    <div key={t.tool_name} className="dashboard-bar-row">
                      <div className="dashboard-bar-label" title={t.tool_name}>
                        {t.tool_name}
                      </div>
                      <div className="dashboard-bar-track">
                        <div
                          className="dashboard-bar-fill"
                          style={{ width: `${w}%` }}
                        />
                      </div>
                      <div className="dashboard-bar-count">
                        {fmtInt(t.count)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 2. Tool latency */}
          <section className="dashboard-card" data-testid="dashboard-latency">
            <h3>Tool latency</h3>
            {sortedLatency.length === 0 ? (
              <div className="dashboard-empty">No tool calls in window.</div>
            ) : (
              <div className="dashboard-table-wrap">
                <table className="dashboard-table">
                  <thead>
                    <tr>
                      {(
                        [
                          ["tool_name", "Tool"],
                          ["count", "n"],
                          ["avg_ms", "avg"],
                          ["p50_ms", "p50"],
                          ["p95_ms", "p95"],
                          ["max_ms", "max"],
                        ] as [LatencyKey, string][]
                      ).map(([k, lbl]) => (
                        <th
                          key={k}
                          className={sortKey === k ? `sorted-${sortDir}` : ""}
                          onClick={() => toggleSort(k)}
                        >
                          {lbl}
                          {sortKey === k && (sortDir === "asc" ? " ▲" : " ▼")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLatency.map((r) => (
                      <tr key={r.tool_name}>
                        <td>{r.tool_name}</td>
                        <td className="num">{fmtInt(r.count)}</td>
                        <td className="num">{fmtMs(r.avg_ms)}</td>
                        <td className="num">{fmtMs(r.p50_ms)}</td>
                        <td className="num">{fmtMs(r.p95_ms)}</td>
                        <td className="num">{fmtMs(r.max_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 3. Agent iterations histogram */}
          <section
            className="dashboard-card"
            data-testid="dashboard-iterations"
          >
            <h3>Iterations / session</h3>
            {sessions.length === 0 ? (
              <div className="dashboard-empty">
                No completed agent sessions yet.
              </div>
            ) : (
              <IterationHistogram buckets={iterHist} max={maxIter} />
            )}
            <div className="dashboard-hint">
              {sessions.length} session{sessions.length === 1 ? "" : "s"}
            </div>
          </section>

          {/* 4. Token throughput */}
          <section
            className="dashboard-card"
            data-testid="dashboard-throughput"
          >
            <h3>Token throughput (tok/s)</h3>
            {throughput.length === 0 || maxTokps === 0 ? (
              <div className="dashboard-empty">No throughput data yet.</div>
            ) : (
              <ThroughputLine points={throughput} max={maxTokps} />
            )}
            <div className="dashboard-hint">
              prompt {fmtInt(summary?.total_prompt_tokens ?? 0)} · completion{" "}
              {fmtInt(summary?.total_completion_tokens ?? 0)}
            </div>
          </section>

          {/* 5. Approval source pie */}
          <section className="dashboard-card" data-testid="dashboard-approvals">
            <h3>Approval mix</h3>
            {approvals.length === 0 ? (
              <div className="dashboard-empty">No tool calls in window.</div>
            ) : (
              <ApprovalPie approvals={approvals} total={approvalTotal} />
            )}
          </section>

          {/* 6. Claude Skills — global library of Anthropic SKILL.md folders.
               Lives in the dashboard since it's app-wide settings (not
               scoped to a single conversation or workflow). */}
          <section
            className="dashboard-card"
            data-testid="dashboard-claude-skills"
          >
            <h3>Skills</h3>
            <div className="dashboard-empty">
              Manage the skills available to chat-mode agents. Imported folders
              are stored in the global library and surfaced to agents via
              <code>list_claude_skills()</code>.
            </div>
            <div className="dashboard-actions">
              <button
                type="button"
                className="dashboard-action-btn"
                data-testid="dashboard-open-claude-skills"
                onClick={() => setClaudeSkillsOpen(true)}
              >
                Manage Skills
              </button>
            </div>
          </section>
        </div>
      </div>

      <ClaudeSkillsPanel
        open={claudeSkillsOpen}
        onClose={() => setClaudeSkillsOpen(false)}
      />
    </DashboardOverlay>
  );
}

/**
 * Wraps the dashboard in the modal overlay div + a11y hook. Split out so the
 * hook can own the container ref without polluting the main component body.
 */
function DashboardOverlay({
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
      aria-label="Usage dashboard"
      data-testid="dashboard"
      ref={ref}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/* ── Sub-charts (inline SVG, no deps) ── */

function IterationHistogram({
  buckets,
  max,
}: {
  buckets: number[];
  max: number;
}) {
  const W = 360;
  const H = 120;
  const PAD_L = 22;
  const PAD_B = 18;
  const innerW = W - PAD_L - 4;
  const innerH = H - PAD_B - 4;
  const bw = buckets.length > 0 ? innerW / buckets.length : 0;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="dashboard-svg"
      preserveAspectRatio="none"
    >
      {buckets.map((c, i) => {
        const h = max > 0 ? (c / max) * innerH : 0;
        return (
          <rect
            key={i}
            x={PAD_L + i * bw + 1}
            y={4 + (innerH - h)}
            width={Math.max(1, bw - 2)}
            height={h}
            fill="var(--accent)"
            opacity={c > 0 ? 0.85 : 0.15}
          >
            <title>{`${i}+ iter: ${c}`}</title>
          </rect>
        );
      })}
      {/* x-axis tick labels: 0, mid, end */}
      <text x={PAD_L} y={H - 4} className="dashboard-svg-tick">
        0
      </text>
      <text
        x={PAD_L + innerW / 2}
        y={H - 4}
        className="dashboard-svg-tick"
        textAnchor="middle"
      >
        {Math.floor((buckets.length - 1) / 2)}
      </text>
      <text x={W - 4} y={H - 4} className="dashboard-svg-tick" textAnchor="end">
        {buckets.length - 1}+
      </text>
      {/* y-axis max */}
      <text x={4} y={12} className="dashboard-svg-tick">
        {max}
      </text>
    </svg>
  );
}

function ThroughputLine({
  points,
  max,
}: {
  points: { label: string; tokps: number }[];
  max: number;
}) {
  const W = 360;
  const H = 120;
  const PAD_L = 26;
  const PAD_B = 18;
  const innerW = W - PAD_L - 4;
  const innerH = H - PAD_B - 4;
  const n = points.length;
  if (n === 0 || max === 0) return null;
  const path = points
    .map((p, i) => {
      const x = PAD_L + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
      const y = 4 + (innerH - (p.tokps / max) * innerH);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="dashboard-svg"
      preserveAspectRatio="none"
    >
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      {points.map((p, i) => {
        const x = PAD_L + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
        const y = 4 + (innerH - (p.tokps / max) * innerH);
        return (
          <circle key={i} cx={x} cy={y} r={1.5} fill="var(--accent)">
            <title>{`${p.label}: ${p.tokps.toFixed(1)} tok/s`}</title>
          </circle>
        );
      })}
      <text x={4} y={12} className="dashboard-svg-tick">
        {max.toFixed(0)}
      </text>
      <text x={4} y={H - PAD_B + 12} className="dashboard-svg-tick">
        0
      </text>
    </svg>
  );
}

function ApprovalPie({
  approvals,
  total,
}: {
  approvals: ApprovalCount[];
  total: number;
}) {
  const R = 50;
  const CX = 60;
  const CY = 60;
  let acc = 0;
  const slices = approvals.map((a) => {
    const start = (acc / total) * Math.PI * 2;
    acc += a.count;
    const end = (acc / total) * Math.PI * 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = CX + R * Math.cos(start - Math.PI / 2);
    const y1 = CY + R * Math.sin(start - Math.PI / 2);
    const x2 = CX + R * Math.cos(end - Math.PI / 2);
    const y2 = CY + R * Math.sin(end - Math.PI / 2);
    // Full-circle special case: rendering as a path with d=… fails to draw
    // when the slice covers the entire ring. Fall back to a plain circle.
    const isFull = a.count === total;
    return {
      approval: a.approval,
      count: a.count,
      color: APPROVAL_COLORS[a.approval] ?? "#a1a1aa",
      d: isFull
        ? null
        : `M ${CX} ${CY} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
      isFull,
    };
  });
  return (
    <div className="dashboard-pie-wrap">
      <svg viewBox="0 0 120 120" className="dashboard-svg dashboard-pie">
        {slices.map((s, i) =>
          s.isFull ? (
            <circle key={i} cx={CX} cy={CY} r={R} fill={s.color}>
              <title>{`${s.approval}: ${s.count}`}</title>
            </circle>
          ) : (
            <path key={i} d={s.d ?? undefined} fill={s.color}>
              <title>{`${s.approval}: ${s.count}`}</title>
            </path>
          ),
        )}
      </svg>
      <ul className="dashboard-pie-legend">
        {slices.map((s) => (
          <li key={s.approval}>
            <span
              className="dashboard-pie-swatch"
              style={{ background: s.color }}
            />
            <span className="dashboard-pie-label">{s.approval}</span>
            <span className="dashboard-pie-count">
              {fmtInt(s.count)} (
              {total > 0 ? ((s.count / total) * 100).toFixed(0) : 0}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
