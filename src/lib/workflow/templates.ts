/* ── Bundled Flow templates ──────────────────────────────────────────────────
 *
 * Proven, ready-to-run Flows that show the headline value: chain a few small
 * local models into a pipeline that punches above any single model call. Shown
 * in the Flows hub gallery; "Use template" clones the graph into a new workflow.
 *
 * Each graph passes validateGraph (cards carry id/name/preset/prompt + layout;
 * edges chain them). Card ids are unique within the template; cloning into a new
 * workflow needs no re-id (ids only need to be unique within one graph).
 */

import type { WorkflowCard, WorkflowGraph } from "../../types";

export interface FlowTemplate {
  id: string;
  name: string;
  category: string;
  /** One-line gallery summary. */
  summary: string;
  graph: WorkflowGraph;
}

/** Card factory — fills the boilerplate so a template only states what matters. */
function card(
  id: string,
  x: number,
  partial: Pick<WorkflowCard, "name" | "preset" | "prompt"> &
    Partial<WorkflowCard>,
): WorkflowCard {
  return {
    id,
    schedule: null,
    backend: null,
    model: null,
    placed: true,
    unattended: false,
    tools: [],
    x,
    y: 0,
    ...partial,
  };
}

const chain = (ids: string[]) =>
  ids.slice(1).map((to, i) => ({ from: ids[i], to }));

const RESEARCH_TOOLS = [
  "web_search",
  "web_fetch",
  "read_file",
  "list_dir",
  "search_files",
];
const CODE_TOOLS = [
  "read_file",
  "list_dir",
  "search_files",
  "git_status",
  "git_diff",
  "git_log",
];

/* ── Dev-workforce templates (Feature Crew / Bug Hunter) ─────────────────────
 *
 * Design spec: docs/DEV_WORKFLOWS_2026-06.md. These two encode the Wave 1
 * primitives as shipped defaults: verifyCmd-grounded critic loops,
 * criticSystemPrompt (the verifier judges from its own stance, not the
 * implementer's persona), a budget ceiling (maxMs) on EVERY card, and
 * haltWhen gates on the blocking verdicts.
 *
 * Economy doctrine: cards leave `model` null so the bulk of the work runs on
 * whatever LOCAL model the user already has loaded. The ONLY cloud touchpoint
 * is the Feature Crew architect cascade, and it escalates to a flat-rate
 * Ollama `:cloud` tag — never a premium per-token frontier API. Plans are a
 * few thousand tokens, so even that spend is trivial; implementation stays
 * fully local/private. Swap the escalation tag in the card editor if you
 * prefer a different hosted model (any `*:cloud` tag works).
 *
 * verifyCmd ships as `npm test` — a placeholder; edit it per project in the
 * card editor (the prompts remind the model + user of this too).
 */

/** Cheap hosted escalation tier (Ollama Cloud, flat-rate). NOT a frontier API. */
const CLOUD_ESCALATION_MODEL = "glm-4.6:cloud";

