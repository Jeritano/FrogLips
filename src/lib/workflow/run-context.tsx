import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { runWorkflow } from "./runner";
import type {
  RunWorkflowOptions,
  WorkflowHooks,
  WorkflowRunResult,
} from "./runner";
import type { WorkflowGraph } from "../../types";
import type { CardRunState } from "../../components/workflows/AgentCardNode";
import { logDiag } from "../diagnostics";
import { announce } from "../announce";

/**
 * Per-card live state surface for the run panel.
 *
 * Mirrors the `CardRunInfo` shape `RunPanel.tsx` consumes, but lives at
 * the App-context level so it survives a `<WorkflowsPage>` unmount.
 */
export interface CardRunSnapshot {
  state: CardRunState;
  output: string;
  error?: string;
}

/**
 * Per-run summary kept after the run terminates so the user can return
 * to the Workflows view and see the final state instead of an empty
 * panel. Reset when the next run starts.
 */
export interface RunSummary {
  workflowId: number;
  status: "ok" | "failed";
  finishedAt: number;
  /** First few failing card name + error blurb, for the in-page banner
   *  that previously lived in WorkflowsPage state. Null on success. */
  errorBanner: string | null;
}

/**
 * **Stable** controls surface — id of the running workflow, the lifecycle
 * functions, and the cumulative summary. Updated only on transitions
 * (start / stop / done), so subscribers re-render at most once per run
 * boundary, not per streamed token.
 */
interface WorkflowRunControlCtx {
  runningWorkflowId: number | null;
  lastSummary: RunSummary | null;
  start(args: {
    workflowId: number;
    graph: WorkflowGraph;
    opts: Omit<RunWorkflowOptions, "signal" | "workflowId">;
    preflight?: (signal: AbortSignal) => Promise<void>;
  }): boolean;
  stop(): void;
  clearSummary(): void;
}

/**
 * **Hot** per-card state surface. Updates on every onCardOutput delta
 * (60+ times per second during streaming). Split from control surface
 * so consumers that only care about the runningWorkflowId chip — App
 * top bar, sidebar status — don't re-render per token (audit H7,
 * 2026-05-27).
 */
interface WorkflowRunCardCtx {
  cardStates: Record<string, CardRunSnapshot>;
}

/** Back-compat aggregate — subscribers using `useWorkflowRun()` still
 *  get the combined surface. New subscribers should prefer
 *  `useWorkflowRunControl()` or `useWorkflowRunCards()`. */
interface WorkflowRunCtx extends WorkflowRunControlCtx, WorkflowRunCardCtx {}

const ControlCtx = createContext<WorkflowRunControlCtx | null>(null);
const CardCtx = createContext<WorkflowRunCardCtx | null>(null);

/**
 * App-level provider that owns workflow run state. Mount once at the
 * App.tsx root. WorkflowsPage subscribes via `useWorkflowRun()`.
 *
 * Why a context instead of a hook called in WorkflowsPage:
 * the page unmounts on navigation (e.g. user clicks Chat). With state
 * inside the page, the unmount cleanup aborted the in-flight runner.
 * Lifting to App scope means only an App-level remount (full reload)
 * tears down the run.
 */
