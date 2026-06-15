# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

## [0.14.4] — 2026-06-15

Improvement-roadmap remediation (3 waves, multi-agent verify-then-fix).

### First-run & onboarding

- **Fixed a first-run ship-blocker on the headline native backend.** The setup
  wizard's native-backend download called a CLI-only HuggingFace pull
  (`pull_hf_model` shells to `hf`/`huggingface-cli`), which a zero-install Mac
  doesn't have — so the recommended "install nothing" path hard-failed on step
  2. It now downloads + loads in-process via `nativeLoadModel`, and the native
  starter is `Qwen/Qwen2.5-1.5B-Instruct` (a checkpoint the mistralrs/candle
  loader can actually load) instead of an MLX-format quant that risked a load
  panic.
- Wizard leads with the zero-install native backend ("Start here — no install"),
  sets honest cold-load expectations (first load downloads + warms the model),
  shows an in-wizard hardware-fit warning, and offers an "I already have a model
  → chat" fast path.

### Chat

- **Reasoning models** (DeepSeek-R1 / Qwen3 / gpt-oss): chain-of-thought now
  renders in a collapsible "Thinking" disclosure above the answer instead of
  being dropped or dumped inline.
- **Progressive markdown while streaming** — the completed portion of a reply
  renders as formatted markdown (code blocks highlight live) as it streams; only
  the in-flight tail stays plain.
- Jump-to-latest pill when you've scrolled up mid-stream; code blocks gain
  Download + soft-wrap buttons; `update_plan` renders as a live pinned checklist.

### Agent

- Tool-confirmation modal now shows a **real unified diff** for file writes/edits
  and a **plain-English action summary** for every tool, with raw args demoted to
  a collapsible block.
- **"Trust this task"** per-run approval mode auto-approves the run's remaining
  normal-risk, allowlisted tools (irreversible tools always re-confirm; never
  persists across runs).
- One-click **Retry** on recoverable send failures; cold-model stalls
  **self-retry once** ("Warming up the model…") before erroring.
- The non-progress guard is now a real **circuit breaker** — a wedged run stops
  with a clear message instead of looping to the iteration cap (and burning
  cloud credits).
- Clarified that the agent's default file reach is the home folder (it always
  was — the UI mislabeled it "full filesystem").

### Models, RAG, Flows

- Capability badges (context / vision / tool-fitness / RAM headroom) in the model
  picker; MLX speculative-decode (draft model) and max-tokens exposed in Settings.
- Agent system prompt now lists available knowledge corpora (the search tool was
  uncallable without exact names); structure-aware chunking for new ingests; RAG
  search hits are click-to-open.
- Workflows **Run History** panel over persisted runs; scheduled-run completion
  notifications + an "app must be open" warning; per-card "Test this card" dry-run.

### Updates, reliability, a11y, perf

- **Auto-update is on by default** again (the gate that silently disabled it for
  every install is fixed) with a Settings toggle; failed checks are now surfaced
  instead of reported as "up to date".
- DB recovery/unavailable startup banner; health pill polls so it clears on
  recovery; "Open log folder" in Diagnostics; the diagnostics export is now a
  real `.zip` (secrets redacted); agent tool-failure rate feeds the health
  registry.
- WCAG-AA text contrast; ARIA names on Send/Stop and the command palette;
  `prefers-reduced-transparency` fallback; boot skeleton (no white flash);
  top-level error boundary persists to `diag.log`.
- Optimized `[profile.release]` (LTO + single codegen-unit + strip; panic=unwind
  kept so tool panics stay recoverable); `minimumSystemVersion` 13.0; a release
  preflight that fails on three-file version drift.

### Notes

Deferred big bets (tracked, not in this release): hybrid keyword+vector RAG with
re-chunk migration, resume-an-interrupted-run from checkpoint, global UI text
scaling, daemon-less embeddings, model-catalog browser, side-by-side compare.

## [0.14.3] — 2026-06-15

### Fixed

- **Chat messages no longer double-space after a reply finishes streaming.**
  While streaming, the assistant bubble renders plain text under
  `white-space: pre-wrap` (tight, correct). On completion it re-renders as
  marked-generated HTML — but the bubble still had `white-space: pre-wrap`, so
  the literal `\n` that marked leaves between block tags was rendered a *second*
  time on top of the `<br>` it already emits for soft breaks (`breaks: true`).
  Result: every line gained an extra blank line the moment thinking ended. The
  completed `.markdown` content now uses `white-space: normal`; the streaming
  bubble keeps `pre-wrap` via the more-specific `.streaming-plain` rule, so the
  live stream is unchanged. (`src/styles/chat.css`)

## [0.14.2] — 2026-06-14

### v0.14.0 re-review remediation (35 findings)
A focused re-review of the v0.14.0 architecture-remediation DELTA (the new code
the prior reviews never saw) found 36 issues; the critical (DB upgrade lockout)
shipped in 0.14.1. This release fixes the rest:

- **Correctness — agent checkpoint "shadow rows":** the durable per-iteration
  checkpoint rows (hidden from the chat view) no longer leak into the maintenance
  archive, FTS message search, or the sidebar search (all now filter `run_id IS
  NULL` like the conversation view).
- **sqlite-vec recall:** memory dedup + recall now apply the active-status filter
  the linear path used (vec0 indexed all statuses and filtered post-KNN); short
  vec0 results fall back to the linear scan so a crowded global index can't drop
  valid hits; RAG corpus scoping documented.
