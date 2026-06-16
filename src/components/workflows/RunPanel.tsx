import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Circle,
  CircleDashed,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { CardRunState } from "./AgentCardNode";
import type { WorkflowNodeType } from "../../types";

export interface CardRunInfo {
  id: string;
  name: string;
  state: CardRunState;
  output: string;
  error?: string;
  /**
   * The card's orchestration node type. Composite types (critic / cascade /
   * router / consistency / moa / budget) interleave sub-step status lines into
   * their streamed output; the panel parses those out into an inspectable
   * sub-step list. Absent / `"agent"` = a plain single-pass card (no sub-steps).
   */
  nodeType?: WorkflowNodeType;
}

interface Props {
  cards: CardRunInfo[];
  /** Id of the card currently running, for the auto-scroll-into-view. */
  runningCardId: string | null;
  /** Scroll + frame the matching node on the canvas (failed-card click). */
  onFocusNode: (id: string) => void;
  /** Re-run the graph resuming from this card (failed/partial recovery). */
  onRerunFromCard: (id: string) => void;
  /**
   * Stop the card currently running. The runner shares one abort signal across
   * the chain, so stopping the active card stops the run (downstream cards are
   * marked skipped) — there is no per-card resume. Surfaced per-row so the user
   * can halt a long card without hunting for the top-bar Stop.
   */
  onStopCard: (id: string) => void;
  /**
   * Active agent write-workspace (`api.agentGetWorkspace()` result). `null`
   * means no project folder is set, so file-writing cards fall back to the
   * home dir — we surface that as a warning chip so "where do files go?" is
   * never a mystery during a run. `undefined` = not yet loaded (render nothing).
   */
  workspace?: string | null;
}

const STATE_ICON: Record<CardRunState, ReactNode> = {
  idle: <Circle size={14} />,
  running: <CircleDashed size={14} />,
  done: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
};

/**
 * Node types that fan out / loop / escalate internally and therefore emit
 * sub-step status lines into their streamed output (see the handlers under
 * `lib/workflow/node-handlers`). For these we surface "which sub-steps ran".
 */
const COMPOSITE_NODE_TYPES = new Set<WorkflowNodeType>([
  "critic",
  "cascade",
  "router",
  "consistency",
  "moa",
  "budget",
]);

/**
 * Patterns the composite node handlers emit as sub-step status lines (via
 * `ctx.emit`). Kept in lock-step with the handler bodies in
 * `lib/workflow/node-handlers/*` — these are surfaced verbatim from the output
 * the handler already streams, so no handler change is required to populate the
 * sub-step list. Each entry matches one whole trimmed output line.
 *
 * NOTE: this reads sub-steps out of human-readable status TEXT, not structured
 * data. It is best-effort: a handler that changes its wording would silently
 * drop a sub-step here until this list is updated. If the sub-step view ever
 * needs to be authoritative, the handlers should emit a structured marker (e.g.
 * a `data-substep:` prefixed line) that this parser keys on instead — noted for
 * the node-handler owners.
 */
const SUBSTEP_PATTERNS: RegExp[] = [
  // critic
  /^Generating initial draft/i,
  /^Running verification:/i,
  /^Verification exit code:/i,
  /^Verification failed to run:/i,
  /^Critic iteration \d+:/i,
  /^Revising/i,
  // cascade
  /^Cascade —/i,
  /^Base score /i,
  /^Escalating to /i,
  // router
  /^Routed →/i,
  // consistency
  /^Self-consistency —/i,
  /^Majority vote:/i,
  /^No majority —/i,
  /^Merging \d+ samples/i,
  // moa
  /^Mixture-of-Agents —/i,
  /^Synthesizing \d+ proposals/i,
  // budget node + the universal budget wrapper
  /^Budget run/i,
  /^Budget ceiling \(/i,
];

/**
 * Extract the composite-node sub-step status lines from a card's streamed
 * output. Returns the matching lines in order, de-duplicated against the
 * immediately-preceding identical line (a re-emitted "Revising…" between two
 * iterations is meaningful; an exact dupe from a coalesced flush is not).
 */
function extractSubSteps(output: string): string[] {
  const out: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (SUBSTEP_PATTERNS.some((re) => re.test(line))) {
      if (out[out.length - 1] !== line) out.push(line);
    }
  }
  return out;
}

