/* ── create_flow builder ─────────────────────────────────────────────────────
 *
 * Turns a high-level {name, steps:[{title, role, instructions}]} (what the chat
 * model emits) into a VALIDATED, SAFE, linear Flow graph. The MODEL never
 * controls ids, edges, layout, or any security-relevant field — the builder
 * constructs each card from a fresh literal with hardcoded invariants:
 *
 *   • unattended:false  — a created Flow can never auto-approve its own tools.
 *   • schedule:null     — no scheduler auto-run trigger.
 *   • nodeType:"agent"  — no MoA/parallel fan-out.
 *   • tools = an EXPLICIT curated, read-only, NON-NETWORK allowlist per role.
 *
 * The last point is the exfil fix (sec red-team): an empty `tools:[]` would fall
 * back to the preset's allowlist (runner.ts — non-empty card tools OVERRIDE,
 * empty inherits), and the researcher/skeptic presets pair local-read with web
 * egress on one card — a silent exfiltration channel, because the run-time
 * confirm gate covers only DANGEROUS_TOOLS ∪ MCP, NOT read_file/web_fetch/git.
 * So every created card gets an explicit egress-free allowlist, and the role
 * enum excludes researcher/skeptic (read+web) and general (all tools).
 *
 * create_flow only SAVES the Flow — it never runs it. Worst case for a
 * prompt-injected agent: an inert, read-only Flow the trusted user must open +
 * run manually (where non-unattended cards still deny dangerous tools).
 *
 * ADVANCED mode (`buildAdvancedFlow`, 2026-06-12) lets the model author genuinely
 * powerful Flows — non-agent node types, a verifyCmd, network/edit/shell tools —
 * but EVERY elevated card lands `needsReview:true`, which the runner + scheduler
 * refuse to execute until the user arms it in the editor. The model still never
 * controls needsReview/unattended/schedule (all builder-hardcoded from a fresh
 * literal), so the worst case stays an inert Flow pending human review.
 */

import type {
  WorkflowCard,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNodeConfig,
  WorkflowNodeType,
} from "../../types";
import { NODE_META } from "./node-handlers/metadata";

export const MAX_FLOW_STEPS = 12;
export const MAX_INSTRUCTIONS = 4000;
export const MAX_FLOW_NAME = 80;
export const MAX_STEP_TITLE = 60;
/** verifyCmd is a shell command line — clamp it so a corrupt/adversarial blob
 *  can't push a runaway string into every critic/cascade pass. */
export const MAX_VERIFY_CMD = 2000;

const READ_ONLY_LOCAL = [
  "read_file",
  "list_dir",
  "search_files",
  "file_exists",
  "read_pdf",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branches",
];
const SCRATCHPAD = [
  "workflow_get",
  "workflow_keys",
  "workflow_get_prior_run",
  "workflow_set",
];

/**
 * Curated, exfil-safe per-role allowlists. NEVER includes web_fetch /
 * web_search / http_request / run_shell / run_code / write_file / edit_file /
 * delete_path or any other egress/mutation tool. A created card can read local
 * context + use the scratchpad to hand off; it cannot reach the network or
 * change the system on its own.
 */
export const CURATED_TOOLS_FOR_ROLE: Record<string, string[]> = {
  coder: [...READ_ONLY_LOCAL],
  shell: ["read_file", "list_dir", "file_exists"],
  critic: [...READ_ONLY_LOCAL, ...SCRATCHPAD],
  editor: [...READ_ONLY_LOCAL, ...SCRATCHPAD],
  summarizer: [...READ_ONLY_LOCAL, ...SCRATCHPAD],
};

/** Roles create_flow may emit. researcher/skeptic (read+web) + general (all
 *  tools) are deliberately excluded. */
export const ALLOWED_FLOW_ROLES = new Set(Object.keys(CURATED_TOOLS_FOR_ROLE));

/** Union of every tool any created card may carry — the post-build assertion
 *  set. Nothing outside this can ever appear in a SAFE-mode create_flow graph. */
const ALL_CURATED_TOOLS = new Set(Object.values(CURATED_TOOLS_FOR_ROLE).flat());