- **Cloud/OpenRouter agent backend:** vision (image) messages now deserialize on
  the tool-call path (`ChatMessage.content` accepts the OpenAI multi-content
  array); 5xx errors from the custom backend are retried (status-format match);
  the tool-call stream is byte-capped.
- **Inference gate:** a leaked subagent concurrency slot on spawn failure is
  released (try/finally); a custom backend pointed at localhost is now gated like
  any local backend (remote custom still bypasses) — fixed a real IPv6-loopback
  (`[::1]`) host-classification bug; the gate resolves the host from a settings
  registry, no call-site plumbing.
- **Resilience/ops:** the backend liveness probe no longer reloads settings
  (Keychain + file) every 2s; a leaked active-run counter is reset on main-window
  startup (was permanently blocking workspace changes after a renderer reload);
  maintenance ANALYZE runs under the write lock; the archive DELETE no longer
  re-scans the whole archive each pass.
- **Build:** the bundle-budget gate now measures render-blocking CSS (was JS-only,
  so the 151 KB App.css could leak unchecked); App.css preloaded on the main
  window (no FOUC).
- **Frontend:** `useSettingsField` keys its cache on selector identity; the
  detached-window param parser reuses the shared parser; LazyDerivedSet defers the
  ES2024 Set-combinator methods.

Two low-impact perf residuals deferred (documented): per-row vec0 catalog probes
during ingest (the safe cache needs cross-file invalidation hooks); a lean
quick.css split for the popover. Gates: cargo 372 native/no-default · clippy clean
both · tsc clean · vitest 920 · build + bundle-budget pass. Notarized + stapled.

## [0.14.1] — 2026-06-14

### Critical — fix DB lockout when upgrading from <= 0.13.x
The v0.14.0 migration folded `agent_audit::ensure_schema` into the ladder as rung
v20, which eagerly created an index on the `conv_id` column — but `conv_id` is only
added to a pre-existing table by the later v24/v25 rungs. On any DB created before
v0.14.0, rung v20 ran `CREATE INDEX … ON agent_audit(conv_id)` against a table that
did not yet have that column → "no such column: conv_id" → the migration aborted
and the database failed to open. Fresh installs were unaffected (the column is in
the CREATE TABLE body), which is why the build/smoke tests missed it. The two
`conv_id` indexes in `ensure_schema` are now guarded by `column_exists`, so an old
table skips them in v20 and the v24/v25 rung creates the column + index. Added a
regression test that ages a full schema back to the real pre-v0.14.0 shape and
re-runs the ladder. **Anyone who installed 0.14.0 and was locked out should update
to 0.14.1** (no data was lost — the migration rolled back atomically).

## [0.14.0] — 2026-06-14

### Architecture remediation — 10-phase refactor (44 review findings)
A master-architect review found 44 structural issues (3 high, 30 medium, 11 low;
no criticals). All were remediated as a sequenced, behavior-preserving, gate-green
program. Full write-up: `docs/REVIEW-2026-06.md`.

**Maintainability / structure**
- **Single tool registry** — the 77 agent tools are defined once; the model schema,
  the dispatch table, every risk-classifier Set, dry-run tables, and flow allowlists
  all derive from it (a cross-layer test fails CI if the TS registry and the Rust
  command surface drift). Replaces ~10 hand-synced parallel layers.
- **Single security manifest** — protected paths, credential basenames, and the
  injection-token catalog live in one `security-manifest.json` consumed by both Rust
  and TS (was duplicated across 5+ hand-synced definitions). **Closed a real gap:**
  the Seatbelt sandbox now denies the credential set `run_shell` could previously
  read but `read_file` blocked (`~/.aws/credentials`, `~/.config/gh`, browser
  cookies, TCC, …) while keeping `~/.gitconfig`/`~/.npmrc`/`~/.aws/config` readable
  so builds don't break.
- **God-modules decomposed** — App.tsx, ChatWindow, dispatch.ts, runner.ts split into
  focused hooks/handlers (behavior-preserving extraction). Flow node types are now
  per-node handler modules + a registry instead of a switch + flat-config bag.
- **Central settings store** — one `SettingsProvider` (load once, subscribe once,
  selector hooks) replaces ~20 components each refetching the whole blob; settings.json
  is authoritative, localStorage demoted to a first-paint cache (split-brain removed).

**New capabilities**
- **DB/storage maintenance agent** — periodic, safe (archive-not-delete to a cold
  attached DB, incremental vacuum/WAL-checkpoint/FTS-optimize, consistent table caps);
  configurable; a Storage panel with "Optimize now" + confirm-gated "Reclaim disk".
- **sqlite-vec ANN** — RAG + memory vector search now use a vec0 index (was a full
  linear cosine scan) with a verbatim linear fallback; BLOB columns stay the source of
  truth. No new dylib / no notarization impact.
- **Cloud/OpenRouter agent backends** — custom + OpenRouter are now first-class
  agent-loop + Flows backends with streamed tool-calling (was content-only chat, with
  "cloud" faked via `:cloud` Ollama ids).

**Resilience / performance**
- Inference admission control (bounded local-slot concurrency; cloud bypasses),
  subagent concurrency budget, backend liveness probe (detects wedged-but-alive),
  a health/degradation registry surfaced as a UI pill, and durable per-iteration
  agent-run checkpointing.
- Migration ladder consolidated (one `user_version` authority); single-writer DB
  serialization.
- Build/startup: the lightweight Quick Prompt window's boot graph dropped ~68%
  (619KB→198KB); the 415KB markdown chunk split (marked/highlight/katex); an enforced
  bundle budget gates the release.

