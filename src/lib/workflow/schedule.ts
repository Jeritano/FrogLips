import { parseWorkflow } from "../../types";
import { api } from "../tauri-api";
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
  return runWorkflow(workflow.graph, hooks, {
    ...runOpts,
    workflowId: workflow.id,
    startCardId: trigger.card_id,
  });
}
