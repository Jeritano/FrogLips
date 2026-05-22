import type { Message, WorkflowCard, WorkflowGraph } from "../../types";
import type { AgentRunOptions } from "../agent-loop";
import { runAgentLoop } from "../agent-loop";
import { loadAllPresets } from "../agent-presets";
import { api } from "../tauri-api";
import { resolveLinearOrder } from "./graph";

/** Per-card outcome — `skipped` cards are downstream of a failure. */
export type CardStatus = "ok" | "error" | "skipped";

export interface CardResult {
  cardId: string;
  name: string;
  status: CardStatus;
  /** Final assistant text from the card's agent run (empty on error/skip). */
  output: string;
  error?: string;
}

/** Aggregate result of a workflow run, also the shape persisted as JSON. */
export interface WorkflowRunResult {
  status: "ok" | "failed";
  cards: CardResult[];
}

/**
 * Lifecycle callbacks the UI subscribes to. Per-card state flows through these
 * — NOT Tauri events. `onCardOutput` may fire repeatedly as text streams in.
 */
export interface WorkflowHooks {
  onCardStart?: (cardId: string) => void;
  onCardOutput?: (cardId: string, text: string) => void;
  onCardDone?: (cardId: string, result: CardResult) => void;
  onCardError?: (cardId: string, err: string) => void;
  onWorkflowDone?: (results: WorkflowRunResult) => void;
}

/** Per-card output cap (chars) applied to the JSON persisted as a run record. */
const RECORD_OUTPUT_CAP = 6144;

export interface RunWorkflowOptions {
  /** The persisted workflow id — used to record the run. Null skips recording. */
  workflowId?: number | null;
  /**
   * True when the run was started by the scheduler (a `workflow-trigger`
   * event) rather than the user clicking Run. Only scheduled runs honor a
   * card's `unattended` opt-in to auto-approve its own declared tools.
   */
  scheduled?: boolean;
  /** Stops the chain when aborted; remaining cards are marked skipped. */
  signal?: AbortSignal;
  /** Workspace root threaded into every card's agent run. */
  workspaceRoot?: string | null;
  /** Model used when a card does not pin its own. Required to actually run. */
  model: string;
  /** Default backend when a card's `backend` is null. */
  defaultBackend?: AgentRunOptions["backend"];
  /** MLX connection details, forwarded to the agent loop when backend is mlx. */
  serverStatus?: AgentRunOptions["serverStatus"];
  /** Card index to start from (used by the scheduler glue). Defaults to 0. */
  startCardId?: string | null;
  /**
   * Confirmation gate forwarded to each card's agent run. Defaults to a
   * deny-all gate so an unattended workflow never silently runs a dangerous
   * tool.
   */
  requestConfirmation?: AgentRunOptions["requestConfirmation"];
}

const HANDOFF_PREFIX = "Output from previous step:\n";

/** Default confirmation gate for unattended runs: deny every dangerous call. */
const denyAll: AgentRunOptions["requestConfirmation"] = async () => ({ approve: false });

/** Resolve agent-run options for a single card, given upstream context text. */
function buildCardOptions(
  card: WorkflowCard,
  previousOutput: string | null,
  opts: RunWorkflowOptions,
  hooks: WorkflowHooks,
  signal: AbortSignal,
): AgentRunOptions {
  const preset = loadAllPresets().find((p) => p.id === card.preset);
  // Card-level `tools` win when non-empty; otherwise fall back to the preset's
  // allowlist (which itself may be empty = all tools).
  const toolAllowlist =
    card.tools.length > 0 ? card.tools : (preset?.allowedTools ?? []);

  const messages: Message[] = [];
  if (previousOutput != null && previousOutput.length > 0) {
    messages.push({
      conversation_id: 0,
      role: "user",
      content: `${HANDOFF_PREFIX}${previousOutput}`,
    });
  }
  messages.push({
    conversation_id: 0,
    role: "user",
    content: card.prompt,
  });

  const backend = (card.backend ?? opts.defaultBackend ?? "ollama") as
    AgentRunOptions["backend"];

  // On a scheduled run, a card opted into `unattended` auto-approves tool
  // calls — but only for tool names in its own declared allowlist. Every
  // other case keeps the caller's gate (default deny-all).
  const baseGate = opts.requestConfirmation ?? denyAll;
  const requestConfirmation: AgentRunOptions["requestConfirmation"] =
    opts.scheduled && card.unattended
      ? async (toolName, args, risk) =>
          card.tools.includes(toolName)
            ? { approve: true }
            : baseGate(toolName, args, risk)
      : baseGate;

  return {
    model: opts.model,
    messages,
    conversationId: 0,
    workspaceRoot: opts.workspaceRoot ?? null,
    backend,
    serverStatus: opts.serverStatus ?? null,
    systemPromptOverride: preset?.systemPromptOverride,
    toolAllowlist,
    approveAllShell: false,
    approveAllWrite: false,
    onUpdate: () => {},
    onStatusChange: () => {},
    onAssistantDelta: (text) => hooks.onCardOutput?.(card.id, text),
    requestConfirmation,
    signal,
  };
}