export function WorkflowRunProvider({ children }: { children: ReactNode }) {
  const [runningWorkflowId, setRunningWorkflowId] = useState<number | null>(null);
  const [cardStates, setCardStates] = useState<Record<string, CardRunSnapshot>>({});
  const [lastSummary, setLastSummary] = useState<RunSummary | null>(null);
  // Synchronous mirror — needed because `start` may be called twice in
  // the same event-loop tick (e.g. click + workflow-trigger event) and
  // the React state update wouldn't have applied yet.
  const runningIdRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const updateCard = useCallback(
    (id: string, patch: Partial<CardRunSnapshot>) => {
      setCardStates((s) => {
        const prev = s[id] ?? { state: "idle" as CardRunState, output: "" };
        return { ...s, [id]: { ...prev, ...patch } };
      });
    },
    [],
  );

  const clearSummary = useCallback(() => setLastSummary(null), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // Don't null abortRef.current synchronously — a second Stop click
    // is then a safe no-op, and the runner's onWorkflowDone path
    // resets everything when it actually wraps up.
  }, []);

  const start = useCallback<WorkflowRunCtx["start"]>(
    ({ workflowId, graph, opts, preflight }) => {
      if (runningIdRef.current !== null) {
        return false;
      }
      runningIdRef.current = workflowId;
      setRunningWorkflowId(workflowId);
      setCardStates({});
      setLastSummary(null);

      const ac = new AbortController();
      abortRef.current = ac;
      announce("Workflow run started");

      void (async () => {
        try {
          if (preflight) await preflight(ac.signal);
          if (ac.signal.aborted) return;

          const hooks: WorkflowHooks = {
            onCardStart: (id) => updateCard(id, { state: "running" }),
            onCardOutput: (id, text) => {
              setCardStates((s) => {
                const prev = s[id] ?? { state: "running" as CardRunState, output: "" };
                return { ...s, [id]: { ...prev, output: prev.output + text } };
              });
            },
            onCardDone: (id, result) => {
              if (result.status === "ok") updateCard(id, { state: "done" });
              else if (result.status === "skipped") updateCard(id, { state: "idle" });
              else if (result.status === "aborted" || result.status === "error") {
                updateCard(id, { state: "failed" });
              }
            },
            onCardError: (id, message) => {
              updateCard(id, { state: "failed", error: message });
            },
            onWorkflowDone: (results: WorkflowRunResult) => {
              // Compose user-visible banner same shape as the prior
              // in-WorkflowsPage logic so the UX is unchanged.
              let errorBanner: string | null = null;
              if (results.status === "failed") {
                const failed = results.cards.filter((c) => c.status === "error");
                if (failed.length > 0) {
                  const sample = failed.slice(0, 3).map((c) => {
                    const errMsg = (c.error ?? "unknown error").slice(0, 200);
                    return `${c.name}: ${errMsg}`;
                  });
                  const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
                  errorBanner = `Workflow failed — ${failed.length} card(s) errored:\n${sample.join("\n")}${more}`;
                }
              }
              setLastSummary({
                workflowId,
                status: results.status,
                finishedAt: Date.now(),
                errorBanner,
              });
              runningIdRef.current = null;
              abortRef.current = null;
              setRunningWorkflowId(null);
              announce(
                results.status === "ok"
                  ? "Workflow run finished"
                  : "Workflow run failed",
              );
            },
          };

          await runWorkflow(graph, hooks, {
            ...opts,
            workflowId,
            signal: ac.signal,
          });
        } catch (e) {
          logDiag({
            level: "error",
            source: "workflow-run",
            message: "runWorkflow threw outside hook path",
            detail: e,
          });
          setLastSummary({
            workflowId,
            status: "failed",
            finishedAt: Date.now(),
            errorBanner: `Workflow run failed: ${e}`,
          });
          runningIdRef.current = null;
          abortRef.current = null;
          setRunningWorkflowId(null);
        }
      })();

      return true;
    },
    [updateCard],
  );

  // Stable controls — memoized on transitions only, not on cardStates.
  // A subscriber to ControlCtx (e.g. App's top-bar workflows button)
  // re-renders only when the running id flips or the run summary lands,
  // NOT on every streamed token (audit H7).
  const controlValue = useMemo<WorkflowRunControlCtx>(
    () => ({ runningWorkflowId, lastSummary, start, stop, clearSummary }),
    [runningWorkflowId, lastSummary, start, stop, clearSummary],
  );
  // Hot per-card state — updates on every delta. Subscribers should be
  // scoped to the panel that actually renders the per-card chrome.
  const cardValue = useMemo<WorkflowRunCardCtx>(
    () => ({ cardStates }),
    [cardStates],
  );

  return (
    <ControlCtx.Provider value={controlValue}>
      <CardCtx.Provider value={cardValue}>{children}</CardCtx.Provider>
    </ControlCtx.Provider>
  );
}

/**
 * Subscribe to the stable controls only (running id + summary +
 * start/stop/clearSummary). Does NOT re-render on per-card streaming.
 * Use this in chrome that lives outside the workflows page (App top
 * bar, sidebar status chip).
 */
export function useWorkflowRunControl(): WorkflowRunControlCtx {
  const ctx = useContext(ControlCtx);
  if (!ctx) {
    throw new Error(
      "useWorkflowRunControl() must be used inside <WorkflowRunProvider>. " +
        "Mount the provider at the App.tsx root, above every page that " +
        "needs to observe or control workflow runs.",
    );
  }
  return ctx;
}

/**
 * Subscribe to per-card live state. Re-renders on every streamed token.
 * Use only inside the workflows page card panel.
 */
export function useWorkflowRunCards(): WorkflowRunCardCtx {
  const ctx = useContext(CardCtx);
  if (!ctx) {
    throw new Error(
      "useWorkflowRunCards() must be used inside <WorkflowRunProvider>.",
    );
  }
  return ctx;
}

/**
 * Back-compat aggregate. Existing call sites keep working; they pay the
 * old re-render cost (subscribed to both contexts). Migrate to the
 * narrower hooks above to drop the streaming-token re-render cost.
 *
 * Throws if used outside `<WorkflowRunProvider>`. That's deliberate —
 * a silent fallback would let a consumer silently lose run continuity
 * when the provider is accidentally removed during a refactor.
 */
export function useWorkflowRun(): WorkflowRunCtx {
  const control = useWorkflowRunControl();
  const cards = useWorkflowRunCards();
  return { ...control, ...cards };
}