Behavior-preserving throughout. Deferred (documented, each mitigated): DAG Flows
engine, agent-run auto-recovery-on-reload, full per-run workspace threading,
approval-into-executeTool chokepoint, renderer privilege separation. Gates: cargo
364 (native/no-default) · clippy clean both · tsc clean · vitest 911 · build +
bundle-budget pass. Notarized + stapled.

## [0.13.14] — 2026-06-13

### Full-codebase review remediation (76 findings)
A multi-agent review (14 areas, every finding adversarially verified) surfaced 76
confirmed issues — no criticals or highs; 10 medium, 66 low — weighted toward
performance, correctness, and optimization since the security audit was already
done. 74 fixed, 2 deferred (cross-file boot-bundle lazy-loading). Full write-up:
`docs/REVIEW-2026-06.md`. Highlights:

- **Correctness:** dry-run `edit_file`/`multi_edit` preview now mirrors the real
  Rust executor exactly ($-patterns, multi-match reject, literal first-occurrence)
  so the diff you review matches what gets written; `readLines` no longer drops
  already-complete earlier lines on a giant stream chunk; `keychain_get` now
  distinguishes `errSecItemNotFound` from a transient access failure (a denied
  prompt no longer silently presents the key as "absent"); `keychain_set` won't
  silently downgrade a key to the plaintext file on a recoverable Keychain error.
- **Security hardening:** `applescript_run` output is now injection-fenced like
  every other untrusted subprocess channel; `validate_read_src`/apply-patch commit
  re-canonicalize the parent to close a leaf/parent symlink-swap TOCTOU; MCP
  registry fetches are size-capped (no unbounded `.json()` on a hostile upstream);
  policy bare-token allow rules no longer match a basename anywhere in a nested path.
- **Performance:** `read_file` pagination seeks to the requested window instead of
  re-reading the whole file per page (was O(file×pages)); protected-path prefix
  sets cached once (no ~35 PathBuf allocations + home_dir syscalls per scanned
  entry in the search hot loop); the fs watcher debounce map is now bounded;
  RoundtableView caches parsed markdown; MoA proposers run with diverse params;
  katex no longer lands in the main boot bundle.
- **Robustness:** `agent_audit` trim is a contiguous primary-key range delete
  (keeps exactly the newest N) instead of a NOT-IN anti-join.

All gates green: tsc clean · vitest 846 · cargo test 327 (native) / 327
(no-default) · clippy clean (both feature sets). Notarized + stapled.

## [0.13.13] — 2026-06-13

### Security — the three audit residuals closed (A01/A10, A28, A16)
v0.13.12 left three items as deliberate trade-offs. All three are now resolved:

- **OS Seatbelt sandbox is now DEFAULT-ON (A01/A10).** Agent `run_shell` /
  `run_code` children run under `sandbox-exec` with a deny profile covering the
  credential set no build tool legitimately reads — `~/.ssh`, `~/.gnupg`,
  Keychains, browser cookies, Mail/Messages, and Froglips' own stores. Network and
  everything else (`~/.gitconfig`, `~/.npmrc`, `~/.aws`, project files) stay
  allowed so git/npm/aws builds are unaffected. A one-time startup probe means a
  malformed profile or a missing `sandbox-exec` silently falls back to unsandboxed
  rather than bricking the shell tool. Escape hatch: `FROGLIPS_NO_SHELL_SANDBOX=1`.
- **API keys now live in the macOS Keychain (A28).** The default secret backend
  moved from the 0600 `secrets.json` file to the login Keychain (in-process
  Security.framework, so the item ACL binds to the stable notarized Developer ID
  signature — the ad-hoc-resign ACL churn that drove the original file choice is
  gone). Existing file-stored keys auto-migrate into the Keychain on first read
  and the plaintext copy is purged. A Keychain failure transparently falls back to
  the 0600 file so a key is never lost. Escape hatch: `FROGLIPS_SECRETS_FILE=1`.
- **Supply-chain audit is a failing CI check (A16).** The production `cargo audit`
  and `npm audit` steps are blocking (red on any prod-dep advisory) on every push
  and PR — already shipped in 0.13.12's `ci.yml`. (Marking it a *required* status
  check in GitHub branch protection is a one-time repo-settings toggle the
  maintainer applies; it interacts with the direct-push release flow, so it's left
  to a deliberate manual decision rather than changed programmatically.)

## [0.13.12] — 2026-06-13

### Security & correctness — full audit remediation
A multi-agent deep audit (every finding adversarially re-verified) found 39
confirmed issues; all are now remediated (35 fixed, 3 mitigated, 1 accepted
by design). Full write-up: `docs/AUDIT-2026-06.md`. Highlights:

- **Shell/code hardening:** spawned children now run with a cleared+allowlisted
  environment (no app-env leak), in their own process group with kill-the-group
  on timeout/cancel (backgrounded children no longer survive), and bounded by
  `RLIMIT_FSIZE`/no-core. `run_code` with a shell language now hits the same risk
  classifier as `run_shell`. (Full OS Seatbelt sandbox is available as an
  opt-in; not default, to avoid breaking legitimate builds.)
- **Approval gate:** `watch_path` / `stop_watch` / `task_cancel` were gated only
  in the UI — their Rust commands now require a payload-bound approval token,
  with a symmetry test + a TS tripwire so a future dangerous tool can't slip the
  binding.
- **apply_patch correctness:** refuses to apply a hunk to an ambiguous location
  (stale line number on repeated lines no longer rewrites the wrong region);
  rejects duplicate target paths; validates every target (incl. new files) before
  any write; writes the exact canonical path (no re-resolve TOCTOU).