/**
 * One status row. Extracted + memoized (perf 2026-06-12) so a 16ms streaming
 * flush — which rebuilds the whole `CardRunInfo[]` with fresh object refs even
 * for unchanged cards — only reconciles the ONE row whose `output` grew. The
 * comparator checks the visible fields; the parent's handlers are `useCallback`
 * (stable), so non-streaming rows skip rendering entirely during a run.
 */
const RunPanelRow = memo(
  function RunPanelRow({
    card: c,
    isRunning,
    rowRef,
    onFocusNode,
    onRerunFromCard,
    onStopCard,
  }: {
    card: CardRunInfo;
    isRunning: boolean;
    rowRef?: React.Ref<HTMLDivElement>;
    onFocusNode: (id: string) => void;
    onRerunFromCard: (id: string) => void;
    onStopCard: (id: string) => void;
  }) {
    const isFailed = c.state === "failed";
    const isDone = c.state === "done";
    // Expand the full output (the live panel otherwise caps the displayed text
    // to a tail for perf; expanding shows everything in a taller, scrollable
    // pane). Copy reflects a 1.2s "copied" confirmation.
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
      () => () => {
        if (copyTimer.current) clearTimeout(copyTimer.current);
      },
      [],
    );
    const copyOutput = () => {
      const text = c.output || c.error || "";
      if (!text) return;
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => setCopied(false), 1200);
        },
        () => undefined,
      );
    };

    const isComposite =
      c.nodeType != null && COMPOSITE_NODE_TYPES.has(c.nodeType);
    const subSteps = isComposite ? extractSubSteps(c.output) : [];
    const hasOutput = c.output !== "";

    return (
      <div
        className="wf-run-item"
        data-state={c.state}
        ref={isRunning ? rowRef : undefined}
      >
        <div className="wf-run-item-head">
          <span
            className={`wf-run-icon wf-run-icon-${c.state}`}
            aria-hidden="true"
          >
            {STATE_ICON[c.state]}
          </span>
          {isFailed ? (
            // A failed row jumps to the offending node on the canvas so the user
            // can fix it without hunting for it on a busy graph. Inline reset
            // keeps the button looking like the plain name text it replaces.
            <button
              type="button"
              className="wf-run-item-name"
              onClick={() => onFocusNode(c.id)}
              title="Show this card on the canvas"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
                textDecoration: "underline",
                textUnderlineOffset: "2px",
                color: "inherit",
                font: "inherit",
              }}
            >
              {c.name}
            </button>
          ) : (
            <span className="wf-run-item-name">{c.name}</span>
          )}
          {/* Copy + expand controls. Only meaningful when there is output to
              inspect; rendered as quiet icon buttons to the right of the name. */}
          {hasOutput && (
            <span className="wf-run-item-actions">
              <button
                type="button"
                className="wf-run-icon-btn"
                onClick={copyOutput}
                title="Copy this card's full output"
                aria-label="Copy output"
                data-testid={`wf-run-copy-${c.id}`}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
              <button
                type="button"
                className="wf-run-icon-btn"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Collapse output" : "Expand full output"}
                aria-label={expanded ? "Collapse output" : "Expand output"}
                aria-expanded={expanded}
                data-testid={`wf-run-expand-${c.id}`}
              >
                {expanded ? (
                  <Minimize2 size={13} />
                ) : (
                  <Maximize2 size={13} />
                )}
              </button>
            </span>
          )}
        </div>
        {/* Composite-node sub-steps: which internal steps ran (iterations,
            escalation, route choice, vote, …). Surfaced from the handler's own
            streamed status lines. */}
        {subSteps.length > 0 && (
          <ol
            className="wf-run-substeps"
            data-testid={`wf-run-substeps-${c.id}`}
          >
            {subSteps.map((s, i) => (
              <li key={`${i}-${s}`} className="wf-run-substep">
                {s}
              </li>
            ))}
          </ol>
        )}
        {c.output && (
          <pre
            className={`wf-run-output${expanded ? " wf-run-output-expanded" : ""}`}
            data-testid={`wf-run-output-${c.id}`}
          >
            {c.output}
          </pre>
        )}
        {c.error && <pre className="wf-run-output wf-run-error">{c.error}</pre>}
        {isRunning && (
          <button
            type="button"
            className="wf-btn wf-btn-danger"
            onClick={() => onStopCard(c.id)}
            title="Stop this card (stops the run — downstream cards are skipped)"
            style={{ marginTop: "var(--space-2)", width: "100%" }}
            data-testid={`wf-run-stop-${c.id}`}
          >
            Stop this card
          </button>
        )}
        {/* Re-run from this card. Offered for a FAILED card (recover the chain
            from the break) and for a DONE card (re-run this card + everything
            downstream, e.g. after editing it) — but never while a run is in
            flight. The runner honors `startCardId`, so this resumes the chain
            from here rather than re-doing the upstream work. */}
        {(isFailed || isDone) && !isRunning && (
          <button
            type="button"
            className="wf-btn"
            onClick={() => onRerunFromCard(c.id)}
            title="Re-run the flow starting from this card"
            style={{ marginTop: "var(--space-2)", width: "100%" }}
            data-testid={`wf-run-rerun-${c.id}`}
          >
            Re-run from here
          </button>
        )}
      </div>
    );
  },
  // `card` is a fresh object every flush, so compare its VISIBLE fields, not its
  // ref — otherwise every row re-renders on every streamed token. Handlers are
  // useCallback-stable so they're intentionally not compared.
  (a, b) =>
    a.isRunning === b.isRunning &&
    a.rowRef === b.rowRef &&
    a.card.id === b.card.id &&
    a.card.name === b.card.name &&
    a.card.state === b.card.state &&
    a.card.output === b.card.output &&
    a.card.error === b.card.error &&
    a.card.nodeType === b.card.nodeType,
);

