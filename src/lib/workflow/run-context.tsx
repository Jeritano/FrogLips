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

interface WorkflowRunCtx {
  /** id of workflow currently running, or null if idle. */
  runningWorkflowId: number | null;
  /** Live per-card state. Keyed by card id. */
  cardStates: Record<string, CardRunSnapshot>;
  /** Last-run summary, persisted across navigation. */
  lastSummary: RunSummary | null;
  /**
   * Start a run. Refuses if a run is already in flight (returns false).
   * The actual `runWorkflow` invocation happens here so the AbortController
   * lives at provider scope — `<WorkflowsPage>` unmounting no longer
   * cancels the run.
   */
  start(args: {
    workflowId: number;
    graph: WorkflowGraph;
    opts: Omit<RunWorkflowOptions, "signal" | "workflowId">;
    /** Pre-flight hook (e.g. ensureCardModelLoaded) — awaited under the
     *  abort signal before `runWorkflow` kicks off. */
    preflight?: (signal: AbortSignal) => Promise<void>;
  }): boolean;
  /** Abort the in-flight run, if any. No-op when idle. */
  stop(): void;
  /** Clear the lastSummary banner without affecting an in-flight run. */
  clearSummary(): void;
}

const Ctx = createContext<WorkflowRunCtx | null>(null);

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

  const value = useMemo<WorkflowRunCtx>(
    () => ({ runningWorkflowId, cardStates, lastSummary, start, stop, clearSummary }),
    [runningWorkflowId, cardStates, lastSummary, start, stop, clearSummary],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Subscribe to the App-scoped workflow run state.
 *
 * Throws if used outside `<WorkflowRunProvider>`. That's deliberate —
 * a silent fallback would let a consumer silently lose run continuity
 * when the provider is accidentally removed during a refactor.
 */
export function useWorkflowRun(): WorkflowRunCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useWorkflowRun() must be used inside <WorkflowRunProvider>. " +
        "Mount the provider at the App.tsx root, above every page that " +
        "needs to observe or control workflow runs.",
    );
  }
  return ctx;
}