- **Prompt-injection fencing** extended to every remaining untrusted-output path:
  `poll_watch`, `format_code`, native tool errors (`diff_files`/`kill_process`),
  `git` stderr, `list_processes`.
- **Web/SSRF:** `call_api` no longer re-sends the key over an http downgrade
  redirect; `copy_path` writes with `O_NOFOLLOW`; SSRF blocklist gains
  240/4 · 198.18/15 · 192.0.0/24; `browser_navigate` re-validates post-redirect.
- **Agent loop:** read-cache invalidated on any mutating-tool run (even a partial
  failure); a wall of denied calls now trips stop-and-report; re-read-after-write
  no longer flagged duplicate; abort pairs all remaining tool calls.
- **Flows:** scheduled runs pre-load the cards' models, gate against the correct
  workflow, silently skip an unreviewed flow, and the critic verify command is
  cancellable.
- **Ops/perf:** `agent_audit` self-trims; CI prod supply-chain audits are now
  blocking; Dashboard aggregations + HF model cards memoized;
  `read_file` pagination no longer splits a UTF-8 char.

## [0.13.11] — 2026-06-12

### Fixed
- **Agent stops at "let me fix that…" without doing anything.** When a model
  returns only a preamble ("I'll work on X:", "Let me continue with the fixes:")
  with no tool call — and has made zero tool calls all run — the loop used to
  accept that as the final answer and stop. Now it recognizes the narrate-
  without-acting stall (common once a long chat fills with the model's own no-op
  "I'm working on it" turns) and injects one firm "call the tool now, don't
  narrate" nudge, then continues — so the agent actually acts instead of just
  describing. Bounded (max 2 nudges) so a model that genuinely can't act still
  exits cleanly, and it never fires after real work has started (a true
  completion summary is left alone). Pairs with the 0.13.10 multi-tool fix.

## [0.13.10] — 2026-06-12

### Fixed
- **Agent "says it's working but does nothing" on cloud models (multi-tool turns
  silently lost).** Ollama Cloud streams each tool call on its own line with the
  slot index nested under `function.index` and complete object arguments. The
  parser read only the top-level `tc.index` (absent on this shape) and fell back
  to the array position — always 0, since each line holds one call — so a turn
  with several tool calls **collapsed into slot 0, each call clobbering the
  previous**. A coding agent issuing multiple edits per turn lost all but the
  last (or corrupted to zero → "0 tools"), then narrated ("let me continue…")
  because its edits never landed. Tool-call slot indices are now resolved from
  either shape (`tc.index` or `tc.function.index`). Verified directly against
  `qwen3-coder:480b-cloud` (it tool-calls correctly; the app was dropping them).

## [0.13.9] — 2026-06-12

### Fixed
- **Agent runs on cloud (and big local) models aborted mid-reply with
  "AbortError: Fetch is aborted."** The Ollama agent client used a flat 120s
  *total*-request timeout, so a long-but-actively-streaming response — e.g.
  `qwen3-coder:480b-cloud` doing multi-minute agentic reasoning — was killed at
  120s even while tokens were flowing. It now uses an inactivity (idle) timeout
  that resets on every received line, with a generous first-byte/cold-start
  window — matching the MLX client. Only a genuinely stalled connection aborts.
- The "run failed" banner for an inner stall/timeout (not a user Stop) now reads
  as an actionable "the stream stalled — send again to retry" instead of the
  cryptic `AbortError: Fetch is aborted`.

## [0.13.8] — 2026-06-12

### Fixed
- **Cloud models failed to install with "pull model manifest: file does not
  exist."** The Model Library built the pull tag as a bare `<name>:cloud`, but
  Ollama's size-tagged cloud models use `<name>:<size>-cloud`
  (`gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`, `deepseek-v3.1:671b-cloud`).
  The bare tag 404'd the manifest, and because a 404 doesn't look like a
  sign-in error, the auto-`ollama signin` retry never kicked in. Cloud pull tags
  now resolve via a verified map → largest-size heuristic → bare `:cloud`
  (`lib/cloud-tags.ts`), so "Get cloud" uses the real tag and the existing
  sign-in flow handles auth.
- **The "vanishing Froglips.app" bug — root cause found and fixed.** The
  Desktop-alias step ran `ln -sf /Applications/Froglips.app ~/Desktop/Froglips`.
  Once `~/Desktop/Froglips` already existed as a symlink to the bundle (true
  after the first release), `ln -sf` *dereferenced* it and created the new link
  **inside** the bundle: `/Applications/Froglips.app/Froglips.app ->
  /Applications/Froglips.app`. That stray self-link in the bundle root broke the
  code-signature seal ("unsealed contents present in the bundle root"), so
  Gatekeeper rejected the app and macOS removed it on launch. `release.sh` now
  removes any existing alias before linking, so it can never write into the
  installed bundle.
- **Release script could also delete a freshly-notarized install.** The
  post-install check ran `rm -rf /Applications/Froglips.app` whenever `spctl`
  didn't confirm within 10s — but `spctl`'s online assessment flakes for seconds
  right after notarization. It now widens the window, treats only an explicit
  reject as fatal, and never deletes (so a broken install can be inspected
  instead of vanishing).

## [0.13.7] — 2026-06-12

### Agent tools — new capabilities
- **`read_files`** — read several files in one call instead of one per turn
  (read-only, no approval). Mirrors the existing `write_files`.
