import { parseWorkflow } from "../../types";
import { logDiag } from "../diagnostics";
import { api } from "../tauri-api";
import { resolveLinearOrder } from "./graph";
import { runWorkflow } from "./runner";
import type {
  RunWorkflowOptions,
  WorkflowHooks,
  WorkflowRunResult,
} from "./runner";

/** Payload of the `workflow-trigger` Tauri event emitted by the scheduler. */
export interface WorkflowTriggerPayload {
  workflow_id: number;
  card_id: string;
}

/** Narrow an arbitrary event payload to a `WorkflowTriggerPayload`. */
export function parseWorkflowTrigger(
  payload: unknown,
): WorkflowTriggerPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  // `typeof number` is true for NaN, ±Infinity, floats, and negatives — none
  // of which are valid SQLite rowids. Require a positive integer and reject
  // anything else. Same idea on card_id: an empty string passes the type
  // check but produces a misleading "Start card "" is not in the workflow
  // graph." error downstream.
  if (
    typeof p.workflow_id !== "number" ||
    !Number.isInteger(p.workflow_id) ||
    p.workflow_id <= 0
  ) {
    return null;
  }
  if (typeof p.card_id !== "string" || p.card_id.length === 0) {
    return null;
  }
  return { workflow_id: p.workflow_id, card_id: p.card_id };
}

/**
 * React to a `workflow-trigger` event: load the workflow, then run it starting
 * from the triggered card. The UI owns the Tauri `listen` call and passes the
 * raw payload here.
 *
 * `runOpts` supplies the model/backend context the runner needs; `workflowId`
 * and `startCardId` are filled in from the payload, overriding any caller
 * value.
 */
export async function handleWorkflowTrigger(
  payload: unknown,
  hooks: WorkflowHooks,
  runOpts: Omit<RunWorkflowOptions, "workflowId" | "startCardId">,
): Promise<WorkflowRunResult> {
  const trigger = parseWorkflowTrigger(payload);
  if (!trigger) {
    throw new Error("Malformed workflow-trigger payload.");
  }
  const raw = await api.workflowGet(trigger.workflow_id);
  if (!raw) {
    throw new Error(`Workflow ${trigger.workflow_id} not found.`);
  }
  const workflow = parseWorkflow(raw);

  // needsReview gate (2026-06-12): refuse to auto-run an unreviewed flow. A
  // scheduled trigger must NEVER execute a card the chat model authored with
  // elevated capabilities until the user arms it in the editor — the runner
  // would throw, but a thrown scheduler trigger surfaces as a noisy error.
  // Instead, silently no-op with a diagnostic: compute the cards this trigger
  // would execute (the linear order from the triggered card forward) and, if
  // any still carries `needsReview === true`, emit a warn and return a clean
  // `ok`/empty result without ever entering the runner. Mirrors the runner's
  // own gate so the refusal reason matches what the user sees in the editor.
  const order = resolveLinearOrder(workflow.graph);
  const startIdx = order.findIndex((c) => c.id === trigger.card_id);
  const reachable = startIdx >= 0 ? order.slice(startIdx) : order;
  const unreviewed = reachable.filter((c) => c.needsReview === true);
  if (unreviewed.length > 0) {
    const names = unreviewed.map((c) => `"${c.name}"`).join(", ");
    logDiag({
      level: "warn",
      source: "workflow-schedule",
      message:
        `Scheduled trigger for workflow ${workflow.id} refused: card ${names} ` +
        `needs review — open it in the editor and Arm it before it can run.`,
    });
    // Clean no-op result: nothing ran, nothing failed. The diagnostic is the
    // only surfaced signal — the scheduler did not auto-run an unsafe card.
    return { status: "ok", cards: [] };
  }

  return runWorkflow(workflow.graph, hooks, {
    ...runOpts,
    workflowId: workflow.id,
    startCardId: trigger.card_id,
  });
}
