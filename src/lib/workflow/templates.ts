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
 * verifyCmd ships as a safe auto-detecting one-liner (SAFE_VERIFY_CMD) that
 * runs npm/cargo test when present and no-ops cleanly otherwise — a missing
 * runner must not fail every critic iteration. Edit it per project in the card
 * editor (the prompts remind the model + user of this too).
 */

/** Cheap hosted escalation tier (Ollama Cloud, flat-rate). NOT a frontier API. */
const CLOUD_ESCALATION_MODEL = "glm-4.6:cloud";

/**
 * Safe-by-default verify command for the critic loops. Auto-detects the
 * project's test runner and — crucially — no-ops cleanly (exit 0) when none is
 * found, so a non-Node/non-Rust project does NOT fail every iteration and burn
 * the whole maxIters budget on a missing `npm`. The user still edits this to
 * their real test command (the card prompts say so); this just makes the
 * shipped default harmless instead of a guaranteed red. A genuine test failure
 * in a detected runner still surfaces — only a MISSING runner is the no-op.
 */
const SAFE_VERIFY_CMD =
  "[ -f package.json ] && npm test || { [ -f Cargo.toml ] && cargo test; } || " +
  'echo "no test runner detected — edit this card’s verify command to your project’s real test command"';

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

/* ── Security-workflow tool sets (defensive / authorized use only) ───────────
 * Scanning cards lean on run_shell — the scanner (semgrep / trufflehog /
 * npm|cargo|osv audit) is ground truth, exactly like verifyCmd in the
 * dev-workforce critics. Exposure cards lean on call_api so a breach-API key
 * lives in the Keychain and is injected server-side: the model never sees the
 * secret, can't exfiltrate it, and the request is confined to the registered
 * host. */