- **`apply_patch`** — land a coordinated change across one or more files as a
  single unified diff, in one approval. Atomic: if any hunk fails to match the
  file exactly, nothing is written (no fuzzy/partial application). Creates new
  files via `--- /dev/null`; refuses deletions (that stays with `delete_path`).
  The approval token is bound to the exact patch text.
- **`search_files` context lines** — pass `context: N` (1–5) to get the lines
  around each match (`before`/`after`), instead of a follow-up `read_file`.
- **`update_plan`** — keep a short pinned checklist for a multi-step job and
  flip step statuses as you go, instead of re-narrating the whole plan each
  turn. Saves tokens and keeps weaker local models on track. Visible in the
  Tool History panel.
- **`read_file` pagination** now returns `next_offset` — the cursor to pass as
  the next `offset` — so the model paginates large files without doing the math.

### Agent loop — optimization
- **Read-only tool calls in a turn now run in parallel.** When a turn issues
  several independent reads (e.g. read three files, grep two trees), their
  backend IPC overlaps via a bounded pool instead of awaiting one at a time —
  result ordering, the per-run read cache, the stall guard, and audit rows are
  all preserved. Writes, approvals, and cloud routes stay strictly serial.
- **Loop-thrash guards widened.** The duplicate-call guard now compares against
  the last few turns (not just the immediately-prior one), so an A/B/A/B
  oscillation is caught instead of running to the turn limit. The same-target
  stall guard now also covers a repeated identical `search_files`, not only
  chunked `read_file`s.

### Fixed
- **Release build was silently broken by a dependency-resolution drift.**
  `embedder.rs` needs `reqwest`'s `blocking` feature, which had been satisfied
  transitively; a `cargo update` (from the earlier toolchain refresh) dropped
  it, breaking a clean test/release compile. Now declared explicitly.

## [0.13.6] — 2026-06-12

### Performance — Chat
- **A streaming reply no longer re-renders the whole chat window.** The
  per-token reply text used to live in the chat window's state, so every frame
  (~60×/sec) re-rendered the composer, toolbar, context meter, and rollover
  banner — even though only the streaming bubble changes. The text now lives in
  an isolated child; the window holds just an "is streaming" flag (flips twice
  per reply, not per token), so the heavy controls stay put and frames go to
  the text you're reading. (A focused review confirmed the rest of the chat
  hot path — token coalescing, no per-token markdown, windowed history,
  cached highlighting — was already optimized.)

## [0.13.5] — 2026-06-12

### Agent — tool-calling
- **The agent stops writing files through the shell.** It now uses `write_file`
  for source files instead of `run_shell` with `cat`/heredocs/`tee` (which hit
  the shell command-length limit, scattered files outside the workspace, and
  cost a separate approval per file). The tool descriptions + Coder preset say
  so explicitly, and a `run_shell` command that looks like a file write gets a
  one-line steer toward `write_file`.
- **New `write_files` tool** — create several files in ONE approval-gated call
  instead of N. Scaffolding a multi-file app is now one tool turn (and one
  approval) instead of ten. Confined to the workspace + bound to the exact set
  of paths, like every other write.
- **Configurable agent turn limit.** The default rose 40 → 80, and you can set
  it (5–400) in Settings → General for long multi-file builds. The turn-limit
  message now tells you the work is saved and you can reply "continue."
- **Fewer approval prompts** — `write_files` rides the "approve all writes this
  run" blanket, so a vetted run no longer prompts per file.

## [0.13.4] — 2026-06-12

### Performance — Flows
- **The canvas no longer re-renders 60×/sec during a run.** A streamed token
  used to rebuild the whole React Flow node array — every node's data object +
  3 closures each — and re-diff all nodes every 16ms for the entire run,
  stealing frames from the output you're actually watching. The per-card
  status map is now referentially stable across output-only updates, the
  canvas is memoized, so a streaming token is a no-op for the graph; only the
  one card whose text grew repaints.
- **The run panel repaints one row, not all of them.** Each status row is
  memoized on its visible fields, so a streaming card no longer reconciles
  every other card's row on every token.
- **The scheduler stops reading every workflow's full graph each tick.** The
  30-second scan now reads only `(id, updated_at)` and fetches a workflow's
  graph blob only when it actually changed — in steady state, zero blob reads
  per tick instead of one per workflow.

## [0.13.3] — 2026-06-12

### Fixed
- **Stale-clone healing now matches by structure, not prompt text.** v0.13.2's
  heal keyed on identical prompts, so improving a template's wording (the
  path-discipline blocks) made every existing clone stop matching and never
  heal. It now identifies a template clone by its card-id set and conservatively
  fixes only the two things a stale clone has wrong — re-arming an action card
  whose tools are unchanged, and swapping the exact `npm test` verify literal —
  leaving customized tools and custom verify commands alone.

## [0.13.2] — 2026-06-12

### Flows — fixes from a real end-to-end build test
- **Stale template clones now self-heal.** Workflows you cloned from a gallery
  template *before* v0.13.1 froze the old config (action cards not armed, so
  their file/shell tools were silently denied, and a `npm test` verify command
  that failed in non-Node projects). On load, an unmodified template clone is
  re-synced to the current template — armed action cards + the safe
  auto-detecting verify command. Customized workflows are left untouched.
- **No more silent no-ops.** A flow card that needs a dangerous tool but isn’t
  set to run unattended now stops the run with a clear message naming the card
  and tool ("needs arming — open it and enable Unattended"), instead of looping
  while producing nothing.
