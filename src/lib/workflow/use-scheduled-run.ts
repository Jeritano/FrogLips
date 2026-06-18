import { useCallback, useEffect, useState } from "react";

import { useTauriEvent } from "../../hooks/useTauriEvent";
import { useSettingsGetter } from "../../contexts/SettingsContext";
import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";
import { formatUserProfile } from "../user-profile";
import { parseWorkflow, type ServerStatus, type WorkflowCard } from "../../types";
import { resolveLinearOrder } from "./graph";
import { parseWorkflowTrigger } from "./schedule";
import { useWorkflowRunControl } from "./run-context";
import type { RunWorkflowOptions } from "./runner";

/**
 * App-level glue for the Rust scheduler's `workflow-trigger` event.
 *
 * WHY THIS LIVES AT APP SCOPE, NOT IN WorkflowsPage:
 * the Flows page (`WorkflowsPage`) is lazy-mounted and is rendered only while
 * the Flows view is open (`{view === "workflows" ? <WorkflowsPage/> : …}` in
 * App.tsx). If the `workflow-trigger` listener lived there, navigating to Chat
 * or Table would unmount it — the Rust scheduler would still emit (and mark the
 * card fired), so a flow scheduled to run while you were on another view was
 * silently dropped until its next occurrence. Mounting the listener here, below
 * the always-on `WorkflowRunProvider`, means a due flow fires regardless of
 * which view is open.
 *
 * HARD LIMIT (not fixed here, by design): the agent loop runs in this webview.
 * If the app is fully quit, its window closed (no tray-hide today), or the Mac
 * is asleep, nothing runs — there is no headless/background runner. Scheduling
 * is "fire due flows while Froglips is open and awake", NOT cron-style
 * unattended execution. The schedule editor says so (see CardForm).
 *
 * Runs go through the app-level `WorkflowRunProvider` (`run.start`), so the
 * canvas/RunSurface still paint live when the triggered flow happens to be open,
 * and the existing concurrent-run guard + completion notification apply.
 */
export function useScheduledWorkflowTrigger(status: ServerStatus | null): void {
  const run = useWorkflowRunControl();
  const getSettings = useSettingsGetter();
  const [userProfile, setUserProfile] = useState<string | null>(null);

  // Load the user profile once so scheduled agents know who the user is, the
  // same way WorkflowsPage seeds it for manual runs. Optional — a failure just
  // means the run goes without it.
  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        if (alive) setUserProfile(formatUserProfile(s.user_profile));
      })
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "workflow-schedule",
          message: "settingsGet failed (scheduled-run user profile)",
          detail: e,
        }),
      );
    return () => {
      alive = false;
    };
  }, [getSettings]);

  // Best-effort: bring up the card's pinned local model before the run, exactly
  // like WorkflowsPage's manual entry points — otherwise a scheduled local-model
  // flow runs with no server up and times out. Cloud (`:cloud`) models are
  // daemon-routed and need no start.
  const ensureCardModelLoaded = useCallback(
    async (card: WorkflowCard): Promise<void> => {
      if (!card.model) return;
      if (card.model.endsWith(":cloud")) return;
      if (status?.model === card.model && status?.running) return;
      const backend =
        card.backend === "native" ||
        card.backend === "mlx" ||
        card.backend === "ollama"
          ? card.backend
          : (status?.backend ?? "ollama");
      try {
        await api.startServer(card.model, backend);
      } catch (e) {
        logDiag({
          level: "info",
          source: "workflow-schedule",
          message: `ensureCardModelLoaded: startServer failed for ${card.model} (${backend}); continuing`,
          detail: e,
        });
      }
    },
    [status],
  );

  useTauriEvent<unknown>(
    "workflow-trigger",
    useCallback(
      (e) => {
        // Single-flight: never stack a scheduled run on top of a live one.
        if (run.runningWorkflowId !== null) {
          logDiag({
            level: "warn",
            source: "workflow-schedule",
            message: "workflow-trigger ignored — a run is already in progress",
          });
          return;
        }
        const trigger = parseWorkflowTrigger(e.payload);
        if (!trigger) return;
        // Always derive from the persisted graph, never from any open editor
        // buffer (the triggered flow may not be the one on screen).
        void (async () => {
          try {
            const raw = await api.workflowGet(trigger.workflow_id);
            if (!raw) return;
            const wf = parseWorkflow(raw);
            const order = resolveLinearOrder(wf.graph);
            const startIdx = trigger.card_id
              ? Math.max(
                  0,
                  order.findIndex((c) => c.id === trigger.card_id),
                )
              : 0;
            const reachable = order.slice(startIdx);

            // Mirror the runner's needsReview gate: refuse to auto-run a flow
            // the chat model authored with elevated tools until the user arms
            // it. Silent no-op + diagnostic, never a scary "run failed".
            const unreviewed = reachable.filter((c) => c.needsReview === true);
            if (unreviewed.length > 0) {
              logDiag({
                level: "warn",
                source: "workflow-schedule",
                message: `scheduled run skipped — ${unreviewed.length} card(s) still need review; Arm the flow first`,
              });
              return;
            }

            // Model-coverage gate: a card without its own model needs a loaded
            // default to fall back on. No default + missing model → skip rather
            // than start a run that will immediately fail.
            const missing = reachable.filter((c) => !c.model);
            const fallbackModel = status?.model ?? "";
            if (missing.length > 0 && !fallbackModel) {
              logDiag({
                level: "warn",
                source: "workflow-schedule",
                message: `scheduled run skipped — ${missing.length} card(s) have no model and no default is loaded`,
              });
              return;
            }

            const opts: Omit<RunWorkflowOptions, "signal" | "workflowId"> = {
              model: fallbackModel,
              defaultBackend:
                (status?.backend as RunWorkflowOptions["defaultBackend"]) ??
                undefined,
              serverStatus: status,
              userProfile: userProfile ?? undefined,
              scheduled: true,
              startCardId: trigger.card_id,
            };

            run.start({
              workflowId: wf.id,
              graph: wf.graph,
              workflowName: wf.name,
              opts,
              preflight: async (signal) => {
                const loaded = new Set<string>();
                for (const c of reachable) {
                  if (signal.aborted) break;
                  if (c.model && loaded.has(c.model)) continue;
                  await ensureCardModelLoaded(c);
                  if (c.model) loaded.add(c.model);
                }
              },
            });
          } catch (err) {
            logDiag({
              level: "warn",
              source: "workflow-schedule",
              message: "workflow-trigger handling failed",
              detail: err,
            });
          }
        })();
      },
      [run, status, userProfile, ensureCardModelLoaded],
    ),
  );
}

/**
 * Tiny always-mounted host for {@link useScheduledWorkflowTrigger}. Rendered
 * once in App's tree (below `WorkflowRunProvider`) so the run-control
 * subscription stays out of the heavy `<App>` body. Renders nothing.
 */
export function ScheduledWorkflowRunner({
  status,
}: {
  status: ServerStatus | null;
}): null {
  useScheduledWorkflowTrigger(status);
  return null;
}
