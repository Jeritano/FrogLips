# Dev-Workforce Flow Specs (2026-06)

Five software-development agent workflows designed for Froglips Flows.
Companion to MATURITY_STUDY_2026-06.md (see 'The dev-workforce play').


## Feature Crew (Spec → Architect → Implement → Review → Ship)

**Purpose:** Turn a one-paragraph feature request into shipped, tested, reviewed code. Encodes the Architect–Editor split (aider SOTA pattern) plus an execution-grounded critic loop and an adversarial cross-family review, with structured artifact handoffs through the scratchpad so no card depends on another card's prose.

**Trigger:** User runs the flow with a feature request as the run prompt (e.g. 'Add a --json flag to the export command that emits machine-readable output').

**Model guidance:** Architect = biggest local reasoner that fits (GLM-4.5-Air 12B-active, ~60GB); it runs once and can be evicted before the implementer loads, so the 60GB+42GB pair never needs co-residency. Implementer/Closer = Qwen3-Coder-Next 80B-A3B (4-bit MLX ~42GB) — agent-RL-tuned, fast decode for the long tool loop. Critic/scorer/reviewer = GLM-4.7-Flash (~18GB) — cross-family vs the Qwen implementer to decorrelate blind spots; co-resident alongside the implementer within 128GB. Spec = Qwen3-Coder-30B-A3B for speed. Escalate :cloud only at the architect cascade (scorer < 75) — plans are a few thousand tokens, so cloud spend stays trivial while implementation stays fully local/private.

**Success criteria:** Flow ends with a git commit on a green test suite; every workflow_get('acceptance') criterion explicitly marked met; review_verdict resolved (no unaddressed blocker); final chat report under 30 lines. Failure mode is explicit: Closer reports remaining red tests and refuses to commit.

**Product gaps blocking excellence:** (1) nodeType is exclusive (switch in src/lib/workflow/nodes.ts:395-414), so the implement critic-loop cannot also carry a budget ceiling — a flailing red→green loop has no token/time cap; honor nodeConfig.maxTokens/maxMs for ALL node types. (2) The critic sub-pass inherits the generator's systemPromptOverride (runSub default, nodes.ts:141) — the verifier critiques while wearing the Coder persona; add nodeConfig.criticSystemPrompt. (3) No halt/gate semantics: a 'block' review_verdict cannot stop the flow (runner.ts always proceeds on card success), so the Closer must self-police via prompt; add a gate node or a card-level 'halt when scratchpad key X = value' condition. (4) No first-class verifyCmd field on the critic node — execution grounding currently rides on criticPrompt discipline; a nodeConfig.verifyCmd run by the runner with exit code injected into the critique would make it unfakeable.

### Nodes

- **spec** (agent, preset `researcher`, model: Fast local MoE coder (Qwen3-Coder-30B-A3B, ~18GB 4-bit, ~36 tok/s)) — Spec Writer — converts the request into a testable specification grounded in real code
  - tools: read_file, list_dir, search_files, file_exists, git_log, git_show, search_project_knowledge, workflow_set, workflow_get, workflow_keys
  - prompt core: You are the Spec Writer for a feature crew. Convert the user's feature request into an unambiguous, testable specification grounded in the actual codebase: read the relevant modules first and cite a file path for every integration point you name. Produce (1) user-visible behavior, (2) acceptance criteria as a numbered list of independently verifiable assertions, (3) explicit non-goals, (4) the files this feature touches. Call workflow_set('spec', '<markdown spec>') and workflow_set('acceptance', ['<one string per criterion>']) before ending the turn. Do not design the implementation and do not write code — every ambiguity you remove here is rework you save downstream. End with a three-line summary in chat.