const PAD_TOOLS = ["workflow_set", "workflow_get", "workflow_keys"];
/** Read-only repo navigation shared by the dev-workforce cards. */
const REPO_READ_TOOLS = [
  "read_file",
  "list_dir",
  "search_files",
  "file_exists",
  "git_log",
  "git_show",
  "git_diff",
  "git_status",
  "find_definition",
  "find_references",
];
const REPO_EDIT_TOOLS = ["edit_file", "multi_edit", "write_file", "run_shell"];

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "deep-research",
    name: "Deep Research",
    category: "Research",
    summary:
      "Gather sources → cross-check → synthesize a cited brief. Beats one model guessing.",
    graph: {
      cards: [
        card("r1", 0, {
          name: "Gather",
          preset: "researcher",
          prompt:
            "Research the user's question. Use web_search + web_fetch (prefer JSON/API endpoints) to collect facts from multiple independent sources. Output the raw findings with each source URL.",
          tools: RESEARCH_TOOLS,
        }),
        card("r2", 320, {
          name: "Verify",
          preset: "skeptic",
          prompt:
            "You are given research findings. Cross-check the claims against the cited sources, flag anything unsupported or contradictory, and drop low-confidence items. Output the verified facts only.",
          tools: RESEARCH_TOOLS,
        }),
        card("r3", 640, {
          name: "Brief",
          preset: "summarizer",
          prompt:
            "Write a tight, well-structured brief from the verified facts. Lead with the answer, then supporting points, then a Sources list. No fluff.",
          tools: [],
        }),
      ],
      edges: chain(["r1", "r2", "r3"]),
    },
  },
  {
    id: "code-review",
    name: "Code Review",
    category: "Code",
    summary:
      "Read the diff → adversarial review → concrete fixes. A reviewer that doesn't rubber-stamp.",
    graph: {
      cards: [
        card("c1", 0, {
          name: "Read diff",
          preset: "coder",
          prompt:
            "Inspect the current repo state with git_status + git_diff (and read_file for context). Summarize what changed and why, file by file.",
          tools: CODE_TOOLS,
        }),
        card("c2", 320, {
          name: "Critique",
          preset: "skeptic",
          prompt:
            "Adversarially review the change for correctness bugs, edge cases, security issues, and missing tests. Be specific: file + line + why. Assume something is wrong until proven otherwise.",
          tools: CODE_TOOLS,
        }),
        card("c3", 640, {
          name: "Fixes",
          preset: "editor",
          prompt:
            "Turn the critique into a concrete, ordered fix list: for each issue, the exact change to make. Group by file. Skip anything that turned out to be a non-issue.",
          tools: ["read_file"],
        }),
      ],
      edges: chain(["c1", "c2", "c3"]),
    },
  },
  {
    id: "brainstorm-moa",
    name: "Brainstorm + refine",
    category: "Ideation",
    summary:
      "Pragmatic idea → ambitious counter → synthesis. Diverge, then converge.",
    graph: {
      cards: [
        card("b1", 0, {
          name: "Pragmatic",
          preset: "general",
          prompt:
            "Propose the most PRACTICAL approach to the user's goal — what ships fastest with least risk. Be concrete.",
          tools: [],
        }),
        card("b2", 320, {
          name: "Ambitious",
          preset: "general",
          prompt:
            "You're given a pragmatic proposal. Now propose a MORE AMBITIOUS alternative — ignore short-term cost, aim for the best possible outcome — and name what it buys over the pragmatic one.",
          tools: [],
        }),
        card("b3", 640, {
          name: "Synthesize",
          preset: "summarizer",
          prompt:
            "You're given a pragmatic proposal and an ambitious alternative. Merge their best ideas into one recommended plan, stating the trade-off you chose and why.",
          tools: [],
        }),
      ],
      edges: chain(["b1", "b2", "b3"]),
    },
  },
  {
    id: "summarize-folder",
    name: "Summarize a project",
    category: "Knowledge",
    summary:
      "Read a folder → distill what it does + how it's structured. Onboarding in one click.",
    graph: {
      cards: [
        card("s1", 0, {
          name: "Survey",
          preset: "researcher",
          prompt:
            "Survey the workspace: list_dir the top levels, read the README and key entry-point files, and search_files for the main modules. Output a factual map of the project.",
          tools: ["read_file", "list_dir", "search_files"],
        }),
        card("s2", 320, {
          name: "Explain",
          preset: "summarizer",
          prompt:
            "From the project map, write a clear overview: what it does, the main components, and how to get started. Aimed at a new contributor.",
          tools: [],
        }),
      ],
      edges: chain(["s1", "s2"]),
    },
  },
  {
    id: "feature-crew",
    name: "Feature Crew",
    category: "Code",
    summary:
      "Spec → architect → implement → review → ship. Local models do the work; weak plans escalate to a flat-rate :cloud tier, and a block verdict halts before anything is committed.",
    graph: {
      cards: [
        card("fc1", 0, {
          name: "Spec Writer",
          preset: "researcher",
          prompt:
            "You are the Spec Writer for a feature crew. Convert the user's feature request into an unambiguous, testable specification grounded in the actual codebase: read the relevant modules first and cite a file path for every integration point you name. Produce (1) user-visible behavior, (2) acceptance criteria as a numbered list of independently verifiable assertions, (3) explicit non-goals, (4) the files this feature touches. Call workflow_set('spec', '<markdown spec>') and workflow_set('acceptance', ['<one string per criterion>']) before ending the turn. Do not design the implementation and do not write code — every ambiguity you remove here is rework you save downstream. End with a three-line summary in chat.",
          tools: [
            "read_file",
            "list_dir",
            "search_files",
            "file_exists",
            "git_log",
            "git_show",
            "search_project_knowledge",
            ...PAD_TOOLS,
          ],
          nodeConfig: { maxMs: 600_000 },
        }),
        card("fc2", 320, {
          name: "Architect",
          preset: "coder",
          prompt:
            "You are the Architect. Read workflow_get('spec') and design the complete implementation in prose — no diffs, no code blocks longer than five lines; a separate implementer translates your plan into edits. Trace the real code paths with read_file and find_references before deciding anything; never design against an imagined API. Output a numbered plan where each step names the exact files to change, the change itself, the order, and the test that proves the step worked. Include a Risks section naming the single place this plan is most likely to break. Persist workflow_set('plan', '<numbered plan>') and workflow_set('test_cmd', '<the project's real test command, verified to exist>').",
          tools: [...REPO_READ_TOOLS, ...PAD_TOOLS],
          nodeType: "cascade",
          nodeConfig: {
            passThreshold: 75,
            // The one cloud touchpoint: a weak local plan escalates to the
            // flat-rate hosted tier. Plans are small — spend stays trivial.
            escalateModel: CLOUD_ESCALATION_MODEL,
            escalateBackend: "ollama",
            criticPrompt:
              "Score 0-100 how well this implementation plan satisfies the spec in workflow_get('spec'): complete coverage of every acceptance criterion, correct step ordering, real file paths (not invented), and a verifying test named for every step. Reply with 'SCORE: <number>' followed by one short reason.",
            maxMs: 900_000,
          },
        }),
        card("fc3", 640, {
          name: "Implementer",
          preset: "coder",
          prompt:
            "You are the Implementer. Execute workflow_get('plan') exactly, step by step, in plan order — read every file before editing it and prefer edit_file/multi_edit over rewrites. After each plan step, run the test command from workflow_get('test_cmd') via run_shell; never advance past a failing step. Implement only what the plan and spec require — no opportunistic refactors and no new dependencies without a stated reason. A verification critic re-runs this card's verify command (default 'npm test' — edit the card to match this project) after every iteration and scores your work against the plan. When all steps are green, call workflow_set('impl_status', 'green') and finish with a one-paragraph change summary, not a transcript.",
          tools: [
            ...REPO_READ_TOOLS,
            ...REPO_EDIT_TOOLS,
            "format_code",
            ...PAD_TOOLS,
          ],
          nodeType: "critic",
          nodeConfig: {
            maxIters: 4,
            passThreshold: 90,
            verifyCmd: "npm test",
            criticSystemPrompt:
              "You are an exacting software verification critic. You did not write this code and owe it no loyalty: judge only what the diff and the verification output prove, never the implementer's narrative.",
            criticPrompt:
              "You are the verification critic for the implementation. Score 0-100 on adherence to workflow_get('plan') and workflow_get('acceptance'): every plan step done, every criterion met, no out-of-scope edits. List each unmet criterion or skipped step as a specific, actionable flaw. Begin your reply with exactly 'SCORE: <number>'.",
            maxMs: 2_700_000,
          },
        }),
        card("fc4", 960, {
          name: "Reviewer",
          preset: "skeptic",
          prompt:
            "You are the adversarial Reviewer. Ignore the implementer's narrative; read the actual diff via git_diff and verify each criterion in workflow_get('acceptance') against the code itself. Hunt specifically for: criteria silently unmet, edge cases (empty/null/concurrent/unicode inputs), call sites the change broke (check with find_references), and missing or weakened tests. Write workflow_set('review_verdict', 'approve') or workflow_set('review_verdict', 'block'), plus workflow_set('review_issues', ['<file:line — issue — why it matters>']). A 'block' verdict halts the flow right here, before anything is committed — so block only on real defects, and be concrete or be silent: every issue must name a file and a line. You never edit code yourself.",
          tools: [...REPO_READ_TOOLS, ...PAD_TOOLS],
          nodeConfig: {
            maxMs: 900_000,
            // Gate: a blocking verdict stops the chain — the Closer never
            // commits over the Reviewer's objection.
            haltWhen: { key: "review_verdict", equals: "block" },
          },
        }),
        card("fc5", 1280, {
          name: "Closer",
          preset: "coder",
          prompt:
            "You are the Closer; you only run when the Reviewer approved (a block verdict halts the flow upstream). Trust no upstream claim: re-run workflow_get('test_cmd') via run_shell and confirm green yourself. Fix any minor issues listed in workflow_get('review_issues') with minimal edits, re-running tests after each. Deliver a conventional-format git_commit of the work plus a final chat report: what shipped, each acceptance criterion marked met/not-met, test results, and any deferred items. Never commit with failing tests; if you cannot reach green within three fix attempts, report exactly what still fails and stop without committing.",
          tools: [
            "read_file",
            "edit_file",
            "multi_edit",
            "write_file",
            "run_shell",
            "git_status",
            "git_diff",
            "git_commit",
            "workflow_get",
            "workflow_keys",
          ],
          nodeConfig: { maxMs: 1_200_000 },
        }),
      ],
      edges: chain(["fc1", "fc2", "fc3", "fc4", "fc5"]),
    },
  },
  {
    id: "bug-hunter",
    name: "Bug Hunter",
    category: "Code",
    summary:
      "Reproduce → 3 analysts vote on the fault → test-gated fix → independent verify + commit. All local; halts early if the bug won't reproduce.",
    graph: {
      cards: [
        card("bh1", 0, {
          name: "Reproducer",
          preset: "coder",
          prompt:
            "You are the Reproducer. Turn the bug report into a minimal, deterministic reproduction: a failing test in the project's own test framework when possible, otherwise a small standalone script. Run it via run_shell and confirm it fails for the REPORTED reason — a repro that passes, or fails differently, is worthless; iterate until the failure matches the report. Persist workflow_set('repro_cmd', '<exact command>'), workflow_set('repro_output', '<last 30 lines of failing output>'), workflow_set('test_cmd', '<full suite command>'), and workflow_set('repro_status', 'ok'). Touch only test or scratch files — never modify source code at this stage. If you genuinely cannot reproduce, call workflow_set('repro_status', 'failed') with a summary of what you tried — that halts the flow instead of sending downstream cards chasing a ghost; do not fake a failure.",
          tools: [
            "read_file",
            "list_dir",
            "search_files",
            "file_exists",
            "run_shell",
            "write_file",
            "edit_file",
            "git_status",
            "git_log",
            ...PAD_TOOLS,
          ],
          nodeConfig: {
            maxMs: 900_000,
            // Gate: no repro, no hunt — a clean halt beats a guessed fix.
            haltWhen: { key: "repro_status", equals: "failed" },
          },
        }),
        card("bh2", 320, {
          name: "Fault Localizer",
          preset: "coder",
          prompt:
            "You are a fault-localization analyst; sibling analysts are independently performing this same analysis and your conclusions will be voted on, so you must end in the exact agreed format. Start from workflow_get('repro_output'), trace the failure backwards through the code with read_file, find_definition, and find_references, and use git_log/git_show to check whether a recent change introduced it. Verify your hypothesis explains EVERY line of the failing output, not just the headline error. Your final line must be exactly: FAULT: <file>:<line-range> — <one-sentence root cause>. No hedging and no multiple candidates — commit to one location.",
          // Read-only by design: three parallel samples must not write the pad.
          tools: [
            "read_file",
            "list_dir",
            "search_files",
            "file_exists",
            "git_log",
            "git_show",
            "git_diff",
            "find_definition",
            "find_references",
            "workflow_get",
            "workflow_keys",
          ],
          nodeType: "consistency",
          nodeConfig: { members: 3, voteMode: "vote", maxMs: 900_000 },
        }),
        card("bh3", 640, {
          name: "Fixer",
          preset: "coder",
          prompt:
            "You are the Fixer. Take the voted FAULT location from the handoff and workflow_get('repro_output'); read the faulty code and its callers via find_references before changing anything. Fix the ROOT CAUSE with the smallest correct change — do not paper over the symptom in the repro path, and do not refactor surrounding code while you are here. After every edit, run workflow_get('repro_cmd') (it must now pass) and then workflow_get('test_cmd') (nothing may regress); a cross-checking critic also re-runs this card's verify command (default 'npm test' — edit the card to match this project) and scores your fix. Keep the repro test in place as a permanent regression test. Finish with workflow_set('fix_summary', '<root cause, files changed, repro + suite status>').",
          tools: [...REPO_READ_TOOLS, ...REPO_EDIT_TOOLS, ...PAD_TOOLS],
          nodeType: "critic",
          nodeConfig: {
            maxIters: 5,
            passThreshold: 95,
            verifyCmd: "npm test",
            criticSystemPrompt:
              "You are a skeptical debugging critic, deliberately judging from outside the fixer's perspective. Judge only the diff and the verification output; a fix that silences the repro without explaining the root cause scores low.",
            criticPrompt:
              "You are the verification critic for the bug fix. Score 0-100 on root-cause quality: does the diff fix the cause or merely mask the symptom, is the change minimal, and is the repro kept as a regression test? List concrete flaws with file references. Begin your reply with exactly 'SCORE: <number>'.",
            maxMs: 2_700_000,
          },
        }),
        card("bh4", 960, {
          name: "Verifier-Reporter",
          preset: "coder",
          prompt:
            "You are the Verifier-Reporter; treat every upstream claim as unverified. Independently re-run workflow_get('repro_cmd') and workflow_get('test_cmd') via run_shell and read the final diff with git_diff. Then write BUGFIX.md: the symptom, the root cause at file:line (cross-check workflow_get('fix_summary') against the actual diff), the fix, the regression test now guarding it, and your verification output. Commit with a message of the form 'fix: <symptom> (root cause: <cause>)'. If your independent re-run disagrees with upstream claims, do NOT commit — make the discrepancy the headline of your report instead.",
          tools: [
            "read_file",
            "run_shell",
            "git_diff",
            "git_status",
            "git_commit",
            "write_file",
            "workflow_get",
            "workflow_keys",
          ],
          nodeConfig: { maxMs: 900_000 },
        }),
      ],
      edges: chain(["bh1", "bh2", "bh3", "bh4"]),
    },
  },
];

/** Deep-clone a template's graph for insertion into a new workflow. */
export function cloneTemplateGraph(t: FlowTemplate): WorkflowGraph {
  return JSON.parse(JSON.stringify(t.graph)) as WorkflowGraph;
}
