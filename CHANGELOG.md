# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

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