/* ── ADVANCED mode (2026-06-12) ──────────────────────────────────────────────
 *
 * Advanced Flows let the chat model author genuinely powerful pipelines —
 * non-agent node types (critic/cascade/moa/…), a per-step verifyCmd, and
 * network/edit/shell tools the safe set forbids. The safety trade is NOT that
 * these are harmless; it's that every elevated card lands with
 * `needsReview:true`, and the runner + scheduler REFUSE to execute a
 * needs-review card until the trusted user opens the editor and "Arm"s it. So a
 * prompt-injected agent's worst case is still an inert Flow the user must read,
 * arm card-by-card, and run manually — never an auto-running exfil/mutation chain.
 *
 * The model still NEVER controls the gate: needsReview/unattended/schedule are
 * builder-hardcoded on every advanced card (true/false/null respectively) from
 * a fresh literal — the model's step object is never spread.
 */

/** Roles reachable in advanced mode. The safe roles PLUS researcher/general so
 *  web/edit tools are even selectable — gated behind needsReview, which blocks
 *  running until the user arms the card. */
export const ADVANCED_FLOW_ROLES = new Set([
  ...ALLOWED_FLOW_ROLES,
  "researcher",
  "general",
]);

/** Node types the model MAY request in advanced mode. router/blackboard/budget
 *  are deliberately excluded — they need structured config (routes, ops, caps)
 *  the high-level step shape can't express safely, and the linear-chain
 *  invariant must hold. Derived from each node's `advancedAllowed` flag in the
 *  cycle-free `NODE_META` so the allowlist tracks the handlers (single source of
 *  truth) without dragging the agent-loop runtime into this module's init. */
export const ADVANCED_NODE_TYPES = new Set<WorkflowNodeType>(
  Object.values(NODE_META)
    .filter((m) => m.advancedAllowed)
    .map((m) => m.type),
);

/**
 * Advanced tool allowlist — SAFE-BUT-WIDER than the curated read-only set. An
 * explicit per-step `tools[]` is INTERSECTED with this; anything outside is
 * silently dropped. Includes read-only local + scratchpad + web egress + edit
 * + shell + git mutation + verify. NEVER includes the always-forbidden tools
 * below: even armed, an advanced card cannot delete, kill, undo, touch the
 * clipboard, run AppleScript, or launch apps.
 */
export const ADVANCED_ALLOWED_TOOLS = new Set<string>([
  ...READ_ONLY_LOCAL,
  ...SCRATCHPAD,
  // web egress
  "web_fetch",
  "web_search",
  "http_request",
  // mutation
  "edit_file",
  "multi_edit",
  "write_file",
  "run_shell",
  // git mutation (read-only git_* already in READ_ONLY_LOCAL)
  "git_commit",
  // verification helpers
  "calculate",
]);

/**
 * Tools that stay forbidden even in advanced mode, even after a card is armed.
 * These are irreversible / off-machine-control surfaces with no place in an
 * automatable Flow. Checked explicitly (belt-and-suspenders alongside the
 * allowlist intersection) so a future allowlist widening can't accidentally let
 * one through.
 */
export const ADVANCED_FORBIDDEN_TOOLS = new Set<string>([
  "delete_path",
  "kill_process",
  "agent_undo",
  "clipboard_get",
  "clipboard_set",
  "applescript_run",
  "open_app",
]);

export interface FlowStepInput {
  title: string;
  role: string;
  instructions: string;
}

/** Extra per-step fields the model may set ONLY in advanced mode. */
export interface AdvancedStepInput extends FlowStepInput {
  nodeType?: string;
  verifyCmd?: string;
  tools?: string[];
}