/** Read-only security code review — auditors must never mutate the target. */
const SEC_NAV_TOOLS = [
  "read_file",
  "list_dir",
  "search_files",
  "file_exists",
  "find_definition",
  "find_references",
  "git_log",
  "git_show",
  "git_diff",
  ...PAD_TOOLS,
];
/** Scanner runners: drive semgrep / trufflehog / npm|cargo|osv audit. */
const SEC_SHELL_TOOLS = [
  "run_shell",
  "read_file",
  "list_dir",
  "search_files",
  "file_exists",
  "find_references",
  ...PAD_TOOLS,
];
/** Exposure self-monitoring: call_api (Keychain-injected breach key) + web. */
const EXPOSURE_TOOLS = [
  "call_api",
  "http_request",
  "web_search",
  "web_fetch",
  "read_file",
  "ask_user",
  ...PAD_TOOLS,
];

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
            "You are the Spec Writer for a feature crew. Convert the user's feature request into an unambiguous, testable specification grounded in the actual codebase: read the relevant modules first and cite a file path for every integration point you name. Produce (1) user-visible behavior, (2) acceptance criteria as a numbered list of independently verifiable assertions, (3) explicit non-goals, (4) the files this feature touches. Call workflow_set('spec', '<markdown spec>') and workflow_set('acceptance', ['<one string per criterion>']) before ending the turn. Do not design the implementation and do not write code — every ambiguity you remove here is rework you save downstream. End with a three-line summary in chat. PATH DISCIPLINE: All files MUST be created with paths RELATIVE to the project workspace root (e.g. `src/app.ts`, `index.html`) — NEVER use `~`, `$HOME`, or an absolute path, and never write outside the project. ALWAYS create and modify files with the write_file / edit_file / multi_edit tools (which are confined to the workspace); NEVER write files by shell redirection (`cat > file`, `echo > file`, `tee`) — shell redirects bypass workspace confinement and can scatter files outside the project.",
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
            "You are the Architect. Read workflow_get('spec') and design the complete implementation in prose — no diffs, no code blocks longer than five lines; a separate implementer translates your plan into edits. Trace the real code paths with read_file and find_references before deciding anything; never design against an imagined API. Output a numbered plan where each step names the exact files to change, the change itself, the order, and the test that proves the step worked. Include a Risks section naming the single place this plan is most likely to break. Persist workflow_set('plan', '<numbered plan>') and workflow_set('test_cmd', '<the project's real test command, verified to exist>'). PATH DISCIPLINE: Every file path in your plan must be workspace-relative. All files MUST be created with paths RELATIVE to the project workspace root (e.g. `src/app.ts`, `index.html`) — NEVER use `~`, `$HOME`, or an absolute path, and never write outside the project. ALWAYS create and modify files with the write_file / edit_file / multi_edit tools (which are confined to the workspace); NEVER write files by shell redirection (`cat > file`, `echo > file`, `tee`) — shell redirects bypass workspace confinement and can scatter files outside the project.",
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
            "You are the Implementer. Execute workflow_get('plan') exactly, step by step, in plan order — read every file before editing it and prefer edit_file/multi_edit over rewrites. After each plan step, run the test command from workflow_get('test_cmd') via run_shell; never advance past a failing step. Implement only what the plan and spec require — no opportunistic refactors and no new dependencies without a stated reason. A verification critic re-runs this card's verify command (which auto-detects npm/cargo by default and no-ops if neither is present — edit the card to your project's real test command) after every iteration and scores your work against the plan. When all steps are green, call workflow_set('impl_status', 'green') and finish with a one-paragraph change summary, not a transcript. PATH DISCIPLINE: All files MUST be created with paths RELATIVE to the project workspace root (e.g. `src/app.ts`, `index.html`) — NEVER use `~`, `$HOME`, or an absolute path, and never write outside the project. ALWAYS create and modify files with the write_file / edit_file / multi_edit tools (which are confined to the workspace); NEVER write files by shell redirection (`cat > file`, `echo > file`, `tee`) — shell redirects bypass workspace confinement and can scatter files outside the project.",
          tools: [
            ...REPO_READ_TOOLS,
            ...REPO_EDIT_TOOLS,
            "format_code",
            ...PAD_TOOLS,
          ],
          // Vetted gallery template: the user explicitly installs + runs this
          // Flow, and an action card whose whole job is mutating/exec/network
          // (here edit_file/multi_edit/write_file/run_shell) is dead weight
          // unless its tools auto-approve — a non-unattended card hits the
          // runner's deny-all gate and does nothing. unattended:true opts these
          // in; truly irreversible tools (delete_path/kill_process/agent_undo)
          // stay hard-denied by the runner even when unattended, so this is safe.
          unattended: true,
          nodeType: "critic",
          nodeConfig: {
            maxIters: 4,
            passThreshold: 90,
            verifyCmd: SAFE_VERIFY_CMD,
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
          unattended: true,
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
          unattended: true,
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
          // voteMode "vote" (not "synth"): each analyst ends with the structured
          // `FAULT: <file>:<line> — …` line, which the consistency node's
          // voteKey/structuredKey extracts and tallies — so genuine agreement on
          // a location wins cheaply, no extra synthesis LLM call. (Free-text-only
          // consistency cards would instead use "synth"; this one is structured.)
          // maxMs matches the sibling 3-member consistency card (vuln-hunter vh4):
          // same nodeType + member count → same ceiling.
          nodeConfig: { members: 3, voteMode: "vote", maxMs: 1_200_000 },
        }),
        card("bh3", 640, {
          name: "Fixer",
          preset: "coder",
          prompt:
            "You are the Fixer. Take the voted FAULT location from the handoff and workflow_get('repro_output'); read the faulty code and its callers via find_references before changing anything. Fix the ROOT CAUSE with the smallest correct change — do not paper over the symptom in the repro path, and do not refactor surrounding code while you are here. After every edit, run workflow_get('repro_cmd') (it must now pass) and then workflow_get('test_cmd') (nothing may regress); a cross-checking critic also re-runs this card's verify command (which auto-detects npm/cargo by default and no-ops if neither is present — edit the card to your project's real test command) and scores your fix. Keep the repro test in place as a permanent regression test. Finish with workflow_set('fix_summary', '<root cause, files changed, repro + suite status>'). PATH DISCIPLINE: All files MUST be created with paths RELATIVE to the project workspace root (e.g. `src/app.ts`, `index.html`) — NEVER use `~`, `$HOME`, or an absolute path, and never write outside the project. ALWAYS create and modify files with the write_file / edit_file / multi_edit tools (which are confined to the workspace); NEVER write files by shell redirection (`cat > file`, `echo > file`, `tee`) — shell redirects bypass workspace confinement and can scatter files outside the project.",
          tools: [...REPO_READ_TOOLS, ...REPO_EDIT_TOOLS, ...PAD_TOOLS],
          unattended: true,
          nodeType: "critic",
          nodeConfig: {
            maxIters: 5,
            passThreshold: 95,
            verifyCmd: SAFE_VERIFY_CMD,
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
            "You are the Verifier-Reporter; treat every upstream claim as unverified. Independently re-run workflow_get('repro_cmd') and workflow_get('test_cmd') via run_shell and read the final diff with git_diff. Then write BUGFIX.md: the symptom, the root cause at file:line (cross-check workflow_get('fix_summary') against the actual diff), the fix, the regression test now guarding it, and your verification output. Commit with a message of the form 'fix: <symptom> (root cause: <cause>)'. If your independent re-run disagrees with upstream claims, do NOT commit — make the discrepancy the headline of your report instead. PATH DISCIPLINE: All files MUST be created with paths RELATIVE to the project workspace root (e.g. `BUGFIX.md`, `src/app.ts`) — NEVER use `~`, `$HOME`, or an absolute path, and never write outside the project. ALWAYS create and modify files with the write_file / edit_file / multi_edit tools (which are confined to the workspace); NEVER write files by shell redirection (`cat > file`, `echo > file`, `tee`) — shell redirects bypass workspace confinement and can scatter files outside the project.",
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
          unattended: true,
          nodeConfig: { maxMs: 900_000 },
        }),
      ],
      edges: chain(["bh1", "bh2", "bh3", "bh4"]),
    },
  },

  /* ── Security templates (defensive / authorized only) ──────────────────────
   *
   * Built from the 2026-06 security-workflow research: high-recall scan →
   * LLM verifier filter (GPTLens propose-then-refute), self-consistency vote
   * on contested findings, execution-grounded critics whose verifyCmd RUNS
   * the real scanner, and a flat-rate :cloud cascade only for the hardest
   * inter-procedural reasoning. Every template that touches a live target or
   * personal data opens with an AUTHORIZATION gate (haltWhen authorized=no)
   * so the flow refuses to run against assets the user hasn't asserted they
   * own or are cleared to test. Scanners (semgrep, trufflehog, gitleaks,
   * osv-scanner) must be on PATH — the cards say so and degrade gracefully.
   */
  {
    id: "security-auditor",
    name: "Security Auditor",
    category: "Security",
    summary:
      "High-recall multi-lens SAST of YOUR OWN code → an adversarial verifier refutes false positives → severity-ranked report. Read-only; all local.",
    graph: {
      cards: [
        card("sec1", 0, {
          name: "Scope & Surface",
          preset: "researcher",
          prompt:
            "You are the Scope Mapper for a defensive security audit of the user's OWN codebase. Identify what to audit: enumerate entrypoints (HTTP handlers, IPC/command boundaries, CLI args, deserializers, file/SQL/shell sinks) and the untrusted inputs that reach them, citing real file paths via search_files and read_file. Produce a trust-boundary sketch — where data crosses from untrusted to trusted. Call workflow_set('audit_scope', '<markdown: entrypoints, sinks, trust boundaries, each with file:line>'). Do NOT analyze vulnerabilities yet and never edit code — this card only frames the hunt so the downstream lenses don't waste passes rediscovering the surface.",
          tools: SEC_NAV_TOOLS,
          nodeConfig: { maxMs: 900_000 },
        }),
        card("sec2", 320, {
          name: "Vulnerability Auditor",
          preset: "coder",
          prompt:
            "You are a high-recall security auditor. Using workflow_get('audit_scope'), hunt EVERY plausible vulnerability across all lenses: injection (SQL/command/path/template), SSRF + unvalidated outbound requests, broken authn/authz + missing access checks, secrets in code/logs, unsafe deserialization, weak crypto/randomness, and unvalidated input reaching a dangerous sink. Bias toward recall — a downstream verifier will refute the weak ones, so report anything that could be real, but each finding MUST cite the exact data path: source → transformation → sink, with file:line for each hop. Call workflow_set('candidate_findings', ['<id | severity-guess | file:line sink | the source→sink path | why exploitable>']). You are read-only — never edit code.",
          tools: SEC_NAV_TOOLS,
          nodeConfig: { maxMs: 1_200_000 },
        }),
        card("sec3", 640, {
          name: "Adversarial Verifier",
          preset: "skeptic",
          prompt:
            "You are an adversarial vulnerability verifier — your default stance is that each candidate is a FALSE POSITIVE until the code proves otherwise. For every item in workflow_get('candidate_findings'), trace the real path with read_file + find_references and try to REFUTE it: is the input actually attacker-controlled, is there sanitization/parameterization in between, is the sink really reachable, is the dangerous arg actually tainted? If a semgrep ruleset is available the critic re-runs it (see this card's verify command) to corroborate. Keep only findings you cannot refute. Call workflow_set('confirmed_findings', ['<file:line | vuln class | CWE | proven exploit path | confidence>']) and workflow_set('refuted', ['<id — why it's safe>']). Concede in writing when a finding is bogus — a confident false positive is worse than a miss.",
          tools: SEC_NAV_TOOLS,
          nodeType: "critic",
          nodeConfig: {
            maxIters: 3,
            passThreshold: 85,
            // Optional corroboration: if semgrep is installed it grounds the
            // refutation in a second engine; if absent the command no-ops and
            // the critic falls back to pure code reasoning. Edit per project.
            verifyCmd:
              "command -v semgrep >/dev/null && semgrep --config auto --quiet . || echo 'semgrep not installed — reasoning only'",
            criticSystemPrompt:
              "You are a security verification critic who has seen a thousand scanner false positives. You owe the auditor's findings no loyalty; a finding survives only with a concrete, reachable, attacker-controlled source→sink path. Reward refutations as much as confirmations.",
            criticPrompt:
              "Score 0-100 how rigorously each candidate was either confirmed with a real exploit path or refuted with a concrete safety reason. Penalize hand-waving, unreachable sinks accepted as real, and untainted inputs treated as attacker-controlled. Begin your reply with exactly 'SCORE: <number>'.",
            maxMs: 1_800_000,
          },
        }),
        card("sec4", 960, {
          name: "Report Writer",
          preset: "summarizer",
          prompt:
            "You are the Security Report Writer. Read workflow_get('confirmed_findings') and write SECURITY_AUDIT.md: an executive summary (counts by severity), then one section per confirmed finding with — title + CWE, severity (Critical/High/Medium/Low with a one-line CVSS-style rationale), the file:line and the proven source→sink path, concrete impact, and a specific remediation (the exact code change or control to add). Order by severity, then by exploitability. Add a short 'Refuted / out of scope' appendix from workflow_get('refuted') so the reader trusts the signal. End with a one-line confirmation in chat, not the file body.",
          tools: ["read_file", "write_file", "workflow_get", "workflow_keys"],
          unattended: true,
          nodeConfig: { maxMs: 600_000 },
        }),
      ],
      edges: chain(["sec1", "sec2", "sec3", "sec4"]),
    },
  },

  {
    id: "vuln-hunter",
    name: "Vuln Bug Hunter",
    category: "Security",
    summary:
      "AUTHORIZED targets only. Scope gate → attack-surface map → scanner-grounded vuln hunt → 3-way reproducibility vote → defensive exploit-path + fix writeup (hardest cases escalate to a flat-rate :cloud tier).",
    graph: {
      cards: [
        card("vh1", 0, {
          name: "Authorization Gate",
          preset: "general",
          prompt:
            "You are the Authorization Gate for an active vulnerability hunt. This flow may ONLY run against code or systems the user owns or is explicitly authorized to test (their own repo, a CTF target, a pentest engagement with a signed scope). State plainly what is about to be hunted and ask the user to confirm ownership/authorization and the scope boundaries. If the user confirms, call workflow_set('authorized', 'yes') and workflow_set('scope', '<the agreed targets + explicit out-of-bounds>'). If they do not, cannot, or the target is third-party with no authorization, call workflow_set('authorized', 'no') — that halts the flow. Never rationalize past a missing authorization; the gate is the whole point.",
          tools: ["ask_user", ...PAD_TOOLS],
          nodeConfig: {
            maxMs: 600_000,
            haltWhen: { key: "authorized", equals: "no" },
          },
        }),
        card("vh2", 320, {
          name: "Attack-Surface Map",
          preset: "coder",
          prompt:
            "You are the Attack-Surface Mapper, bounded strictly by workflow_get('scope'). Enumerate the reachable attack surface: untrusted entrypoints, the data each accepts, authentication/authorization checks (or their absence), trust boundaries, and the dangerous sinks downstream (exec, SQL, file, network, deserialize). For each, note the source→sink reachability you'll want to prove. Call workflow_set('surface', '<ranked list, most-exposed first, each with file:line and why it's reachable>'). Read-only — you map, you don't exploit.",
          tools: SEC_NAV_TOOLS,
          nodeConfig: { maxMs: 900_000 },
        }),
        card("vh3", 640, {
          name: "Vuln Hunter",
          preset: "coder",
          prompt:
            "You are the Vuln Hunter, working only within workflow_get('scope') and prioritizing workflow_get('surface'). Hunt exploitable defects with concrete, reachable source→sink paths — not theoretical smells. A scanner critic re-runs this card's verify command (semgrep by default — edit to match the project) after each pass and scores you against what's actually provable. For each candidate call workflow_set so downstream cards see it: workflow_set('vulns', ['<id | class+CWE | file:line | the tainted path | preconditions to trigger>']). Stay defensive: you are finding bugs to fix them, never weaponizing — no live exploitation against anything outside the local code.",
          tools: SEC_SHELL_TOOLS,
          unattended: true,
          nodeType: "critic",
          nodeConfig: {
            maxIters: 4,
            passThreshold: 88,
            verifyCmd:
              "command -v semgrep >/dev/null && semgrep --config auto --quiet . || echo 'semgrep not installed — reasoning only'",
            criticSystemPrompt:
              "You are a skeptical exploit-development critic. Judge only whether each claimed vulnerability has a real, reachable, attacker-controlled trigger path proven from the code and scanner output — not the hunter's confidence. Theoretical or unreachable findings score low.",
            criticPrompt:
              "Score 0-100 on how many findings have a concrete reachable exploit path versus speculative smells, and whether the scanner output was actually used. List each weak finding and what proof it lacks. Begin with exactly 'SCORE: <number>'.",
            maxMs: 2_400_000,
          },
        }),
        card("vh4", 960, {
          name: "Reproducibility Vote",
          preset: "skeptic",
          prompt:
            "You are a reproducibility analyst; sibling analysts judge the same candidates independently and your verdicts are voted, so end in the exact agreed format. For the candidates in workflow_get('vulns'), determine which ones genuinely trigger: trace the path once more, check guards and preconditions, and decide reproducible vs not. Your final line must be exactly: VERDICT: <id> | reproducible=<yes|no> | <one-sentence justification with file:line>. Commit to one verdict per candidate — no hedging.",
          tools: SEC_NAV_TOOLS,
          nodeType: "consistency",
          // voteMode "vote": each analyst ends with the structured
          // `VERDICT: <id> | reproducible=<yes|no> | …` line; voteKey/structuredKey
          // tallies on that tag value, so reproducibility agreement is decided by
          // a real vote rather than a fall-through synthesis pass.
          nodeConfig: { members: 3, voteMode: "vote", maxMs: 1_200_000 },
        }),
        card("vh5", 1280, {
          name: "Exploit-Path & Fix",
          preset: "coder",
          prompt:
            "You are the Defensive Writeup author. For each vulnerability the vote marked reproducible, write — in workflow_set('report', '<markdown>') and a VULN_REPORT.md file — the proof-of-severity exploit PATH (the precise sequence that reaches the sink, as evidence for prioritization, NOT a weaponized payload against a live third party), the CWE/severity, and the concrete fix (exact code change + the control that prevents the class). The single hardest inter-procedural case may exceed the local model; this card escalates such reasoning to a flat-rate hosted tier. Stay strictly defensive: the deliverable is a fix and a justification, never a working attack tool.",
          tools: [...SEC_NAV_TOOLS, "write_file"],
          unattended: true,
          nodeType: "cascade",
          nodeConfig: {
            passThreshold: 80,
            escalateModel: CLOUD_ESCALATION_MODEL,
            escalateBackend: "ollama",
            criticPrompt:
              "Score 0-100 whether the writeup proves severity with a reachable path AND gives a concrete, correct fix for the vulnerability class (not just the one instance). Reply 'SCORE: <number>' then one reason.",
            maxMs: 1_800_000,
          },
        }),
      ],
      edges: chain(["vh1", "vh2", "vh3", "vh4", "vh5"]),
    },
  },

  {
    id: "supply-chain-sentinel",
    name: "Supply-Chain Sentinel",
    category: "Security",
    summary:
      "Run real dependency + secret scanners (npm/cargo/osv audit, trufflehog --only-verified) → triage CVEs by whether the vulnerable code is actually reachable → prioritized remediation plan. All local.",
    graph: {
      cards: [
        card("scs1", 0, {
          name: "Scan Runner",
          preset: "shell",
          prompt:
            "You are the Supply-Chain Scan Runner. Detect the project's ecosystem and run whichever auditors are installed, capturing JSON where possible: `npm audit --json` (Node), `cargo audit --json` (Rust), `osv-scanner --format json -r .` (cross-ecosystem), and for leaked secrets `trufflehog filesystem . --only-verified --json` or `gitleaks detect --report-format json` if present. For each tool that isn't installed, note it and continue — never fail the card on a missing scanner. Persist the raw findings: workflow_set('cve_findings', '<dependency advisories: package, version, advisory id, severity>') and workflow_set('secret_findings', '<verified secrets: file:line, type — REDACT the secret value itself>'). Do not edit anything.",
          tools: SEC_SHELL_TOOLS,
          unattended: true,
          nodeConfig: { maxMs: 1_200_000 },
        }),
        card("scs2", 320, {
          name: "Reachability Triage",
          preset: "coder",
          prompt:
            "You are the Reachability Triage analyst. A CVE in an installed package matters far more when the vulnerable function is actually called. For each advisory in workflow_get('cve_findings'), use find_references and read_file to determine whether the project reaches the vulnerable API/path: mark each REACHABLE (with the call site file:line), UNREACHABLE (dependency present but vulnerable code never invoked), or UNKNOWN (transitive/dynamic — can't prove). Re-rank by reachability × advisory severity. For workflow_get('secret_findings'), confirm each is a live secret in current code (not a rotated/test value) and whether it's committed history vs working tree. Call workflow_set('triaged', '<re-ranked list with reachability + call sites>').",
          tools: SEC_NAV_TOOLS,
          nodeConfig: { maxMs: 1_200_000 },
        }),
        card("scs3", 640, {
          name: "Remediation Plan",
          preset: "summarizer",
          prompt:
            "You are the Remediation Planner. From workflow_get('triaged'), write DEPENDENCY_REMEDIATION.md: a prioritized action list where each item is — the package/secret, the risk and whether it's reachable, and the EXACT fix (safe version to bump to and whether it's a breaking major, the patch, or for secrets: rotate + purge-from-history steps). Group as: Fix now (reachable + high severity, or verified live secret), Schedule (unreachable-but-known / low severity), and Monitor (unknown/transitive). Add the precise commands (e.g. `npm install pkg@x.y.z`) where they're safe. End with one confirmation line in chat.",
          tools: ["read_file", "write_file", "workflow_get", "workflow_keys"],
          unattended: true,
          nodeConfig: { maxMs: 600_000 },
        }),
      ],
      edges: chain(["scs1", "scs2", "scs3"]),
    },
  },

  {
    id: "exposure-monitor",
    name: "Exposure Monitor",
    category: "Security",
    summary:
      "DEFENSIVE self-check of YOUR OWN exposure: breach lookups (HIBP via call_api, key stays in the Keychain) + k-anonymity password check + email-spoofability (SPF/DKIM/DMARC) → what to rotate, where to enable 2FA. Refuses assets you don't own.",
    graph: {
      cards: [
        card("exp1", 0, {
          name: "Ownership & Scope",
          preset: "general",
          prompt:
            "You are the Ownership Gate for a personal exposure self-check. This flow is ONLY for the user's OWN identity assets — their own email addresses, domains they control, and their own credentials. Ask the user to list the emails and domains to check and to confirm each is theirs (or their organization's). If confirmed, call workflow_set('authorized', 'yes'), workflow_set('emails', ['<own emails>']), and workflow_set('domains', ['<owned domains>']). If they list an asset they don't own, or decline, call workflow_set('authorized', 'no') to halt. Never check a third party's email or domain — exposure monitoring is a defensive self-audit, not surveillance of others.",
          tools: ["ask_user", ...PAD_TOOLS],
          nodeConfig: {
            maxMs: 600_000,
            haltWhen: { key: "authorized", equals: "no" },
          },
        }),
        card("exp2", 320, {
          name: "Breach Sweep",
          preset: "researcher",
          prompt:
            "You are the Breach Sweep analyst. For each address in workflow_get('emails'), query Have I Been Pwned via call_api using a registered API named 'HIBP' (register it in Settings → APIs with your hibp-api-key as the auth header 'hibp-api-key' and a template of just '{key}'; the key stays in the Keychain and is injected server-side — you never see it). Call the breach account and paste account endpoints (path like '/api/v3/breachedaccount/<email>?truncateResponse=false' and '/api/v3/pasteaccount/<email>'). Respect rate limits — space requests. If the 'HIBP' API isn't registered, say so clearly and write workflow_set('breaches', 'HIBP not configured — register it in Settings → APIs to enable breach lookups') instead of guessing. Otherwise call workflow_set('breaches', '<per email: breach names, dates, the data classes exposed (passwords? tokens?)>'). Report only — never attempt any login anywhere.",
          tools: EXPOSURE_TOOLS,
          unattended: true,
          nodeConfig: { maxMs: 1_200_000 },
        }),
        card("exp3", 640, {
          name: "Password k-Anonymity Check",
          preset: "shell",
          prompt:
            "You are the Pwned-Passwords checker, and you protect the user's secrets while checking them. ONLY if the user explicitly provides a password to test (ask first; never read one from a file or env): compute its SHA-1, then send ONLY the first 5 hex chars of the hash to the Pwned Passwords range API via run_shell (`curl -s https://api.pwnedpasswords.com/range/<first5>`) — this is k-anonymity, the full hash and the password NEVER leave the machine. Match the returned suffixes locally to get the breach count. Report how many times each tested password has appeared in breaches (0 = not seen). Call workflow_set('password_exposure', '<per password label: seen N times — rotate if N>0>'). Never log, store, or transmit the password or its full hash.",
          tools: ["run_shell", "ask_user", ...PAD_TOOLS],
          unattended: true,
          nodeConfig: { maxMs: 900_000 },
        }),
        card("exp4", 960, {
          name: "Email Spoofability",
          preset: "shell",
          prompt:
            "You are the Email-Spoofability auditor. For each domain in workflow_get('domains'), resolve its email-authentication posture via run_shell + dig: SPF (`dig +short TXT <domain>` → the v=spf1 record), DMARC (`dig +short TXT _dmarc.<domain>` → policy p=none|quarantine|reject), and note whether DKIM selectors are discoverable. Flag weaknesses: missing SPF, SPF with +all/no -all, missing DMARC, or DMARC p=none (monitors but doesn't block spoofing). Call workflow_set('email_auth', '<per domain: SPF/DKIM/DMARC status + each gap that lets someone spoof mail as this domain>'). Read-only DNS lookups against the user's own domains.",
          tools: ["run_shell", ...PAD_TOOLS],
          unattended: true,
          nodeConfig: { maxMs: 600_000 },
        }),
        card("exp5", 1280, {
          name: "Exposure Report",
          preset: "summarizer",
          prompt:
            "You are the Exposure Report writer. Consolidate workflow_get('breaches'), workflow_get('password_exposure'), and workflow_get('email_auth') into EXPOSURE_REPORT.md — a prioritized, plain-language action plan for the user: which exact credentials to ROTATE NOW (any breach exposing passwords/tokens, or any password seen in Pwned Passwords), where to ENABLE 2FA (accounts tied to breached emails), and which DMARC/SPF records to harden (with the exact record to publish, e.g. a DMARC p=reject). Lead with the highest-risk items. Be calm and concrete — this is a defensive checklist, not an alarm. End with one confirmation line in chat.",
          tools: ["read_file", "write_file", "workflow_get", "workflow_keys"],
          unattended: true,
          nodeConfig: { maxMs: 600_000 },
        }),
      ],
      edges: chain(["exp1", "exp2", "exp3", "exp4", "exp5"]),
    },
  },

  {
    id: "threat-model-crew",
    name: "Threat Model Crew",
    category: "Security",
    summary:
      "STRIDE threat model of your own system: map the architecture → 6 parallel STRIDE analysts → ranked attack trees → mitigations mapped to real code. Pure design analysis, no live target.",
    graph: {
      cards: [
        card("tm1", 0, {
          name: "System Mapper",
          preset: "researcher",
          prompt:
            "You are the System Mapper for a STRIDE threat model. Build the data-flow picture from whatever's available — read the code (read_file/search_files), any architecture docs or PDFs (read_pdf), and the indexed knowledge base (search_project_knowledge). Identify: external actors, processes/services, data stores, and the data flows between them, plus every trust boundary a flow crosses and the assets worth protecting (secrets, PII, integrity-critical state). Call workflow_set('architecture', '<actors, processes, stores, data flows, trust boundaries, assets — each grounded in a file or doc>'). Be concrete; a vague model produces vague threats.",
          tools: [
            "read_file",
            "list_dir",
            "search_files",
            "read_pdf",
            "search_project_knowledge",
            ...PAD_TOOLS,
          ],
          nodeConfig: { maxMs: 900_000 },
        }),
        card("tm2", 320, {
          name: "STRIDE Analysts",
          preset: "skeptic",
          prompt:
            "You are a STRIDE threat analyst examining workflow_get('architecture'); several analysts run in parallel and a synthesis pass merges you, so be thorough and specific rather than worrying about overlap. Walk EVERY trust boundary and data flow and enumerate threats in all six STRIDE categories: Spoofing (identity), Tampering (data/code integrity), Repudiation (unloggable actions), Information disclosure (confidentiality), Denial of service (availability), and Elevation of privilege. For each threat give: the STRIDE category, the boundary/flow it attacks, the asset at risk, and a rough likelihood×impact. Tie each to a concrete element of the architecture — no generic checklist items. Output a clear threat list; the synthesizer will dedupe and rank across all analysts.",
          tools: ["read_file", "search_files", "workflow_get", "workflow_keys"],
          nodeType: "moa",
          nodeConfig: { members: 6, maxMs: 1_500_000 },
        }),
        card("tm3", 640, {
          name: "Attack-Tree Ranker",
          preset: "coder",
          prompt:
            "You are the Attack-Tree Ranker. Take the synthesized STRIDE threats from the handoff and, for the most serious, build short attack trees: the attacker's goal at the root, the steps/branches to reach it, and the existing control (if any) on each branch. Rank the threats by realistic likelihood × impact given the actual controls you can see in the code. Call workflow_set('ranked_threats', '<top threats, each: STRIDE category, attack path, current control gaps, risk rating>'). Be honest about which threats are already mitigated by existing controls — those rank lower.",
          tools: SEC_NAV_TOOLS,
          nodeConfig: { maxMs: 1_200_000 },
        }),
        card("tm4", 960, {
          name: "Mitigation Mapper",
          preset: "coder",
          prompt:
            "You are the Mitigation Mapper. For each threat in workflow_get('ranked_threats'), specify the concrete defense mapped to the real code: the control to add or strengthen (input validation, authz check, output encoding, rate limit, audit log, crypto fix), WHERE it goes (file:line or module), and the residual risk after. Write THREAT_MODEL.md: the system overview, the ranked threats with their attack trees, and the mitigation plan as an actionable checklist ordered by risk. Distinguish 'must fix' from 'defense in depth'. End with one confirmation line in chat, not the document body.",
          tools: [...SEC_NAV_TOOLS, "write_file"],
          unattended: true,
          nodeConfig: { maxMs: 1_200_000 },
        }),
      ],
      edges: chain(["tm1", "tm2", "tm3", "tm4"]),
    },
  },
];

/** Deep-clone a template's graph for insertion into a new workflow. */
export function cloneTemplateGraph(t: FlowTemplate): WorkflowGraph {
  return JSON.parse(JSON.stringify(t.graph)) as WorkflowGraph;
}