/**
 * Execute a workflow graph as a linear chain. Each card runs once through the
 * existing agent loop; the previous card's final text is injected as a user
 * message ("Output from previous step:\n…") into the next card.
 *
 * Lifecycle is reported through `hooks`. A single card failure stops the
 * chain — remaining cards are marked `skipped` and the run is recorded as
 * `failed`. An aborted signal behaves the same way.
 */
export async function runWorkflow(
  graph: WorkflowGraph,
  hooks: WorkflowHooks,
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const order = resolveLinearOrder(graph);
  const signal = opts.signal ?? new AbortController().signal;

  // Optional start-card offset (scheduler triggers a workflow from one card).
  let cards = order;
  if (opts.startCardId) {
    const idx = order.findIndex((c) => c.id === opts.startCardId);
    if (idx < 0) {
      throw new Error(`Start card "${opts.startCardId}" is not in the workflow graph.`);
    }
    cards = order.slice(idx);
  }

  const results: CardResult[] = [];
  let previousOutput: string | null = null;
  let failed = false;

  for (const card of cards) {
    if (failed || signal.aborted) {
      const result: CardResult = {
        cardId: card.id,
        name: card.name,
        status: "skipped",
        output: "",
      };
      results.push(result);
      hooks.onCardDone?.(card.id, result);
      continue;
    }

    hooks.onCardStart?.(card.id);
    try {
      const cardOpts = buildCardOptions(card, previousOutput, opts, hooks, signal);
      const final = await runAgentLoop(cardOpts);

      if (signal.aborted) {
        const result: CardResult = {
          cardId: card.id,
          name: card.name,
          status: "error",
          output: "",
          error: "Workflow aborted.",
        };
        results.push(result);
        failed = true;
        hooks.onCardError?.(card.id, result.error!);
        hooks.onCardDone?.(card.id, result);
        continue;
      }

      const output = final ?? "";
      previousOutput = output;
      const result: CardResult = {
        cardId: card.id,
        name: card.name,
        status: "ok",
        output,
      };
      results.push(result);
      // Output was already streamed incrementally via `onAssistantDelta →
      // onCardOutput`; do NOT re-emit the full text here or it shows twice.
      hooks.onCardDone?.(card.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: CardResult = {
        cardId: card.id,
        name: card.name,
        status: "error",
        output: "",
        error: message,
      };
      results.push(result);
      failed = true;
      hooks.onCardError?.(card.id, message);
      hooks.onCardDone?.(card.id, result);
    }
  }

  const runResult: WorkflowRunResult = {
    status: failed || signal.aborted ? "failed" : "ok",
    cards: results,
  };

  // Persist the run summary. Best-effort: a recording failure must not mask a
  // successful (or already-failed) workflow result.
  if (opts.workflowId != null) {
    try {
      // Cap each card's output before persisting — full agent transcripts
      // would bloat the run-record table.
      const recorded: WorkflowRunResult = {
        status: runResult.status,
        cards: runResult.cards.map((c) =>
          c.output.length > RECORD_OUTPUT_CAP
            ? { ...c, output: `${c.output.slice(0, RECORD_OUTPUT_CAP)}… [truncated]` }
            : c,
        ),
      };
      await api.workflowRunRecord(
        opts.workflowId,
        runResult.status,
        JSON.stringify(recorded),
      );
    } catch {/* recording is best-effort */}
  }

  hooks.onWorkflowDone?.(runResult);
  return runResult;
}
