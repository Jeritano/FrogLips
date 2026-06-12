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
 */

import type { WorkflowCard, WorkflowEdge, WorkflowGraph } from "../../types";

export const MAX_FLOW_STEPS = 12;
export const MAX_INSTRUCTIONS = 4000;
export const MAX_FLOW_NAME = 80;
export const MAX_STEP_TITLE = 60;

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
 *  set. Nothing outside this can ever appear in a create_flow graph. */
const ALL_CURATED_TOOLS = new Set(Object.values(CURATED_TOOLS_FOR_ROLE).flat());

export interface FlowStepInput {
  title: string;
  role: string;
  instructions: string;
}

export type BuildResult =
  | { ok: true; name: string; graph: WorkflowGraph }
  | { ok: false; kind: string; message: string };

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Validate + build a linear Flow graph from the model's high-level input.
 * Fail-closed: returns `{ok:false, kind, message}` rather than throwing.
 */
export function buildLinearFlow(
  rawName: unknown,
  rawSteps: unknown,
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
    const step = rawSteps[i] as Partial<FlowStepInput> | null;
    if (!step || typeof step !== "object") {
      return {
        ok: false,
        kind: "bad_args",
        message: `step ${i} is not an object.`,
      };
    }
    const role = typeof step.role === "string" ? step.role : "";
    // Role must be in the closed allowlist (a fixed set of built-in preset ids).
    // The preset only affects the system prompt — the card's explicit curated
    // `tools[]` below override the preset's allowlist regardless — so this is the
    // sole role gate.
    if (!ALLOWED_FLOW_ROLES.has(role)) {
      return {
        ok: false,
        kind: "unknown_role",
        message: `step ${i}: role "${role}" not allowed. Use one of: ${[...ALLOWED_FLOW_ROLES].join(", ")}.`,
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

    // FRESH literal — the model's `step` object is NEVER spread, so it can't
    // inject unattended/schedule/nodeType/model/etc.
    const id = `card-${crypto.randomUUID()}`;
    cards.push({
      id,
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
      y: 80 + i * 160,
    });
    if (i > 0) edges.push({ from: cards[i - 1].id, to: id });
  }

  return {
    ok: true,
    name: clamp(rawName.trim(), MAX_FLOW_NAME),
    graph: { cards, edges },
  };
}

/**
 * Defense-in-depth assertion run by the dispatcher on the built graph BEFORE
 * saving. Re-checks every security invariant independently of the builder, so a
 * future builder regression can't silently ship a dangerous Flow.
 * Returns null if safe, or a violation message.
 */
export function assertFlowSafe(graph: WorkflowGraph): string | null {
  for (const c of graph.cards) {
    if (c.unattended === true) return `card "${c.name}" is unattended`;
    if (c.schedule != null) return `card "${c.name}" has a schedule`;
    if (c.nodeType && c.nodeType !== "agent")
      return `card "${c.name}" is not a plain agent`;
    if (c.nodeConfig != null) return `card "${c.name}" carries nodeConfig`;
    if (!Array.isArray(c.tools) || c.tools.length === 0)
      return `card "${c.name}" has no curated tools`;
    for (const t of c.tools) {
      if (!ALL_CURATED_TOOLS.has(t))
        return `card "${c.name}" carries non-curated tool "${t}"`;
    }
  }
  return null;
}