- **Coder flows stay inside the project.** The Spec/Architect/Implementer and
  Fixer cards now require workspace-relative paths (never `~`/absolute) and
  must create files with `write_file`/`edit_file` — never shell redirection
  (`cat > file`), which bypasses workspace confinement.
- **"Where do files go" is visible.** The Flows run panel shows the active
  project folder ("Files write to: …"), or warns when it’s defaulting to your
  home folder. A failed workspace restore at startup is now logged instead of
  silently swallowed.


## [0.13.1] — 2026-06-12

### Fixed — Flows
- **Built-in templates now actually run.** Every gallery template (Feature
  Crew, Bug Hunter, the five security workflows) shipped with its action
  cards in attended mode, so the runner silently denied every shell/edit/
  commit/API call — the flows looked like they ran but did nothing. The
  vetted action cards are now armed; authorization gates and read-only cards
  stay denied, and irreversible tools (delete/kill) remain hard-denied.
- **Critic verify command is safe by default** — auto-detects npm/cargo and
  no-ops cleanly when neither is present, instead of failing every iteration
  on a missing `npm test` and burning the whole retry budget.
- **Self-consistency votes actually vote** — samples now vary across members
  (so they can disagree), the vote compares the structured verdict line, and
  free-text cards use synthesis honestly instead of paying for a vote that
  never matched.
- A thrown run (e.g. an unreviewed advanced flow hitting its arm gate) no
  longer leaves a card stuck on "running" with an orphaned timer.

### Performance — Flows
- **Cascade escalation refines instead of restarting** — the strong model
  now receives the base draft + the critique, rather than re-solving from
  scratch (the call you escalate specifically to avoid paying twice).
- The Flows page no longer re-renders wholesale on every streamed token;
  CardForm and the canvas stop rebuilding heavy structures each keystroke.
- Critic skips the verify run on its final, discarded iteration.
- The scheduler stops re-parsing every workflow graph and pruning its
  bookkeeping table on every 30-second tick.

## [0.13.0] — 2026-06-12

### Flows — the agent workforce
- **Build a Flow from chat.** Describe a workflow in agent mode and the
  assistant constructs it via `create_flow`. A new **advanced mode** lets it
  author powerful Flows — critic loops with a real verify command, cascade
  escalation, mixture-of-agents — with web/edit/shell tools. Any card the
  assistant grants elevated tools lands flagged **Needs review**: the runner
  *and* the scheduler refuse to run it until you open it and **Arm** it. The
  assistant can never auto-run, schedule, or self-approve a Flow.
- **Scheduled Flows with a date & time.** Pick when a Flow runs — a one-shot
  calendar date+time, `daily HH:MM`, or `every Nm/Nh` — from a proper picker.
  A one-shot missed while the app was closed runs once on next launch.
- **Flows Wave 1 primitives.** Critic nodes can run a real shell *verify
  command* and score against its exit code (execution-grounded review); the
  verifier judges from its own stance; budget ceilings apply to every node
  type; a `Halt when` gate stops a flow on a blocking verdict.
- **Dev-workforce templates** in the gallery: **Feature Crew** (spec →
  architect → implement → review → ship) and **Bug Hunter** (reproduce →
  vote-localize → fix → independent verify). Local models do the work; only
  the hardest reasoning escalates to a flat-rate hosted tier.
- **Five defensive security templates** (category *Security*): Security
  Auditor, Vuln Bug Hunter, Supply-Chain Sentinel, Exposure Monitor (breach
  self-check — your HIBP key stays in the Keychain), and Threat Model Crew.
  Every template touching a live target or personal data opens with an
  authorization gate.

### Agent
- **Real API access.** The Coder preset gained web/HTTP tools, and a new
  **saved-API registry** (Settings → APIs) lets the agent call any registered
  API *by name* — your key is stored in the macOS Keychain and injected
  server-side, so the model never sees the secret. A capability assertion in
  the system prompt stops small models from falsely claiming they "can't
  access the web/APIs."
- **Run visibility.** The agent status pill now shows the current tool, the
  iteration count, a live elapsed clock, and a per-tool call-count tooltip.

### Chat & onboarding
- **Self-healing send** — the composer is never disabled; your first message
  starts the selected model automatically, and switching models hot-swaps in
  place. No more "pick a model and press Start" ceremony.
- **Code blocks** get a language label + copy button; **LaTeX** math renders.
- **Onboarding** no longer ends in a hallucinated first reply on a fresh Mac;
  the starter-model catalog is sized to your machine's RAM; an empty install
  leads with "Download a starter model."
- **Voice dictation** now works (native on-device speech recognition), and the
  microphone permission prompt actually appears.

### Security & correctness
- `call_api` hardened: the injected key is pinned to the registered host
  across redirects, model headers are deny-filtered, and the key is redacted
  from responses.
- All multi-statement writes use `IMMEDIATE` transactions (fixes a rare
  reply-loss under concurrent writes).
- Atomic installs (stage + rename) and a retrying Gatekeeper gate.
- Toolchain pinned (Rust 1.96, Node 22 in CI) and a CI gate that fails on
  undeclared CSS tokens.

### Design
- CSS token-system integrity pass (fixes borderless panels and light-mode
  regressions); consistent code-block and feedback styling.

## [0.12.0] — 2026-06-09

### Distribution
- **Notarized builds** — releases are now signed with a Developer ID
  certificate, notarized by Apple, and stapled. The app opens with a normal
  double-click; the Gatekeeper right-click/`xattr` workaround is gone.