export type BuildResult =
  | { ok: true; name: string; graph: WorkflowGraph }
  | { ok: false; kind: string; message: string };

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** The per-step fields shared by both modes after the common gates pass:
 *  a validated role, the trimmed/clamped title, the trimmed instructions,
 *  the raw step (for the advanced builder's extra fields), and the index. */
interface ValidatedStep {
  role: string;
  title: string;
  instructions: string;
  step: Partial<AdvancedStepInput>;
  index: number;
}

/**
 * Shared scaffolding for both Flow builders. Runs the IDENTICAL envelope
 * validation (name, steps array, step count) and per-step gates (object shape,
 * role-allowlist membership, non-empty instructions, title clamp) for safe AND
 * advanced mode, then hands each validated step to `buildCard` — the only
 * per-mode part — to mint the fresh-literal card. The mode-specific card
 * builder is where every security invariant is stamped (unattended:false /
 * schedule:null and, for advanced, needsReview:true + the tool intersection);
 * this helper never spreads the model's step object into a card.
 *
 * `allowedRoles` is the mode's closed role set; `buildCard` returns the minted
 * card OR a `{ok:false}` BuildResult (used by advanced to reject a bad
 * nodeType). Edge chaining + the final name clamp are common.
 *
 * Fail-closed: returns `{ok:false, kind, message}` rather than throwing.
 */
function buildFlow(
  rawName: unknown,
  rawSteps: unknown,
  allowedRoles: Set<string>,
  buildCard: (v: ValidatedStep) => WorkflowCard | BuildResult,
): BuildResult {
  if (typeof rawName !== "string" || !rawName.trim()) {
    return {
      ok: false,
      kind: "bad_args",
      message: "name must be a non-empty string.",
    };
  }
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return {
      ok: false,
      kind: "bad_args",
      message: "steps must be a non-empty array.",
    };
  }
  if (rawSteps.length > MAX_FLOW_STEPS) {
    return {
      ok: false,
      kind: "too_many_steps",
      message: `At most ${MAX_FLOW_STEPS} steps (got ${rawSteps.length}).`,
    };
  }

  const cards: WorkflowCard[] = [];
  const edges: WorkflowEdge[] = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i] as Partial<AdvancedStepInput> | null;
    if (!step || typeof step !== "object") {
      return {
        ok: false,
        kind: "bad_args",
        message: `step ${i} is not an object.`,
      };
    }
    const role = typeof step.role === "string" ? step.role : "";
    // Role must be in the mode's closed allowlist (a fixed set of built-in
    // preset ids). The preset only affects the system prompt — the card's
    // explicit curated/intersected `tools[]` below override the preset's
    // allowlist regardless — so this is the sole role gate.
    if (!allowedRoles.has(role)) {
      return {
        ok: false,
        kind: "unknown_role",
        message: `step ${i}: role "${role}" not allowed. Use one of: ${[...allowedRoles].join(", ")}.`,
      };
    }
    const instructions =
      typeof step.instructions === "string" ? step.instructions.trim() : "";
    if (!instructions) {
      return {
        ok: false,
        kind: "bad_args",
        message: `step ${i}: instructions must be non-empty.`,
      };
    }
    const title =
      typeof step.title === "string" && step.title.trim()
        ? clamp(step.title.trim(), MAX_STEP_TITLE)
        : `Step ${i + 1}`;

    // Mint the card from a FRESH literal (buildCard never spreads `step`). A
    // builder may instead return a {ok:false} result to reject the step (e.g.
    // advanced's bad-nodeType gate) — propagate it unchanged.
    const built = buildCard({ role, title, instructions, step, index: i });
    if ("ok" in built) return built;
    cards.push(built);
    if (i > 0) edges.push({ from: cards[i - 1].id, to: built.id });
  }

  return {
    ok: true,
    name: clamp(rawName.trim(), MAX_FLOW_NAME),
    graph: { cards, edges },
  };
}

/**
 * Validate + build a linear Flow graph from the model's high-level input.
 * Fail-closed: returns `{ok:false, kind, message}` rather than throwing.
 */
export function buildLinearFlow(
  rawName: unknown,
  rawSteps: unknown,
): BuildResult {
  return buildFlow(
    rawName,
    rawSteps,
    ALLOWED_FLOW_ROLES,
    ({ role, title, instructions, index }) => {
      // FRESH literal — the model's `step` object is NEVER spread, so it can't
      // inject unattended/schedule/nodeType/model/etc. Curated egress-free
      // tools per role; plain agent; no orchestration config.
      return {
        id: `card-${crypto.randomUUID()}`,
        name: title,
        preset: role,
        prompt: clamp(instructions, MAX_INSTRUCTIONS),
        systemPrompt: null,
        tools: [...CURATED_TOOLS_FOR_ROLE[role]],
        schedule: null,
        backend: null,
        model: null,
        unattended: false,
        placed: true,
        nodeType: "agent",
        nodeConfig: null,
        x: 80,
        y: 80 + index * 160,
      };
    },
  );
}

/**
 * Build a minimal valid `nodeConfig` for an advanced node type. Only the fields
 * the handler actually needs are populated; everything else is left to the
 * runtime default (and re-clamped by `normalizeNodeConfig` on every load). The
 * agent node type carries no config (returns null).
 *
 * `verifyCmd` is only meaningful for critic/cascade (the loop runs it before
 * each critique pass); it's ignored for moa/consistency/agent.
 */
