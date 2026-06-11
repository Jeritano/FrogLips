# Froglips Maturity Study (2026-06)

## Executive summary

Froglips is a deep product with shallow finish. The hard parts are genuinely done: a 46-tool agent loop with real security architecture (path denylists, dry-run default-deny, output fencing, audit trails), a workflow engine whose node set (cascade, critic, moa, consistency, router, budget) maps almost one-to-one onto the published SOTA patterns for agentic coding, and a multi-backend local serving story nobody else has. But the last 20% is missing almost everywhere it counts, and that last 20% is what users experience as the product. Three themes dominate. **First, trust through visibility:** agent runs — the flagship — are a black box (no inline tool chips, raw-JSON approval modals when a unified-diff function already exists in the codebase, no end-of-run manifest, single-item undo), which squanders the security work already done; for the target user, the audit story *is* the product. **Second, consistency is the premium gap:** there are three coexisting design systems, a phantom token vocabulary that silently breaks light mode, shipped-broken CSS (`var(--border-hairline)` substitution renders the router with no borders at all), and four icon systems — the bones of a real design system exist in `tokens.css` and `ui.css`, they are simply unadopted and unenforced. **Third, the orchestration engine is one wave of small primitives away from being the headline:** the five designed dev workflows (Feature Crew, Bug Hunter, PR Tribunal, Strangler Refactor, Codebase Docent) are buildable today at ~80%, blocked by compositional gaps — a repeat node, `verifyCmd` on the critic, per-member overrides on moa — not by architecture. Onboarding remains the most dangerous surface: a fresh-Mac cold start ends in a hallucinated first reply, and every session starts with "pick a model and press Start" ceremony that no premium peer imposes. Fix visibility, enforce consistency, ship the workflow primitives — in that order — and Froglips goes from impressive demo to the local-first agent workstation it's clearly trying to be.

## The premium-feel gap

Ranked by leverage (visibility × cheapness):