- Release pipeline verifies notarization (`spctl` must report
  "Notarized Developer ID") and self-heals a bundler signature clobber
  before shipping; the release aborts if Gatekeeper rejects the build.

### Performance
- Agent-mode replies now stream live into the chat bubble (previously the
  bubble froze on its first frame until the turn finished).
- Boot: main bundle slimmed 606 → 437 kB; window opens at its saved size and
  position with no resize jump; theme applies before first paint.
- Long chats: plain chat now fits history to the model's context window and
  stops re-sending old pasted images every turn.
- Cloud sends reuse a pooled TLS connection (~30-120 ms faster first token);
  RAG search and re-indexing are dramatically cheaper on large corpora.

### Multi-model chat router
- **Auto-route** — a chat toggle that picks the best-fit configured model per
  message: keyword fast-path → semantic match → small-LLM classifier → default.
  Each answer is attributed to the model that produced it (transcript dividers +
  a live "→ route · model · method" chip); falls back to the active model on any
  failure. Agent mode keeps the active model.
- **Router configurations** — named, note-able bundles of routes ("Hybrid
  cloud+local", "All-local private", …); switch the whole set in one click.
  Stored locally; a legacy flat route list auto-migrates to a "Default" config.
- **Semantic stage** — each route carries example *utterances*, embedded (via the
  local `nomic-embed-text` path) into a cached prototype; a message is matched by
  cosine in ~10-100 ms, skipping the LLM classifier for clear cases. The
  classifier disables thinking (`think:false`) so reasoning models don't return
  empty replies.
- **Test routing box** — type a message and see which route + model it would take
  (with the cosine score) without sending a real chat.
- Architecture + phased plan: `docs/ROUTER_DESIGN.md`.

### Flows — orchestration nodes (make small models punch up)
- **New node types** on the workflow canvas — a card can now be more than a
  single agent pass. Pick a **Node type** in the card editor:
  - **Mixture-of-Agents** — N proposers run in parallel, then one synthesis
    pass merges them into the single best answer.
  - **Self-Consistency** — sample the same prompt N times, then majority-vote
    or merge the most consistent answer.
  - **Critic Loop** — generate → critique (scored) → revise, until it clears a
    pass mark or hits the iteration cap (self-refine).
  - **Cascade** — run a cheap/local model first; if a critic scores it below a
    threshold, escalate to a stronger model (e.g. an Ollama `:cloud` tag).
  - **Router** — a classifier picks the best-fit route (model / backend / role)
    for the task, then runs it.
  - **Blackboard** — snapshot / summarize / clear the shared run scratchpad so
    downstream cards share state.
  - **Budget** — run a card under a token and/or wall-clock ceiling, returning
    the best effort so far when the cap is hit.
  All node types reuse the existing agent loop, so tools / MCP / approval gates /
  streaming all work inside them. Orchestrator cards show a node-type badge on
  the canvas. Confidence (no logprobs) is scored by a critic pass.
- **Seeded "Demo — Orchestration Showcase" flow** — Planner → MoA researchers →
  Critic loop → Reporter, all on the active local model.

### Built-in agent tools
- **`run_code`** — execute a snippet (python / node / bash / sh / ruby) in a
  throwaway interpreter with a wall-clock timeout, capped output, and cleanup.
  Arbitrary code execution — gated behind the same approval-token flow as
  `run_shell` (bound to language + code).
- **`calculate`** — exact arithmetic via a safe hand-written shunting-yard
  evaluator (never `eval`): `+ - * / % ^`, parens, unary minus, and
  sqrt/sin/cos/ln/log/… plus pi/e/tau.
- **`remember` / `recall_memory`** — agents can now deliberately save + semantic-
  search long-term memory (the existing scoped vector store), not just receive
  auto-recall. Scopes: global / project / conversation.

### Roundtable ("Table")
- **Reasoning-model support** — capture `reasoning` / `reasoning_content` from
  thinking models (OpenRouter *and* Ollama, e.g. `gemma4`); a reasoning-only
  turn falls back to that text instead of being dropped as "empty response".
- **Backend-aware per-turn timeout** — local (Ollama) seats get a longer
  window (cold-load/reload) than cloud; a timed-out cloud turn is reported as
  a timeout, not committed/billed as done.
- **Ollama Cloud (`:cloud`) seats** are no longer mis-flagged as "local" —
  the "2+ local models reload each turn" warning/gate only counts truly-local
  models.
- **Pre-run gating** — Start requires ≥2 seats and two-click-confirms a 2+
  local-model config (which reloads each turn and usually times out).
- **`sanitizeTurn` hardening** — never manufactures an empty turn; distinguishes
  a real speaker hijack from a vocative addressing another participant.
- **One-click Reset** — restores default seats/topic/rounds/budget/memory.
- Budget gate now counts failed turns' input tokens; transcript bubbles
  memoized; inject ignores IME-composition Enter; misc guards.

### Security / storage
- **API keys moved from the macOS login Keychain to a `0600` `secrets.json`**
  (custom backends + MCP remote tokens). The Keychain ACL reset on every
  ad-hoc re-signed build and re-prompted on access; the local owner-only file
  removes the prompt. `security-framework` dependency dropped.
- A corrupt `secrets.json` is now quarantined to `secrets.json.corrupt` + logged
  instead of silently wiping (then overwriting) stored keys.
- SSRF hardening: block IPv4-mapped IPv6 (`::ffff:169.254.169.254`) + the
  Alibaba metadata IP `100.100.100.200` across the MCP and custom-backend
  guards; the custom backend now DNS-resolves + pins (no rebind TOCTOU).
- Path-safety write denylist extended to browser-profile dirs (Chrome/Firefox/
  Safari) to match the agent fs layer.

#### Security audit (multi-round hardening pass)
- **Case-insensitive path denylists** — macOS APFS is case-insensitive but
  case-preserving, so the read/write/credential denylists (agent fs gate, the
  backup/export/import write-dest gate, and project-policy `denied_write_paths`)
  could be bypassed by changing the case of the target (`~/.SSH/id_ed25519`,
  `.ENV`, `Secrets/`). All path comparisons now fold ASCII case via a shared
  component-wise helper; the read gate was widened to all of `/etc`.
- **Tool-confirmation gate completeness** — `format_code`, `screenshot`,
  `show_notification`, `remember` (memory-store write), `watch_path`,
  `stop_watch`, and `task_cancel` now require confirmation like every other
  side-effectful tool (they previously ran without a prompt). Dry-run is now
  default-deny (read-only allowlist), so `run_code` / `task_create` and any new
  tool are suppressed under "side-effects suppressed" instead of executing.
- **Untrusted-output fencing** — `run_shell` / `run_code` stdout+stderr,
  `diff_files`, `git status`/`branches`, HTTP response headers, `web_search`
  titles, `list_dir` entry names, and subagent answers are now injection-scanned
  + DATA-fenced before re-entering the model (closing the gaps where command and
  metadata output bypassed the existing wrapping).
- **Secret store + DoS** — `secrets.json` is written via `O_EXCL` (no symlink-
  follow, guaranteed `0600`); OAuth/MCP HTTP bodies (success + error paths) and
  workflow `graph_json` are size-capped before parsing.
- **Least privilege** — subagent tool grants are intersected with the parent's
  (a preset can't broaden scope); the unused `opener` renderer capability was
  dropped; `open_path_in_editor` is confined to the workspace.
- **Browser tool** (off-by-default feature) — Chrome's DNS resolver is pinned to
  the validated IP (`--host-resolver-rules`) to close a rebinding TOCTOU.

### MCP / Tools
- **One-click OAuth** for remote MCP servers — browser authorization
  (discovery → dynamic client registration → PKCE/S256 → loopback callback →
  token + refresh), all SSRF-pinned. No more pasting API keys for OAuth servers.
- OAuth endpoints require https (loopback http allowed); 401 → auto-refresh → retry.

### Table (outcomes) / Flows
- **Saved roundtables** — keep multiple named roundtables; the Table landing is
  a Flows-style list.
- **Persisted outcomes** — a completed run auto-saves (transcript + totals) to
  the DB (migration v17), with per-table run history, a read-only viewer,
  **Save to file** (Markdown/JSON), and **Run again**.
- Fixed: cloud-capable rows (e.g. `gemma4`) show as Installed when a local tag
  (`gemma4:latest`) is present; Remove targets the real tag.

### Chat
- Tool calls/results hidden from the transcript; the stream shows only the
  answer + a live **Thinking… / Running tools…** status. Expand the full call
  history via the toolbar **History** button.
- Cold-start: the landing shows on first launch (no conversation yet) and guides
  "pick a model + Start"; backend-crash/restart messages now surface.

### UI / premium pass
- Two-layer elevation shadows, tactile `:active` press, tinted selection + thin
  scrollbars, shell gradient frame, soft input focus rings, card hover-lift,
  premium Flows canvas (selection ring, arrowhead edges, grabbable handles),
  unified modal enter-animation + frosted backdrop.
- **lucide-react icon system** replaces ~90 emoji/Unicode glyph icons app-wide.
- EmptyState + skeleton loaders; readable agent-toolbar metrics; "Claude
  Skills" → "Skills".

### Production / reliability
- App version + a "Report an issue" link in Diagnostics.
- `release.sh` documents the Developer ID signing + notarization env contract.
- Setup wizard distinguishes Ollama running / installed-but-stopped (→ run
  `ollama serve`) / not-installed (→ download).
- HuggingFace library load failures get a Retry; the native-chat error path no
  longer hangs the spinner.

### Fixes
- Ollama model pulls stream a clean progress bar (ANSI/`\r` stripped) instead
  of raw terminal output.
- Conversation context menu clamps to the viewport (no off-screen clipping).

## [0.11.1]

A local-first macOS desktop app for chatting with local and cloud LLMs.

### Core

- **Chat** — streaming conversations against local (MLX / Ollama / in-process
  native) and cloud (`*:cloud`, OpenRouter, custom OpenAI-compatible) backends,
  with conversation history, soft-delete, and a memory/profile system.
- **Roundtable** — multi-model conversations: several models take turns on a
  shared transcript with a director, per-turn budget/time caps, and graceful
  per-turn failure handling.
- **Flows** — card-based agent workflows with an App-level run provider so a run
  survives navigation, a scheduler, and a scratchpad.
- **Tools / Agent mode** — gated tool use (shell, file, web, http) with an
  approval model, plus MCP servers as the extension mechanism.
- **Model library** — live HuggingFace + ModelScope search, a curated Ollama
  catalog, OpenRouter, and an *Installed* tab with sizes + total disk usage.
- **Vision** — image attachments in chat for vision-capable models.

### Platform

- Tauri 2 + Rust + React, macOS-only for 1.x.
- Local-only, no telemetry. All user data (settings, history, weights) lives in
  `~/.local-llm-app/` and never leaves the device.
- Signed minisign releases via GitHub Releases with an in-app auto-updater.
- SQLite persistence with an immutable migration ladder.