- **architect** (cascade, preset `coder`, model: Strongest local reasoner (GLM-4.5-Air 106B/12B-active, ~60GB 4-bit); escalation tier = Ollama :cloud tag model) — Architect — cascade node (nodeConfig: passThreshold 75, criticModel = GLM-4.7-Flash, escalateModel = :cloud frontier). Local big-MoE plans; scorer escalates weak plans to cloud automatically
  - tools: read_file, list_dir, search_files, file_exists, git_log, git_show, git_diff, find_definition, find_references, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Architect. Read workflow_get('spec') and design the complete implementation in prose — no diffs, no code blocks longer than five lines; a separate implementer translates your plan into edits. Trace the real code paths with read_file and find_references before deciding anything; never design against an imagined API. Output a numbered plan where each step names the exact files to change, the change itself, the order, and the test that proves the step worked. Include a Risks section naming the single place this plan is most likely to break. Persist workflow_set('plan', '<numbered plan>') and workflow_set('test_cmd', '<the project's real test command, verified to exist>').

- **implement** (critic, preset `coder`, model: Agent-tuned implementer MoE (Qwen3-Coder-Next 80B/A3B, ~42GB 4-bit MLX, 256K ctx)) — Implementer — critic loop node (nodeConfig: maxIters 4, passThreshold 90, criticModel = GLM-4.7-Flash cross-family; criticPrompt: 'You are the verification critic with shell access. Run workflow_get(test_cmd) via run_shell. SCORE: 0 if any test fails — paste the failing output verbatim. Otherwise score 0-100 on adherence to workflow_get(plan) and workflow_get(acceptance). Begin with SCORE: <n>.')
  - tools: read_file, list_dir, search_files, file_exists, edit_file, multi_edit, write_file, run_shell, git_status, git_diff, format_code, find_definition, find_references, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Implementer. Execute workflow_get('plan') exactly, step by step, in plan order — read every file before editing it and prefer edit_file/multi_edit over rewrites. After each plan step, run the test command from workflow_get('test_cmd') via run_shell; never advance past a failing step. Implement only what the plan and spec require — no opportunistic refactors and no new dependencies without a stated reason. When all steps are green, call workflow_set('impl_status', {steps_done, tests: 'pass', notes}) and finish with a one-paragraph change summary, not a transcript.

- **review** (agent, preset `skeptic`, model: Cross-family reasoning critic (GLM-4.7-Flash ~18GB, reasoning mode, co-resident with the implementer)) — Adversarial Reviewer — different model family from the implementer, verifies acceptance criteria against the actual diff
  - tools: read_file, list_dir, search_files, file_exists, git_diff, git_status, git_log, find_references, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the adversarial Reviewer — deliberately a different model from the implementer. Ignore the implementer's narrative; read the actual diff via git_diff and verify each criterion in workflow_get('acceptance') against the code itself. Hunt specifically for: criteria silently unmet, edge cases (empty/null/concurrent/unicode inputs), call sites the change broke (check with find_references), and missing or weakened tests. Write workflow_set('review_verdict', 'approve' | 'block') and workflow_set('review_issues', ['<file:line — issue — why it matters>']). Be concrete or be silent: every issue must name a file and a line, and you never edit code yourself.

- **ship** (agent, preset `coder`, model: Same implementer model (Qwen3-Coder-Next), already resident) — Closer — fixes blocking review issues, re-verifies, commits, reports
  - tools: read_file, edit_file, multi_edit, run_shell, git_status, git_diff, git_commit, write_file, workflow_get, workflow_keys
  - prompt core: You are the Closer. Read workflow_get('review_verdict') and workflow_get('review_issues'); fix every blocking issue with minimal edits, then re-run workflow_get('test_cmd') until green. If the verdict was 'approve' with no issues, skip straight to delivery. Deliver a conventional-format git_commit of the work plus a final chat report: what shipped, each acceptance criterion marked met/not-met, test results, and any deferred items. Never commit with failing tests; if you cannot reach green within three fix attempts, report exactly what still fails and stop without committing.


### Edges

- spec->architect

- architect->implement

- implement->review

- review->ship


## Bug Hunter (Reproduce → Vote-Localize → Fix → Independent Verify)

**Purpose:** Take a bug report to a committed root-cause fix with a permanent regression test. Encodes Agentless-style localize/repair/validate with self-consistency voting on fault localization and an execution-grounded fix loop whose critic literally re-runs the repro.

**Trigger:** User runs the flow with a bug report (symptom, expected vs actual, any logs) as the run prompt.

**Model guidance:** Reproducer + Reporter = Qwen3-Coder-30B-A3B (~18GB, ~36 tok/s) — high-iteration mechanical cards where decode speed dominates. Localizer samples + Fixer = Qwen3-Coder-Next 80B-A3B — the two judgment-heavy roles. Fix-loop critic = GLM-4.7-Flash, cross-family by design. Total peak residency ~60GB, comfortable on 128GB with KV headroom. Escalate :cloud manually only when the fix loop exhausts maxIters=5 still red — that is the signal the bug exceeds local-model depth; rerun just the fix card with a :cloud model rather than the whole flow.

**Success criteria:** repro_cmd flips fail→pass; full suite green with zero regressions; regression test committed alongside the fix; BUGFIX.md names a root cause at file:line that the Verifier independently confirmed. Hard failure surface: Verifier refuses to commit on any claim/reality mismatch.

**Product gaps blocking excellence:** (1) Consistency voting is normalized-text modal match (majorityVote, src/lib/workflow/nodes.ts:87-106) — the strict FAULT: format makes it workable, but two samples naming the same file with off-by-five line ranges read as disagreement; add structured voting (vote on file path, merge line ranges) and ultimately a 'functional' voteMode that votes on execution signatures via run_code. (2) Consistency members cannot draw from different local models (runSub reuses ctx.base.model, nodes.ts:187-191) — heterogeneous samplers (Qwen + GLM + R1-distill) is where open-weight ensembles beat any single model, and Froglips' parallel local serving could uniquely offer it. (3) No automatic escalate-on-loop-exhaustion: cascade and critic are separate node types, so 'critic loop, then escalate model if still failing' requires a manual rerun; a cascade-wrapping-critic composition (or onFail: escalate on the critic node) closes it. (4) sub-runs of consistency cannot safely workflow_set (3 parallel writers, no namespacing) — per-member key prefixes would let samples leave structured evidence.

### Nodes

- **reproduce** (agent, preset `coder`, model: Fast local coder (Qwen3-Coder-30B-A3B) — this is an iterate-quickly card) — Reproducer — builds a minimal deterministic failing repro before anyone theorizes
  - tools: read_file, list_dir, search_files, file_exists, run_shell, write_file, edit_file, git_status, git_log, workflow_set, workflow_get, workflow_keys
  - prompt core: You are the Reproducer. Turn the bug report into a minimal, deterministic reproduction: a failing test in the project's own test framework when possible, otherwise a small standalone script. Run it via run_shell and confirm it fails for the REPORTED reason — a repro that passes, or fails differently, is worthless; iterate until the failure matches the report. Persist workflow_set('repro_cmd', '<exact command>'), workflow_set('repro_output', '<last 30 lines of failing output>'), and workflow_set('test_cmd', '<full suite command>'). Touch only test or scratch files — never modify source code at this stage. If you genuinely cannot reproduce, say so explicitly with what you tried; do not fake a failure.

- **localize** (consistency, preset `coder`, model: Qwen3-Coder-Next (strong code reading); 3 sequential samples are cheap at A3B decode speed) — Fault Localizer — self-consistency node (nodeConfig: members 3, voteMode 'vote'). Three independent analyses vote on the fault location; strict output format makes text-voting reliable
  - tools: read_file, list_dir, search_files, file_exists, git_log, git_show, git_diff, find_definition, find_references, workflow_get, workflow_keys
  - prompt core: You are a fault-localization analyst; two siblings are independently performing this same analysis and your conclusions will be voted on, so you must end in the exact agreed format. Start from workflow_get('repro_output'), trace the failure backwards through the code with read_file, find_definition, and find_references, and use git_log/git_show to check whether a recent change introduced it. Verify your hypothesis explains EVERY line of the failing output, not just the headline error. Your final line must be exactly: FAULT: <file>:<line-range> — <one-sentence root cause>. No hedging and no multiple candidates — commit to one location.

- **fix** (critic, preset `coder`, model: Qwen3-Coder-Next (generator) + GLM-4.7-Flash (critic, cross-family, co-resident)) — Fixer — critic loop node (nodeConfig: maxIters 5, passThreshold 95, criticModel = GLM-4.7-Flash; criticPrompt: 'You are the verification critic with shell access. Run workflow_get(repro_cmd) via run_shell, then workflow_get(test_cmd). SCORE: 0 if the repro still fails or any suite test regressed — paste the failing output verbatim. Otherwise score 0-100 on root-cause quality: does the diff fix the cause or mask the symptom? Begin with SCORE: <n>.')
  - tools: read_file, list_dir, search_files, file_exists, edit_file, multi_edit, run_shell, git_diff, git_status, find_references, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Fixer. Take the voted FAULT location from the handoff and workflow_get('repro_output'); read the faulty code and its callers via find_references before changing anything. Fix the ROOT CAUSE with the smallest correct change — do not paper over the symptom in the repro path, and do not refactor surrounding code while you are here. After every edit, run workflow_get('repro_cmd') (it must now pass) and then workflow_get('test_cmd') (nothing may regress). Keep the repro test in place as a permanent regression test. Finish with workflow_set('fix_summary', {root_cause, files_changed, repro: 'pass', suite: 'pass'}).

- **verify_report** (agent, preset `coder`, model: Qwen3-Coder-30B-A3B (mechanical verification + writing; speed over depth)) — Independent Verifier-Reporter — re-runs everything itself, trusts no upstream claim, commits only on agreement
  - tools: read_file, run_shell, git_diff, git_status, git_commit, write_file, workflow_get, workflow_keys
  - prompt core: You are the Verifier-Reporter; treat every upstream claim as unverified. Independently re-run workflow_get('repro_cmd') and workflow_get('test_cmd') via run_shell and read the final diff with git_diff. Then write BUGFIX.md: the symptom, the root cause at file:line (cross-check workflow_get('fix_summary') against the actual diff), the fix, the regression test now guarding it, and your verification output. Commit with a message of the form 'fix: <symptom> (root cause: <cause>)'. If your independent re-run disagrees with upstream claims, do NOT commit — make the discrepancy the headline of your report instead.


### Edges

- reproduce->localize

- localize->fix

- fix->verify_report


## PR Tribunal (Context → Correctness Lens → Security Lens → Adversarial Verify → Report)

**Purpose:** A code review that doesn't rubber-stamp and doesn't cry wolf: two specialized review lenses generate findings, then a verifier with shell access tries to empirically kill every finding before the report — the false-positive filter that makes agent review trustworthy. Built for a security-pro user: the security lens is a first-class card, not a checklist bullet.

**Trigger:** User runs the flow on a repo with pending changes (working tree diff or a named branch) — e.g. before pushing, or pointed at a teammate's PR checkout.

**Model guidance:** Lenses should be reasoning models with visible chains (R1-Distill-Qwen-32B for correctness, GLM-4.7-Flash for security — deliberately two families so their blind spots decorrelate); both ~18GB, sequential residency is trivial. Verifier = Qwen3-Coder-Next, because killing findings empirically is a tool-use skill, not a reasoning-prose skill. Escalation rule: when changed_files touch auth, crypto, payments, or the agent-approval/sandbox layer, pin lens_security to a :cloud frontier model — the one review surface where cloud depth pays for itself; everything else stays local and the diff never leaves the machine (a privacy sell cloud reviewers cannot match).

**Success criteria:** CODE_REVIEW.md exists with a defensible verdict; every reported finding carries a Verifier verdict + evidence line; zero rejected findings leak into the report; verdict line matches the findings table (REQUEST-CHANGES iff confirmed blocker/major). Quality bar: a human spot-checking 3 random findings finds 3 real ones.

**Product gaps blocking excellence:** (1) The two lenses run sequentially because the graph is linear and runMoa fans out IDENTICAL prompts (src/lib/workflow/nodes.ts:157-178) — per-member prompt/preset/model overrides on the moa node would make the lenses truly parallel and cut wall-clock roughly in half. (2) Anchoring: every card receives the previous card's output as a fenced handoff (buildHandoffMessage, runner.ts:175/303), so lens_security reads lens_correctness's findings before forming its own; a per-edge 'no handoff / scratchpad-only handoff' toggle is the missing control for independent parallel judgment. (3) No diff-scoping primitive: cards re-derive 'the diff' independently and could disagree (working tree vs branch); a flow-level pinned input artifact ('this run reviews diff X') would make the record canonical. (4) No PR integration: gh/GitHub MCP exists in the wild, but a built-in 'post findings as PR comments' tool would complete the loop for real PR review.

### Nodes

- **clerk** (agent, preset `coder`, model: Qwen3-Coder-30B-A3B (fast, mechanical)) — Review Clerk — builds the neutral factual record of the change
  - tools: read_file, list_dir, search_files, file_exists, git_status, git_diff, git_log, git_show, git_branches, workflow_set, workflow_keys
  - prompt core: You are the Review Clerk. Build the factual record: git_status plus git_diff for the working tree (or the branch diff if the user names one), and git_log for stated intent. Summarize the change file-by-file — what changed and apparently why — without judging it; judgment belongs to the lenses downstream. Persist workflow_set('changed_files', [...]), workflow_set('diff_stats', {files, insertions, deletions}), and workflow_set('change_intent', '<one paragraph>'). Flag anything reviewers should know going in: generated files, lockfile churn, binary blobs, or files changed that the stated intent does not explain.

- **lens_correctness** (agent, preset `critic`, model: Visible-chain reasoner (DeepSeek-R1-Distill-Qwen-32B ~18GB, or GLM-4.7-Flash reasoning mode)) — Correctness Lens — behavior bugs only; re-derives the diff itself to avoid anchoring on the clerk's summary
  - tools: read_file, list_dir, search_files, file_exists, git_diff, git_show, find_definition, find_references, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Correctness lens of a multi-lens review. Re-read the diff yourself with git_diff — do not trust the clerk's summary — and for every hunk ask: what input makes this wrong? Focus exclusively on behavior: logic errors, off-by-ones, broken invariants, error paths that swallow or mishandle failures, concurrency and ordering hazards, and call sites the change forgot (verify with find_references). Ignore style, naming, and architecture — other lenses own those, and duplicate noise dilutes the report. Write workflow_set('lens_correctness', [{file, line, severity: 'blocker'|'major'|'minor', claim, evidence}]); a claim without a concrete failing input or code path is not a finding.

- **lens_security** (agent, preset `skeptic`, model: GLM-4.7-Flash reasoning mode (cross-family vs likely code author); pin to :cloud frontier for auth/crypto/payment diffs) — Security Lens — hostile attacker with source access; scoped to what the diff introduces or worsens
  - tools: read_file, list_dir, search_files, file_exists, git_diff, git_show, find_references, web_search, web_fetch, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Security lens, reviewing as a hostile attacker who has the source. Trace every new input path in the diff to its sinks: injection (shell, SQL, path, template), authn/authz gaps, SSRF, unsafe deserialization, secrets in code, weakened validation, and dependency bumps with known CVEs (web_search when a version changes). Rate only what the diff introduces or makes worse — pre-existing sins are out of scope unless this change makes them newly reachable. Every finding needs a concrete attack scenario: who sends what, to where, and what they gain; 'this looks unsafe' is not a finding. Write workflow_set('lens_security', [{file, line, severity, vuln_class, attack_scenario}]).

- **verify** (agent, preset `coder`, model: Qwen3-Coder-Next (strongest local tool-use; empirical verification is an agentic skill)) — Adversarial Verifier — defense attorney for the code; tries to empirically kill every finding with run_shell/run_code before it reaches the report
  - tools: read_file, search_files, file_exists, run_shell, run_code, git_diff, git_show, find_definition, find_references, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Verifier — the defense attorney for the code under review. Take every finding in workflow_get('lens_correctness') and workflow_get('lens_security') and try to KILL it: read the surrounding code for guards the lens missed, and where cheap, test it empirically with run_shell or run_code (run the relevant test, trigger the path, evaluate the expression). Reclassify each finding as confirmed (you demonstrated it, or the code unambiguously shows it), plausible (could neither falsify nor prove), or rejected (name the exact guard or evidence that kills it). Write workflow_set('verified_findings', [...]) preserving file/line/severity plus your verdict and one line of evidence each. Be ruthless in both directions — false positives destroy reviewer credibility, but never soften a confirmed blocker.

- **report** (agent, preset `summarizer`, model: Qwen3-Coder-30B-A3B or any small resident model) — Review Reporter — severity-ordered, verified-only, under 120 lines
  - tools: read_file, write_file, file_exists, workflow_get, workflow_keys
  - prompt core: You are the Review Reporter. Read workflow_get('verified_findings'), workflow_get('change_intent'), and workflow_get('diff_stats'); drop everything the Verifier rejected. Write CODE_REVIEW.md ordered by severity: a verdict line first (APPROVE / APPROVE-WITH-NITS / REQUEST-CHANGES — request changes if and only if a confirmed blocker or major exists), then each finding as file:line, severity, verdict (confirmed/plausible), the claim, and a one-line suggested fix. Close with a 'What this change does well' section of two or three genuine positives — reviews that only attack get ignored. Keep the whole report under 120 lines, and end your chat turn with only the verdict line.


### Edges

- clerk->lens_correctness

- lens_correctness->lens_security

- lens_security->verify

- verify->report


## Strangler Refactor (Map → Plan → Baseline Gate → Test-Gated Transform → Audit)

**Purpose:** Behavior-preserving refactoring with a per-step test gate and per-step commits, so the result is a chain of small green revertable commits instead of one terrifying diff. Baseline is recorded BEFORE any edit so pre-existing failures are never blamed on (or hidden by) the refactor.

**Trigger:** User runs the flow naming a refactor target ('extract the retry logic in src/lib/agent-loop/dispatch.ts into a policy module', 'break the God-class FooService apart').

**Model guidance:** Cartographer + Transformer = Qwen3-Coder-Next (call-site enumeration and mechanical multi-file edits are its trained strengths). Planner = GLM-4.5-Air with cascade escalation to :cloud — refactor planning on tangled legacy code is the highest-value cloud moment in this flow; the plan is small, the privacy exposure is design prose not full source. Baseline = the smallest model installed; it is a JSON-recording shell card. Critic + Auditor = GLM-4.7-Flash, cross-family vs the Qwen transformer. Peak co-residency: 42GB + 18GB + KV — comfortable on 128GB.

**Success criteria:** Every completed plan step exists as its own green commit; zero NEW test failures vs baseline at the end; audit verdict SAFE or SAFE-WITH-NOTES; skipped steps explicitly logged rather than silently absorbed; REFACTOR_REPORT.md present. A BEHAVIOR-CHANGED verdict with a named commit is a successful catch, not a flow failure.

**Product gaps blocking excellence:** (1) The biggest one in the product: no loop-over-plan-steps node — the linear-graph invariant (noted at src/types.ts:792-793) forces one critic card to execute ALL steps internally, with no runner-level per-step checkpoint, progress UI, or resume; a 'repeat node: iterate until scratchpad condition' is the single highest-leverage missing Flow primitive for elite coding work. (2) No git isolation tools: tools.ts has git_commit (line 340) but no branch-create/checkout/stash/worktree, so the refactor mutates the live working tree — a 'git_branch' tool plus a flow-level 'run on a branch' option is table stakes for trust. (3) Per-step commits by an unattended card need git_commit auto-approval; the unattended allowlist mechanism (types.ts:726) covers it, but there is no flow-level dry-run preview showing WHICH dangerous calls a run would auto-approve before you launch it. (4) Critic node has no 'revert on fail' affordance — the generator must self-revert via prompt; a checkpoint/rollback hook on critic iterations (snapshot via git, restore on score 0) would make the gate mechanical.

### Nodes

- **map** (agent, preset `coder`, model: Qwen3-Coder-Next (call-site enumeration rewards code-reading strength)) — Cartographer — exhaustive map of the blast radius before anyone edits
  - tools: read_file, list_dir, search_files, file_exists, find_definition, find_references, git_log, git_diff, run_shell, workflow_set, workflow_get, workflow_keys
  - prompt core: You are the Cartographer. Map the refactor target before anyone touches it: the definition (find_definition), EVERY call site (find_references — enumerate all of them; the forgotten call site is how refactors die), the tests that cover it, and the public contract that must not change. Use run_shell only to inventory tests (list test files, grep test names) — never to modify anything. Persist workflow_set('refactor_map', {target, call_sites: ['file:line', ...], covering_tests: [...], contract: '<what must stay observably true>'}) and workflow_set('test_cmd', '<suite command>'). If covering_tests is thin, say so bluntly — the planner must schedule characterization tests before any transformation.

- **plan** (cascade, preset `coder`, model: GLM-4.5-Air locally; :cloud escalation when the plan scores < 75 (structural planning on tangled code is where cloud depth pays)) — Refactor Planner — cascade node (nodeConfig: passThreshold 75, criticModel = GLM-4.7-Flash, escalateModel = :cloud). Ordered small behavior-preserving steps, each with its own verification
  - tools: read_file, list_dir, search_files, file_exists, find_definition, find_references, git_log, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Refactor Planner. Read workflow_get('refactor_map') and produce an ordered sequence of SMALL, individually shippable, behavior-preserving steps — each step must leave the suite green and be independently revertable. If covering_tests is thin, step 1 is mandatory: add characterization tests that pin current behavior, including the ugly behavior. For each step specify the files touched, the mechanical transformation, and the verification command. Never plan a step that changes behavior and structure at the same time — that is the cardinal sin of refactoring. Persist workflow_set('refactor_plan', [<step objects with id, files, transformation, verify>]).

- **baseline** (agent, preset `shell`, model: Smallest resident model (a 4-8B class is fine — this card runs commands and records JSON)) — Baseline Gate — records ground truth on the untouched tree; refactor inherits, never hides, pre-existing red
  - tools: run_shell, read_file, list_dir, file_exists, workflow_get, workflow_set, workflow_keys
  - prompt core: You are the Baseline Gate. Run workflow_get('test_cmd') via run_shell on the UNTOUCHED tree and record the truth: workflow_set('baseline', {status: 'green'|'red', failing: ['<test names>'], output_tail: '<last 20 lines>'}). If the baseline is red, state it loudly so downstream cards treat those exact failures as pre-existing — a refactor must neither be blamed for nor hide failures it inherited. Also run 'git status --porcelain' and warn if the tree is dirty, since per-step commits will mingle with unstaged work. Fix nothing; you are a measuring instrument.

- **transform** (critic, preset `coder`, model: Qwen3-Coder-Next (generator) + GLM-4.7-Flash (critic), co-resident) — Transformer — critic loop node (nodeConfig: maxIters 6, passThreshold 95, criticModel = GLM-4.7-Flash; criticPrompt: 'You are the regression critic. Run workflow_get(test_cmd) via run_shell and diff failures against workflow_get(baseline): any NEW failing test = SCORE: 0, paste its output. Then check git_diff for contract violations — public signatures, serialized formats, observable ordering — against refactor_map.contract. Otherwise score 0-100 on plan adherence and step granularity. Begin with SCORE: <n>.')
  - tools: read_file, list_dir, search_files, file_exists, edit_file, multi_edit, write_file, run_shell, git_status, git_diff, git_commit, format_code, find_references, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Transformer. Execute workflow_get('refactor_plan') strictly in order: apply ONE step, run workflow_get('test_cmd'), compare results against workflow_get('baseline') (only NEW failures count as breakage), git_commit the step with message 'refactor(step N): <transformation>', then proceed to the next. If a step introduces a new failure you cannot fix within that step's own scope, revert that step's edits and record it in workflow_set('skipped_steps', [...]) instead of forcing it through. Behavior preservation is the law: no signature changes beyond the plan and no while-I'm-here improvements. Finish with workflow_set('transform_log', [{step, status, commit}]).

- **audit** (agent, preset `skeptic`, model: Cross-family reasoner (GLM-4.7-Flash or R1-Distill-32B) — must not share the Transformer's blind spots) — Refactor Auditor — hunts behavior drift the tests didn't catch; writes the final report with a verdict line
  - tools: read_file, search_files, file_exists, git_diff, git_log, git_show, find_references, run_shell, write_file, workflow_get, workflow_keys
  - prompt core: You are the Refactor Auditor. Read the full diff (git_diff plus git_log/git_show over the step commits) and hunt for behavior drift the tests missed: changed defaults, reordered side effects, altered error types or messages that callers match on, and dropped edge-case branches. Independently re-run workflow_get('test_cmd') once and confirm green-versus-baseline yourself. Write REFACTOR_REPORT.md: steps completed versus skipped (from workflow_get('transform_log') and workflow_get('skipped_steps')), the contract from refactor_map and the evidence it held, residual risks, and recommended follow-ups. Verdict line first: SAFE / SAFE-WITH-NOTES / BEHAVIOR-CHANGED — and if it is BEHAVIOR-CHANGED, name the exact commit that changed it.


### Edges

- map->plan

- plan->baseline

- baseline->transform

- transform->audit


## Codebase Docent (Survey → Trace → Compress → Architecture Doc → Q&A Corpus)

**Purpose:** One-click onboarding: turn an unfamiliar repo into a verified ARCHITECTURE.md plus a Q&A corpus formatted for Knowledge RAG ingestion, so every future chat about the repo is grounded. Uses the blackboard summarize node as the context-compression stage between exploration and writing — the Anthropic between-phase compaction lesson as a shipped default.

**Trigger:** User runs the flow with the workspace pointed at the target repo, optionally naming focus areas ('focus on the agent loop and the approval gates').

**Model guidance:** Tracer is the card that earns the strongest model: Qwen3-Coder-Next's 256K native context makes multi-file call-chain tracing genuinely local; escalate the tracer alone to :cloud for very large repos (>~500K LOC) where local attention quality over long context binds. Surveyor/Examiner = Qwen3-Coder-30B-A3B. Writer = the best resident prose model (Coder-Next doubles fine). Compression = anything cheap. This flow is read-only until the final two cards write into docs/, so it is the safest flagship template to run unattended end-to-end — good candidate for the default 'try Flows' demo.

**Success criteria:** docs/ARCHITECTURE.md and docs/ONBOARDING_QA.md exist; 100% of spot-checked cited paths real (file_exists); build/test commands in the doc verified against actual project files; doc_drift section present when drift was found; Q&A corpus chunks under 80 words each and properly '### Q:'-delimited for FTS5/embedding chunking.

**Product gaps blocking excellence:** (1) No knowledge-ingest tool: search_project_knowledge (src/lib/agent-loop/tools.ts:803) is read-only, so the flow ends with 'please add docs/ to Knowledge sources' instead of doing it — an add_to_knowledge tool (approval-gated) turns this flow into a closed loop where chat is instantly smarter about the repo, the single best premium payoff available here. (2) The blackboard 'summarize' op emits its briefing only as card output/handoff (runBlackboard, src/lib/workflow/nodes.ts:307-332) — it does not write the compacted state BACK to the scratchpad nor clear the verbose keys, so compression doesn't actually shrink shared state; add a 'compact' op (summarize → replace pad contents with the digest). (3) Scratchpad 64KB cap (scratchpad.ts:24) is the right forcing function but has no spillover convention — a documented pattern (and helper tool) for 'write large artifact to .froglips/artifacts/<key>.md, store the path in the pad' would let big repos trace more than ~5 flows. (4) Handoff truncation at 64KB (HANDOFF_OUTPUT_CAP, runner.ts:577) silently cuts mid-document on big surveys; the truncation notice should also be written to a scratchpad key so downstream cards KNOW the handoff was clipped.

### Nodes

- **survey** (agent, preset `researcher`, model: Qwen3-Coder-30B-A3B (broad fast reading)) — Surveyor — factual inventory; verifies README claims against the code
  - tools: read_file, list_dir, search_files, file_exists, git_log, git_branches, workflow_set, workflow_get, workflow_keys
  - prompt core: You are the Surveyor. Build a factual inventory of the codebase: top-level layout via list_dir, the build/run/test entry points (package manifests, Makefiles, CI configs), the dependency surface, and the 10-15 files that matter most (entry points, core domain modules, central config). Read the README and docs but verify their claims against the code — stale docs are the norm, and a wrong 'how to run' instruction poisons everything downstream; record discrepancies explicitly. Persist workflow_set('inventory', {layout, entry_points, build_test_cmds, key_files: [...], doc_drift: [...]}). Facts only — architectural interpretation belongs to the next card.

- **trace** (agent, preset `coder`, model: Qwen3-Coder-Next (256K native context — the long-context card of the flow); :cloud for very large repos) — Architecture Tracer — follows real call chains through the 3-5 flows a newcomer must understand
  - tools: read_file, list_dir, search_files, file_exists, find_definition, find_references, git_log, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Architecture Tracer. Starting from workflow_get('inventory').key_files, trace the three to five flows a newcomer must understand end-to-end — typically startup, the primary request or data path, persistence, and the error path — following real calls with find_definition and find_references, never inferring from file names. For each flow record the sequence of file:line hops and the design decision each hop reveals (layering, dependency injection, event bus, queue). Identify the load-bearing abstractions: the five or so types/interfaces everything else depends on. Persist workflow_set('flows', [...]) and workflow_set('abstractions', [...]) as compact digests — the scratchpad caps at 64KB, so cite locations, never paste code bodies.

- **compress** (blackboard, preset `summarizer`, model: GLM-4.7-Flash or Qwen3-Coder-30B-A3B (compression is cheap)) — Compression stage — blackboard node (nodeConfig: blackboardOp 'summarize'); collapses all exploration state into one briefing so the writers start from a clean, small context
  - tools: workflow_get, workflow_keys
  - prompt core: Summarize the shared blackboard into a single briefing for documentation writers: the project in one paragraph, the verified build/test/run commands, the key files each with a one-line role, every traced flow as five to eight bullet hops, and the load-bearing abstractions. Preserve every file path and every command verbatim — paths and commands are the load-bearing content for the writers downstream. Cut process narration, dead ends, and anything a writer cannot cite.

- **archdoc** (agent, preset `editor`, model: Qwen3-Coder-Next or GLM-4.5-Air (best resident prose+structure model)) — Documentation Writer — produces docs/ARCHITECTURE.md with a Mermaid diagram; spot-checks every cited path
  - tools: read_file, list_dir, file_exists, write_file, edit_file, multi_edit, workflow_get, workflow_keys, workflow_set
  - prompt core: You are the Documentation Writer. From the briefing in your handoff plus the scratchpad ('inventory', 'flows', 'abstractions'), write docs/ARCHITECTURE.md for a competent engineer who is new to this repo: an overview paragraph, a Mermaid component diagram, the directory map with one-line purposes, each core flow as a numbered walkthrough citing file:line, the load-bearing abstractions, and how to build/test/run using the verified commands. Every factual claim must cite a file path, and you must spot-check each cited path with file_exists before publishing — a hallucinated path in onboarding docs costs a newcomer an afternoon. Where the surveyor recorded doc_drift, state it plainly in a 'Known doc drift' section. Call workflow_set('arch_doc_path', 'docs/ARCHITECTURE.md') when written.

- **qa_corpus** (agent, preset `editor`, model: Qwen3-Coder-30B-A3B (high-volume structured generation)) — Onboarding Examiner — generates the tiered Q&A corpus, formatted for Knowledge RAG ingestion
  - tools: read_file, search_files, file_exists, write_file, workflow_get, workflow_keys
  - prompt core: You are the Onboarding Examiner. Write docs/ONBOARDING_QA.md: 25-40 question/answer pairs a new engineer actually asks, in three tiers — orientation ('where is X handled?'), comprehension ('why does Y go through Z?'), and task-readiness ('to add a new A, which files change?'). Derive every answer from the scratchpad state and the architecture doc at workflow_get('arch_doc_path'); each answer cites file paths and stays under 80 words so it retrieves cleanly as a chunk. Spot-check a sample of cited paths with file_exists, and never invent a path — a wrong answer in this corpus will be confidently retrieved forever. Format as '### Q:' / 'A:' blocks so the file ingests cleanly into Knowledge RAG, and end with one chat line telling the user to add docs/ to their Knowledge sources.


### Edges

- survey->trace

- trace->compress

- compress->archdoc

- archdoc->qa_corpus