/**
 * Side panel: live per-card status and output.
 *
 * Run/Stop has moved into the global top-bar (next to the theme toggle) so
 * the workflow header stays at parity with chat's ModelPicker — see
 * WorkflowsPage.editorHeader. This panel is now read-only status PLUS recovery
 * + inspection affordances (adversarial review UX, 2026-06-12):
 *   - the running card auto-scrolls into view as the run advances, so a long
 *     chain doesn't bury the active step below the fold;
 *   - a failed card's row is clickable (focus its canvas node) and offers a
 *     "re-run from here" action that resumes the run from that card; a done
 *     card offers the same so a single card can be re-run on demand;
 *   - each card's output can be copied or expanded, and composite nodes
 *     (critic/cascade/router/consistency/moa/budget) list which sub-steps ran.
 */
export function RunPanel({
  cards,
  runningCardId,
  onFocusNode,
  onRerunFromCard,
  onStopCard,
  workspace,
}: Props) {
  // Auto-scroll the running card into view. Keyed on the running id so it
  // fires once per card transition, not on every streamed output update.
  const runningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (runningCardId && runningRef.current) {
      runningRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [runningCardId]);

  return (
    <aside className="wf-run-panel" data-testid="wf-run-panel">
      <div className="wf-run-head">
        <span>Status</span>
      </div>
      {/* Where-do-files-go indicator. A flow run never has an interactive
          confirm handler, so file-writing cards write to the active agent
          workspace — and an unset workspace silently scatters files under ~.
          Surface the destination so it's never a mystery. `undefined` = the
          workspace fetch hasn't resolved yet, so render nothing. */}
      {workspace !== undefined &&
        (workspace ? (
          <div
            className="wf-run-workspace"
            data-testid="wf-run-workspace"
            title={`Files write to: ${workspace}`}
          >
            <span className="wf-run-workspace-label">Files write to:</span>
            <span className="wf-run-workspace-path">{workspace}</span>
          </div>
        ) : (
          <div
            className="wf-run-workspace wf-run-workspace-warn"
            data-testid="wf-run-workspace-warn"
            role="status"
            title="No project folder is set — file-writing cards will write under your home folder. Set a workspace in Agent settings."
          >
            ⚠ Files write to your home folder — set a project folder in Agent
            settings
          </div>
        ))}
      <div className="wf-run-list">
        {cards.length === 0 && (
          <p className="wf-run-empty">No cards on the canvas yet.</p>
        )}
        {cards.map((c) => (
          <RunPanelRow
            key={c.id}
            card={c}
            isRunning={c.id === runningCardId}
            rowRef={c.id === runningCardId ? runningRef : undefined}
            onFocusNode={onFocusNode}
            onRerunFromCard={onRerunFromCard}
            onStopCard={onStopCard}
          />
        ))}
      </div>
    </aside>
  );
}