function buildAdvancedNodeConfig(
  nodeType: WorkflowNodeType,
  verifyCmd: string | null,
): WorkflowNodeConfig | null {
  // Delegate to the node's `buildDefaultConfig` (cycle-free `NODE_META`, the
  // single source of truth) so the built config tracks each handler's intent
  // rather than a duplicated literal here. `verifyCmd` is only honored by
  // critic/cascade.
  return NODE_META[nodeType].buildDefaultConfig(verifyCmd);
}

/**
 * ADVANCED build: like `buildLinearFlow` but lets the model request a non-agent
 * nodeType, a verifyCmd, and a wider (intersected) tools[] per step. EVERY card
 * is constructed from a FRESH literal with the gate hardcoded —
 * needsReview:true, unattended:false, schedule:null — so the model can never
 * arm a card or wire in auto-run. The dispatcher saves the result DISABLED; the
 * user arms each elevated card in the editor before it can run.
 *
 * Fail-closed: returns `{ok:false, kind, message}` rather than throwing.
 */
export function buildAdvancedFlow(
  rawName: unknown,
  rawSteps: unknown,
): BuildResult {
  // Same envelope + role/instructions/title gates as the safe builder (via
  // buildFlow), but with the EXPANDED advanced role set and a per-step builder
  // that mints the elevated card. Advanced cards may carry a non-agent
  // nodeType, a verifyCmd, and a wider (intersected) tools[] — every elevated
  // capability is gated behind the builder-hardcoded needsReview:true.
  return buildFlow(
    rawName,
    rawSteps,
    ADVANCED_FLOW_ROLES,
    ({ role, title, instructions, step, index }) => {
      // nodeType: validate against the advanced-allowed set; reject anything
      // else (incl. router/blackboard/budget) rather than silently downgrading,
      // so the model gets a clear error instead of a surprising plain-agent
      // card. Returning a {ok:false} result propagates out of buildFlow.
      const nodeType: WorkflowNodeType =
        step.nodeType == null ? "agent" : (step.nodeType as WorkflowNodeType);
      if (!ADVANCED_NODE_TYPES.has(nodeType)) {
        return {
          ok: false,
          kind: "bad_node_type",
          message: `step ${index}: nodeType "${String(step.nodeType)}" not allowed in advanced mode. Use one of: ${[...ADVANCED_NODE_TYPES].join(", ")}.`,
        };
      }

      // verifyCmd: clamp + only meaningful for critic/cascade (a shell command
      // run before each critique pass). For other node types it's dropped.
      const verifyCmd =
        typeof step.verifyCmd === "string" && step.verifyCmd.trim()
          ? clamp(step.verifyCmd.trim(), MAX_VERIFY_CMD)
          : null;

      // tools: an explicit list INTERSECTED with the advanced allowlist.
      // Anything outside (incl. every forbidden tool) is silently dropped. When
      // the model gives no tools, fall back to the role's curated safe set (or
      // read-only local for the expanded researcher/general roles, which have
      // no curated entry) so the card still has a sane non-empty allowlist.
      const requested = Array.isArray(step.tools)
        ? step.tools.filter((t): t is string => typeof t === "string")
        : [];
      let tools: string[];
      if (requested.length > 0) {
        // Intersect (preserve request order, dedupe, drop forbidden + non-allowed).
        const seen = new Set<string>();
        tools = [];
        for (const t of requested) {
          if (seen.has(t)) continue;
          if (ADVANCED_FORBIDDEN_TOOLS.has(t)) continue;
          if (!ADVANCED_ALLOWED_TOOLS.has(t)) continue;
          seen.add(t);
          tools.push(t);
        }
      } else {
        tools = [...(CURATED_TOOLS_FOR_ROLE[role] ?? READ_ONLY_LOCAL)];
      }
      // An intersection that wiped every tool would leave an empty allowlist,
      // which the runner reads as "inherit the preset" — the exact fallback the
      // safe builder guards against. Pin a read-only floor instead.
      if (tools.length === 0) tools = [...READ_ONLY_LOCAL];

      // FRESH literal — the model's `step` object is NEVER spread. needsReview/
      // unattended/schedule are builder-controlled and the model can't reach them.
      return {
        id: `card-${crypto.randomUUID()}`,
        name: title,
        preset: role,
        prompt: clamp(instructions, MAX_INSTRUCTIONS),
        systemPrompt: null,
        tools,
        schedule: null,
        backend: null,
        model: null,
        unattended: false,
        // The gate: every advanced card is saved DISABLED. Only the editor's
        // "Arm" action clears this; the model can never set it false.
        needsReview: true,
        placed: true,
        nodeType,
        nodeConfig: buildAdvancedNodeConfig(nodeType, verifyCmd),
        x: 80,
        y: 80 + index * 160,
      };
    },
  );
}