1. **Broken `var()` substitution ships the router with no borders and a transparent panel.** What: `--border-hairline` is a full shorthand used as a color in 5 declarations (`chat.css:653,686,702,732,760`); `--surface-1`/`--text-1` don't exist. Why it reads non-premium: a headline feature renders as unstyled text floating on the composer — literally broken CSS in production, fifth occurrence of this bug class. Fix: replace the five declarations with `var(--border-subtle)`, map `--surface-1`→`--surface`, `--text-1`→`--text`; add a CI grep for undeclared tokens. Effort: **hours**.
2. **Phantom token vocabulary (`--fg-dim`, `--fg`, `--surface-3`, `--font-mono`, `--accent-fg`) degrades light mode.** 32+ references fall through to hard-coded dark-theme hexes — Settings labels, the launchpad (first screen), and reply-stat footers are mid-gray-on-white in light mode. Fix: one-shot sed to the real names, gated by the same stylelint check. Effort: **hours**.
3. **Code blocks have no copy button, language label, or header.** In a coder-focused app, copying a snippet means drag-selecting inside a scrolling pane — the single most-touched missing affordance vs. ChatGPT/Claude. Fix: post-sanitize wrap in `renderMarkdown` (same pattern as `chipifyCitations`) + one delegated click listener. Effort: **hours**.
4. **Streaming renders raw `**bold**` and ``` fences, then snaps to formatted markdown.** On a 2-minute local reply this *is* the visual impression of the app. Fix: stable-prefix incremental rendering — parse completed blocks via the existing `markdownCache`, plain-text only the open tail. Effort: **days**.
5. **No LaTeX rendering.** DeepSeek-R1/Qwen emit `$$…$$` constantly; math renders as backslash soup — the most visible "less finished than the web UIs" moment for a technical audience. Fix: KaTeX pass post-DOMPurify, cache via existing markdownCache. Effort: **day**.
6. **No macOS vibrancy, and the title bar is six interlocking magic-number rules.** Opaque gradient shell where Arc/Raycast/Linear signal native with translucent material; hamburger/collapse pinned at hand-tuned fixed coords that break if `trafficLightPosition` ever moves. Fix: `windowEffects` in tauri.conf + `color-mix` sidebar; real flex title-bar row with one `--traffic-inset` var. Effort: **days**.
7. **User-bubble palette forces white text onto failing swatches (Amber = 1.96:1).** A personalization feature that degrades legibility of the user's own words reads as a toy. Fix: store `{bg, fg}` pairs per swatch, `color: var(--user-bubble-fg)`. Effort: **hours**.
8. **Four icon systems: lucide, hand-rolled SVG paths, ASCII glyphs (`⚠ ▾ ▸ ●`), one emoji (📌).** Mixed-metric glyphs are the fastest "indie Electron" tell, present in 7+ warning surfaces. Fix: mechanical sweep to lucide + ESLint ban on glyph literals in JSX. Effort: **day**.
9. **The message hover rail — the most-hovered surface in the app — is hand-assembled.** 10px text with 16px icons, a raw `<select>` with options "G/P/C", a confirm state that reflows width under the cursor. Fix: one 26px icon-button rail with the unused Radix tooltips, pin-scope as a proper dropdown, width-stable confirm states. Effort: **day**.
10. **Feedback states lack one grammar: 90% of waits are spinners or "…", and toasts blink out with no exit motion, no queue, no hover-pause.** The shimmer skeleton exists and is used in exactly 2 components; two competing spinner implementations; three parallel error-box styles. Fix: Dashboard skeleton grid, consolidate on ui Spinner, ~80-line toast manager with stacking/exit/variants. Effort: **2 days**.

## Ease-of-use: the 10 sharpest friction points

1. **"Pick a model and press Start" — no auto-start anywhere.** Composer hard-disabled, every relaunch repeats the ceremony, model switching is Stop→wait→pick→Start (four interactions for peers' one). The wizard already proves auto-start is right. Fix: self-healing send (start the selected/last model with an inline "Warming up…" state), live model switching, Start/Stop demoted to a status pill. Effort: **days**. The single biggest recurring cliff.
2. **Native-only cold start ends in a hallucinated first reply.** The most common fresh-Mac path gets only agent-tool sample prompts, native backend can't arm agent mode, so the user's literal first impression is a hallucinated directory listing — the exact bug already fixed for ollama/mlx. Fix: branch wizard prompts by backend; native-aware landing card. Effort: **hours**. Highest severity per minute of fix.
3. **Agent runs are a black box.** `role:'tool'` rows render as null; the only live signal is "Running tool…" across a 40-iteration run. Inline narration is the core trust mechanic of Claude Code/Cursor and Froglips has none. Fix: collapsed inline activity chips (tool + arg summary + ok/err + duration), status pill carries tool name. Effort: **days**.
4. **The approval modal dumps raw JSON and hides session grants in the gear panel.** `write_file` content as one JSON-escaped string is unreviewable, while `makeUnifiedDiff` already exists and is shown only to the model; blanket-write grant requires closing the modal and digging into settings, so users click Allow 15 times or pre-grant blindly. Fix: diff pane in the modal for writes, command-as-code-block for shell, inline "Allow once / Allow this session / Allow under <dir>" buttons, active grants as dismissible chips. Effort: **2 days**.
5. **No pause or mid-run steering — Stop is the only verb.** The runner already injects synthetic mid-run messages (nudges); the mechanism just isn't exposed to the human. Fix: interject queue drained at iteration top + a pause-before-next-iteration toggle. Effort: **days**.
6. **No end-of-run change manifest; undo shows only the top of a 50-deep stack.** Eight files touched → one prose message and a single "Undo filename" button. For a security user this is an integrity gap. Fix: per-run manifest card (created/modified/deleted, expandable diffs from the existing snapshots, per-entry revert), persisted per conversation. Effort: **days**.
7. **The Table is a dead end for wizard graduates.** Seat picker aggregates only OpenRouter+Ollama; the wizard's default MLX/native starter yields an empty dropdown and three pieces of jargon. Flows includes MLX — the pillars contradict each other. Fix: add MLX seats (sequential turns dodge the reload trap, already gated); failing that, a guided empty state with one-click actions. Effort: **day**.
8. **Zero-model landing has no way to get a model.** Four lane cards all prefill prompts into a disabled composer; the one needed action — download a model — isn't on screen. Fix: state-aware landing ("Download a starter model" primary card; "Start llama3.2:3b" when stopped; never hand a prompt to a dead textarea). Effort: **hours**.
9. **First agent run is an uncoached gauntlet.** Surprise native folder picker with zero preamble, then an approval modal; the workspace-scoped/approval-gated mental model is taught nowhere; cancel fails silently. Fix: three coaching strings + a "needs a workspace" banner on cancel. Effort: **hours**.
10. **The recommender recommends a toy: "Recommended for your 128 GB Mac" over a 2 GB model.** First-model quality defines the product's perceived quality and undercuts every downstream pillar. Fix: 3–4 RAM tiers per backend in the existing TS catalog; recommender unchanged. Effort: **hours**.

Honorable mentions worth doing in slow weeks: ⌘K affordance in persistent chrome + shortcuts cheat-sheet modal; rename "Corpora"→Folders and give MCP's empty state a teaching sentence + a built-in tools catalog tab to fix the "Tools" naming collision.

## Power features that need finishing

- **Flows run history: persisted, invisible.** Every run lands in `workflow_runs` with per-card outputs; the only consumer is a model-facing tool. No human can answer "what did this flow produce yesterday?" Build the run-history panel on WorkflowsPage — the data layer is 100% done. **Day.**
- **Regenerate/edit: the plumbing for versions exists, the UX destroys history.** Both paths hard-delete superseded turns from SQLite; regenerate is final-turn-only; no sibling pager, no regenerate-with-different-model — bizarre for a multi-model workstation with a router and a per-model perf ledger. The fork forest already proves parent/child linkage works. Stage it: superseded-flag + version pager (days), model dropdown on regenerate (day), inline branch tree later (week+).
- **Audit trail: two half-stories.** ToolHistory has args/results but no timestamps/approval provenance; AuditLog has the metadata but lives inside the gear disclosure, with hand-typed numeric conversation filters. Merge into one per-conversation "Run timeline" with expandable rows, approval badges, export; promote global audit to the palette. **Days.** This is the trust artifact for the core persona.
- **Run metrics: collected, never rendered.** `metrics.toolStats` flows through every callback and has zero UI; users can't see the 40-iteration ceiling or wall-clock. "iter 12/40" + ticking elapsed + tooltip breakdown + cloud $ estimate. **Hours** — the cheapest trust win in the product.
- **History search: BM25 with snippets, but clicks don't land on the message.** Add `messageId` to open-conversation, expand the window until rendered, flash the row. Pair with last-activity sort + day grouping (currently `created_at DESC` buries live threads). **Days.**
- **Agent plan surface:** no TodoWrite equivalent; long runs have no visible roadmap. `set_plan`/`update_plan_step` tools + a pinned checklist card + one system-prompt rule. **Days.** Compounds with inline chips to fully de-black-box runs.
- **Second-class paths:** detached windows never refresh messages (refresh-token prop, the design is already noted in code); agent replies get no perf footer despite metrics streaming (build ReplyStat from AgentMetrics); stats are a volatile Map that dies on restart (persist keyed by message id). **Day** total.

## The dev-workforce play

The five designed workflows are the headline feature: they turn Froglips from "local chat with tools" into the only local-first product shipping the patterns with published evidence behind them — Architect→Editor (aider SOTA, 14x cheaper than monolithic reasoning), TDD loop (+27.8%, the largest single-pattern delta in the literature), Agentless-style localize/fix/verify, execution-grounded critics (the *only* form of self-correction that works per Huang et al.), and adversarially-verified review. The presets are the crew, Flows are the SOP, the scratchpad is the blackboard. Ship them as built-in templates, each wrapped in a budget node — the restraint (tiered posture: plain agent → router → Flows only where verification exists) *is* the premium positioning.

Merged product gaps, in build order:

**Wave 1 — make critics unfakeable (unblocks Feature Crew + TDD core of Bug Hunter):**
1. `nodeConfig.verifyCmd` on the critic node: runner executes it, injects exit code + output tail into the critique. Converts the weakest documented pattern (self-critique) into the strongest (execution-grounded) with one wire-up.
2. `criticSystemPrompt` — the verifier currently critiques wearing the generator's persona.
3. Honor `maxTokens`/`maxMs` on **all** node types (kill the exclusive nodeType switch) — a flailing red→green loop currently has no ceiling.
4. Gate/halt semantics: a card-level "halt when scratchpad key = value" so a `block` verdict actually stops the flow.

**Wave 2 — independent parallel judgment (unblocks PR Tribunal, heterogeneous ensembles):**
5. Per-member overrides (prompt/preset/model) on moa/consistency — lenses become truly parallel and different; heterogeneous local samplers (Qwen+GLM+R1-distill) is where open-weight ensembles beat any single model, and only Froglips can serve them simultaneously.
6. Per-edge handoff control (none / scratchpad-only) — stop lens B from anchoring on lens A's findings.
7. Per-member scratchpad namespacing + structured/functional voteMode (vote on file path/execution signature, not normalized text).
8. `onFail: escalate` on the critic node (cascade-wrapping-critic) — "loop locally, escalate to cloud if still red."

**Wave 3 — long-horizon safety (unblocks Strangler Refactor):**
9. **The repeat node** — iterate cards over scratchpad plan steps until a condition. The single highest-leverage missing Flow primitive; the linear-graph invariant currently forces one card to swallow entire plans with no checkpoints, progress, or resume.
10. Git isolation: `git_branch`/worktree tools + flow-level "run on a branch" — table stakes for trusting an unattended refactor.
11. Checkpoint/revert-on-fail on critic iterations, plus a pre-launch dry-run preview of which dangerous calls a run would auto-approve.

**Wave 4 — close the loop (unblocks Codebase Docent):**
12. `add_to_knowledge` tool (approval-gated) so the Docent's output makes chat permanently smarter — the best premium payoff in the set.
13. Blackboard `compact` op (write the digest back, clear verbose keys — today "summarize" doesn't actually shrink state) + artifact-spillover convention + truncation-notice key for clipped handoffs.
14. Pinned flow-level input artifact (canonical diff for Tribunal); PR-comment posting last.

Ship one flagship template per wave, demo-flow style, the week its primitives land.

## Structural investments

(The arch-health layer's findings converge with debt surfaced everywhere else; these are the build-now items that make every subsequent ship cheaper.)

1. **CSS token enforcement in CI.** The undeclared-token bug class has shipped five times. A stylelint unknown-token rule plus `declaration-property-value-allowed-list` for font-size/duration/radius costs a day and permanently closes findings 1, 2, and the 60–82% raw-value drift. Do this before any polish pass so fixes can't regress.
2. **Declare the ui kit the system and migrate by visibility-per-effort.** The kit is token-clean and 95% dead. Order: Settings modal (currently borrows the memories modal's class names and has zero identity) → one Dialog wrapper for all overlays (motion is already converged; finish it structurally) → one SegmentedControl replacing three forks → one Switch. Delete each clone as it migrates.
3. **Decouple workflow node capabilities from nodeType.** The exclusive switch in `nodes.ts` is the root cause of half the Wave 1–3 gaps (budget-on-critic, cascade-wrapping-critic). Make budget/gate/handoff-mode orthogonal config, not node identities — every future workflow primitive gets cheaper.
4. **Title-bar layout refactor + windowEffects.** Replace the six magic-number fixed-position rules with a flex row and one `--traffic-inset` var while adding vibrancy — do them together since both touch the same chrome.
5. **Toast manager + Spinner consolidation** — one feedback grammar, ~80 lines, removes three parallel patterns and 15 inline-style hacks.
6. **Event plumbing for multi-window and stats persistence.** Refresh-token prop for detached views; reply stats and run manifests into SQLite. Volatile in-memory state is repeatedly the reason features "vanish on restart."
7. **Palette registry as the single command source of truth.** Fill the gaps (Appearance, prompt library, agent toggles), generate the shortcuts cheat sheet from it, and add the persistent ⌘K affordance — discoverability stops being a per-feature afterthought.

## 90-day roadmap

**Now (2 weeks) — kill the broken and the embarrassing:**
- [polish] Fix var() substitution bugs in routes UI (hours)
- [polish] Phantom-token sed across styles (hours) + [infra] stylelint unknown-token CI gate (day)
- [polish] Code-block header with language + copy (hours)
- [polish] Bubble `{bg,fg}` contrast pairs (hours)
- [ux] Backend-aware wizard prompts + native-aware landing card — kill the hallucinated first reply (hours)
- [ux] Self-healing send: auto-start selected/last model, composer never disabled, live model switching (days)
- [ux] Starter catalog RAM tiers — stop recommending 2 GB to 128 GB Macs (hours)
- [ux] Zero-model landing: "Download a starter model" primary card (hours)
- [ux] Agent-run coaching strings + workspace-cancel banner (hours)
- [ux] "iter 12/40" + elapsed clock + toolStats tooltip in agent pill (hours)
- [feature] LaTeX rendering via KaTeX pass (day)
- [polish] Icon glyph sweep to lucide + ESLint ban (day)

**Next (6 weeks) — make the agent legible and the orchestrator honest:**
- [ux] Inline tool activity chips in transcript + named-tool status pill (days)
- [ux] Diff preview in approval modal + inline session-grant buttons + grant chips (2 days)
- [feature] Interject queue + pause toggle for runs (days)
- [feature] End-of-run change manifest with per-file revert (days)
- [feature] Workflow Wave 1: verifyCmd, criticSystemPrompt, budget-on-any-node, gate — ship **Feature Crew** + **Bug Hunter** templates (days)
- [feature] Flows run-history panel (day)
- [feature] Table MLX seats or guided empty state (day)
- [feature] Non-destructive regenerate + version pager + regenerate-with-model (days)
- [ux] Last-activity sidebar sort + day grouping + search scroll-to-message (days)
- [ux] Esc-to-stop, ArrowUp-edit, jump-to-bottom pill (hours)
- [ux] Per-conversation drafts + composer cap raise + paperclip accepts documents (day)
- [polish] Streaming stable-prefix markdown rendering (days)
- [polish] windowEffects vibrancy + title-bar `--traffic-inset` refactor (days)
- [infra] Settings → ui kit Dialog/Tabs/Switch; single SegmentedControl (days)
- [infra] Toast manager + Spinner consolidation; Dashboard skeletons (2 days)
- [polish] Message action rail rebuild (day)

**Later (90 days) — the dev-workforce headline and the deep debt:**
- [feature] Workflow Wave 2: per-member overrides, handoff control, namespacing, functional voteMode, onFail-escalate — ship **PR Tribunal** template + heterogeneous local ensembles (week+)
- [feature] Workflow Wave 3: repeat node, git_branch/run-on-branch, critic checkpoint-revert, auto-approve preview — ship **Strangler Refactor** template (week+)
- [feature] Workflow Wave 4: add_to_knowledge, blackboard compact, artifact spillover — ship **Codebase Docent** template (days)
- [feature] Agent plan surface: set_plan tools + pinned checklist (days)
- [feature] Unified per-conversation Run Timeline (merge AuditLog + ToolHistory) with export (days)
- [feature] Message-level inline branch tree on fork plumbing (week+)
- [feature] Cascade telemetry loop: perf-ledger-driven route/threshold suggestions + escalation chips in replies (days)
- [feature] Agent-path reply stats + persistence; detached-window refresh tokens (day)
- [ux] ⌘K header affordance + registry gap-fill + generated shortcuts modal (day)
- [ux] Corpora→Folders rename, MCP teaching empty state + starter installs, built-in tools catalog tab (hours)
- [infra] Token codemod (fs/space/duration) + stylelint value allowlists (2 days)
- [infra] Remaining overlay migration to ui Dialog; delete per-feature clones (week+)