/**
 * Per-card invariants that BOTH the safe and advanced gates enforce
 * identically: no card may be unattended, scheduled, or carry an
 * empty/missing tool allowlist (an empty allowlist is read by the runner as
 * "inherit the preset" — the silent broadening both builders guard against).
 * Returns a violation message or null. The mode-specific checks
 * (curated-only vs advanced-allowlist+forbidden+needsReview) stay in each
 * caller — this shares only the truly-common gates so neither is weakened.
 */
function assertCardCommonSafe(c: WorkflowCard): string | null {
  if (c.unattended === true) return `card "${c.name}" is unattended`;
  if (c.schedule != null) return `card "${c.name}" has a schedule`;
  if (!Array.isArray(c.tools) || c.tools.length === 0)
    return `card "${c.name}" has no tools`;
  return null;
}

/**
 * Defense-in-depth assertion run by the dispatcher on the built graph BEFORE
 * saving. Re-checks every security invariant independently of the builder, so a
 * future builder regression can't silently ship a dangerous Flow.
 * Returns null if safe, or a violation message.
 */
export function assertFlowSafe(graph: WorkflowGraph): string | null {
  for (const c of graph.cards) {
    // Shared gates: unattended / scheduled / empty-tools.
    const common = assertCardCommonSafe(c);
    if (common) return common;
    // Safe-only gates: plain agent, no nodeConfig, curated tools only.
    if (c.nodeType && c.nodeType !== "agent")
      return `card "${c.name}" is not a plain agent`;
    if (c.nodeConfig != null) return `card "${c.name}" carries nodeConfig`;
    for (const t of c.tools) {
      if (!ALL_CURATED_TOOLS.has(t))
        return `card "${c.name}" carries non-curated tool "${t}"`;
    }
  }
  return null;
}

/**
 * Defense-in-depth assertion for ADVANCED Flows, run by the dispatcher before
 * saving. Advanced cards are ALLOWED to be powerful (non-agent nodeTypes, wider
 * tools) — but ONLY if they carry the review gate. This re-checks, independently
 * of the builder, that:
 *   • every card is non-unattended AND unscheduled (the model can never auto-run
 *     a created Flow, advanced or not);
 *   • any ELEVATED card — a non-agent nodeType OR any tool outside the safe
 *     curated set — is flagged needsReview:true (so the runner/scheduler refuse
 *     it until the user arms it);
 *   • every tool is within the advanced allowlist and none is forbidden.
 * Returns null if safe, or a violation message. So a future builder regression
 * can't ship an elevated card that runs without human review.
 */
export function assertFlowSafeAdvanced(graph: WorkflowGraph): string | null {
  for (const c of graph.cards) {
    // Shared gates: unattended / scheduled / empty-tools.
    const common = assertCardCommonSafe(c);
    if (common) return common;
    // Advanced-only gates: every tool within the advanced allowlist and none
    // forbidden; every elevated card flagged needsReview.
    for (const t of c.tools) {
      if (ADVANCED_FORBIDDEN_TOOLS.has(t))
        return `card "${c.name}" carries forbidden tool "${t}"`;
      if (!ADVANCED_ALLOWED_TOOLS.has(t))
        return `card "${c.name}" carries tool "${t}" outside the advanced allowlist`;
    }
    // An ELEVATED card — anything beyond a plain agent on the safe curated set —
    // MUST be gated. A non-agent nodeType OR a tool the safe builder would never
    // grant means the user has to arm it before it can run.
    const elevated =
      (c.nodeType != null && c.nodeType !== "agent") ||
      c.tools.some((t) => !ALL_CURATED_TOOLS.has(t));
    if (elevated && c.needsReview !== true)
      return `card "${c.name}" is elevated but not flagged needsReview`;
  }
  return null;
}
