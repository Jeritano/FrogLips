# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Workflow + agent hardening (2026-05-24, 5-round audit cycle)

**Ollama cloud (`*:cloud`) tool-calling round-trip — root-caused and fixed.** Persistent `Ollama 400: "Value looks like object, but can't find closing '}' symbol"` traced to the wire format Ollama's cloud router expects:

- `tool_calls[].function.arguments` now passed as a **parsed JSON object** (was JSON-encoded string). Refs: `openclaw/openclaw#46679`, `#50689`.
- `name` field stripped from `role:"tool"` messages (legacy OpenAI field, current spec only `{role, content, tool_call_id}`).
- `tool_call_id` forwarded on tool result messages.
- `finalizeToolCalls` sanitizes unsafe ids (anything outside `[A-Za-z0-9_-]`) into `call_<8 hex>`. Empty arguments default to `{}`.
- `:cloud` models skip the Ollama `options` payload (per-request `num_ctx` / `num_predict` rejected by cloud passthrough).
- `:cloud` models execute one tool_call per turn (cloud router rejects multiple parallel calls in one assistant turn). System reminder injected after the tool result lets the model reissue dropped intents on the next turn.
- Tool result content prefixed with `\n` when it begins with `{` so the cloud router's "string-that-looks-like-an-object" heuristic doesn't try to parse it.

**Workflow runner safety.** Handoff `<untrusted-data>` fence regex tolerates whitespace + attributes + ChatML/Llama/Mistral special tokens (`<|im_start|>`, `[INST]`, `<<SYS>>`, etc.) — adversarial card output from a web fetch can no longer escape the fence or inject role-framing tokens. `HANDOFF_OUTPUT_CAP` (64 KiB) capped via `safeTruncate` that trims back from a lone high surrogate so emoji/CJK never break mid-character. Every UI hook (`onCardStart` / `onCardOutput` / `onCardDone` / `onCardError` / `onWorkflowDone`) wrapped in `safeHook` so a throwing subscriber can't take down a card or the run. `parseWorkflowTrigger` rejects NaN / Infinity / floats / negatives / zero / empty `card_id`. Unknown preset now refuses to run instead of silently broadening to "all tools allowed". `card.model === ""` falls back to `opts.model` (was passing the empty string straight through).

**Unattended scheduled-run auto-approve.** `UNATTENDED_NEVER_AUTO` now also blocks `applescript_run`, `delete_path`, `kill_process`, `agent_undo`, `http_request`, `spawn_subagent`. MCP tools blocked via `isMcpToolName(...)` (a previous literal `"mcp_call_tool"` entry was dead — names are minted at runtime as `mcp__<server>__<tool>`). Auto-approve now also requires `risk === "normal"` — anything escalated by `classifyToolRisk` falls through to the explicit gate.

**Per-call risk classifier.** `classifyToolRisk` is now path-aware for `write_file` / `edit_file` / `multi_edit` / `move_path` / `copy_path` / `make_dir`. Writes targeting `/etc/`, `/Library/Launch{Agents,Daemons}/`, shell rc files (`.zshrc`, `.bashrc`, …), `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, or any `*.app`/`*.command`/`*.terminal`/`*.workflow`/`*.tool` bundle (root OR internal writes) escalate to `destructive` so `approveAllWrite` cannot wave them through. `move_path` / `copy_path` inspect BOTH `args.from` and `args.to`. Lexical `..`-collapse runs before the prefix check so `~/foo/../../etc/hosts` doesn't slip past as "normal" risk. The Rust write layer remains the authoritative gate; this keeps the UX promise of the in-app toggle honest.

**Approval modal in workflows.** Interactive workflow runs now surface a `ConfirmDialog` for every dangerous tool (was: default `denyAll` → models silently knew they couldn't write, abandoned the work). The Promise resolver wires the AbortSignal so clicking Stop while a modal is open resolves as `{approve:false, reason:"aborted"}` and unwinds the runner cleanly. Unmount cleanup aborts the whole run (no more "completed" runs with empty outputs because navigation silently auto-denied a pending approval). Deny taxonomy expanded — `ConfirmDecision.reason` records `"user_deny"` / `"user_allow"` / `"aborted"` / `"unattended_denied"` distinctly in the audit row, while the model-facing tool body collapses to a single learnable `kind:"permission_denied"`. New per-run **"Auto-approve file writes"** checkbox in RunPanel — covers only actual fs writes (`write_file`/`edit_file`/`multi_edit`/`make_dir`/`move_path`/`copy_path`); `http_request`, `clipboard_set`, `applescript_run`, `git_commit` always gate explicitly. Reset to `false` on every workflow open.

**WorkflowsPage state lifecycle.** Synchronous `runningRef` guards all three run entry points (Run workflow / Run card alone / `workflow-trigger` event). `aborted` and `error` card statuses now transition the card badge out of "running" (was stuck). `stopRun` no longer nulls `abortRef.current` synchronously (a second Stop click is now a safe no-op rather than dropping the controller mid-teardown). `ensureCardModelLoaded` pre-loads each card's pinned model up front, deduped by model name. Single-card runs clear all stale state from prior full-workflow runs. Scheduled-trigger handler scopes the model-coverage check to the cards from `startCardId` onward instead of the whole graph. Edge-click on the canvas now prompts to disconnect (React Flow's select+Delete doesn't survive the re-render reconcile). In-progress banner displayed while a run is live (`"● Run in progress — leaving this view will cancel it."`).

**Workflow editor save semantics.** `loadedSnapshotRef` + `loadedWorkflowIdRef` baseline-track the workflow open state; the debounced auto-save only fires when the in-memory state genuinely diverges from the loaded baseline. Prevents unrelated re-renders (status update, user-profile load) from clobbering concurrent external DB edits. Revert-to-baseline clears `pendingSave.current` so an unmount flush can't re-apply abandoned edits. `openWorkflow` resets per-session state (`approveAllWrite`, `formCard`, error banner).

**Agent system prompt.** Now injects current ISO date + locale time per run — models no longer fabricate filenames from training-data cutoff dates. Path conventions block anchors common shorthands ("desktop" → `~/Desktop/`, "documents" → `~/Documents/`, "downloads" → `~/Downloads/`) and instructs the model to honor literal filenames + file extensions verbatim. Research-budget nudge fires at 10 successful external research calls (`web_search` / `web_fetch` / `read_pdf`) without writes when the card can produce a deliverable — breaks the "model spins forever on search without ever calling `write_file`" failure mode. Local filesystem reads (`read_file` / `list_dir` / `search_files`) don't count toward the nudge so Coder-style codebase exploration isn't punished.

**Researcher preset.** Now read AND write (added `write_file`, `edit_file`, `multi_edit` to the allowlist; `run_shell` stays off). System prompt mandates `write_file` for any "report/summary/document" request and forbids deferring to chat-only output. `userProfile` (About You block) is no longer injected into workflow agent runs — kimi-k2.6:cloud was picking the user's first name as the literal filename.

**Schedule grammar parity.** Form regex `scheduleError` and Rust `parse_schedule` now agree on whitespace tolerance (`^every[ \t]+(\d+)[ \t]*([mh])$`) — restricted to ASCII whitespace only so Unicode (NBSP, ZWSP, ideographic space) that JS `\s` would accept but Rust `strip_prefix("every ")` rejects can't slip through and silently never fire.

**parseWorkflow hardening.** Card ids deduplicated on load. `x` / `y` coordinates must be finite + within ±1e6 (Round 1 fix; NaN/Infinity would have broken React Flow viewport math).

**`approveAllWrite` plumbing.** Threaded `RunWorkflowOptions.approveAllWrite` + `RunWorkflowOptions.approveAllShell` through to `AgentRunOptions`; `APPROVE_ALL_WRITE_FS` set defined at module scope.

**Audit log linkage.** `recordAuditSafe` failures now flow through `logDiag` (was `console.warn` — invisible to the user since WKWebView devtools aren't exposed).

**Tests.** 444 vitest tests + 27 Rust workflow tests pass after 5 rounds of remediation. New test files: `src/lib/workflow/__tests__/edge-cases.test.ts` (73 tests across structural, dedup, parseWorkflow, runner, hook safety, handoff sanitization, recording, trigger payload narrowing) and `src/lib/workflow/__tests__/stress.test.ts` (17 tests covering 10 000-card graph resolve, concurrent runs, abort-boundary timing).

**Diagnostic tooling.** New `append_diag_log` Tauri command writes to `~/.local-llm-app/diag.log`. Used by `ollama-client` to dump the full outgoing body whenever a 400 fires — the cloud-route round-trip diagnosis above is what surfaced the actual root cause.

### Licensing
- The project is **open source under the MIT License** — Copyright (c) 2026 Joseph D Eriano. Anyone may use, modify, and distribute Froglips provided the copyright notice and license text are retained. `package.json` and the Rust crate declare `MIT`. (An earlier proprietary / all-rights-reserved phase and its EULA have been dropped.)

### Positioning
- Froglips is now framed as **the local-LLM power workstation**, built on three pillars — **Agent** (tools, MCP, workspace sandbox, dry-run), **Knowledge** (memory + RAG + searchable history), and **Models** (backend/model fleet management, parameters). Plain chat is the substrate, not the headline.

### Security (2026-05-24 re-review pass)
- **Browser per-action approval gates.** Previously only `agent_browser_navigate` was gated — `_click`, `_fill`, `_screenshot`, `_get_text`, `_close` rode the post-navigate session. Now each is approval-gated AND bound to its target selector / value where applicable so the user explicitly confirms each on-page action.
- **AppleScript binding.** `agent_applescript_run` was the only remaining dangerous IPC on the legacy bareword approval path — it's strictly more powerful than `run_shell` (can `do shell script` + drive any scriptable app). Now payload-bound to the script body.
- **Binding canonicalization collision-proof.** Length-prefixed `<len>:<name>=<value>` encoding replaces the prior `\x1f` and `|` separators. A `title` value containing `\x1f` could otherwise have colluded with a different `title`/`body` split that hashed identically.
- **`policy::is_owned_by_current_user` uses `libc::geteuid`** instead of comparing against `$HOME`'s uid (which was a stable proxy but never fired on the real attack — extracting user owns the file). Added `libc` as a cfg(unix) dep.
- **RAG search results scanned.** `agent_search_files` hits + `rag::search` snippets now flow through `injection_scan::scan_and_wrap`. Previously the only external-content paths that bypassed the scanner.
- **MCP `inputSchema` nested descriptions sanitized** (every `description` + `title` string in the JSON Schema tree gets the same strip + 512-byte cap as the top-level `description`).
- **`path_safety::is_denied` mirrors `agent::fs::protected_prefixes`** — backup / export / image_save_to could otherwise still target `~/Library/LaunchAgents`, shell rc files, `~/.local-llm-app`, etc.
- **`commands/path_safety.rs` extra prefixes:** LaunchAgents/Daemons, shell init, Terminal.plist, `~/.pypirc`/`.gitconfig`/`.docker`/`.kube`, `~/.local-llm-app`, `~/Library/Application Support/Froglips`.
- **`agent/browser.rs::get_text` byte-slice panic fixed** — now walks to char boundary before truncation.
- **`IRREVERSIBLE_TOOLS` set added.** `delete_path`, `kill_process`, `agent_undo` are NEVER auto-approved via the session-blanket branch even when "Approve all writes this session" is on. classifyToolRisk bumps them to `destructive` so the modal carries the loud red badge.

### Code quality (2026-05-24 re-review pass)
- **`agent_undo` covers extras.** `move_path`, `copy_path` (when overwriting), `delete_path` now `snapshot::capture` before mutation so a stray destructive op can be reverted.
- **`delete_path` recursive cap walks the full subtree** — the prior cap counted top-level + one nested level, depth-2-bypassable by nesting (`root/a/b/<1M files>` slipped through).
- **`list_processes` + `list_undo` removed from READ_ONLY_TOOLS.** Both reflect real-time state that a non-mutating tool can't invalidate; a cached `list_processes` could feed `kill_process` against an exited (and possibly reused) PID.
- **`agent_set_workspace` clears `snapshot::STACK`** on root change so an undo from project A can't write into project B's tree.
- **`cacheStore` skips eviction when overwriting an existing key** (was dropping an unrelated entry on cap-hit re-set).
- **`useChatSend` settings cache `invalidatorBound` flag** flips only on `listen` success — a transient registration failure during boot no longer leaves the cache un-invalidatable.

### UX (2026-05-24 re-review pass)
- **Shared `<ErrorBar>` component** applied to 9 sites (App, AboutYou, AgentSettings, ChatWindow, McpSettings, PromptLibrary, MemoryPanel, ForkTree, DetachedChatView). All carry `role="alert"`, an explicit × button with `aria-label`, focus-visible style, optional Retry slot. Hit area bumped to 24×24 min.
- **SetupWizard Esc** focuses the wizard's "Skip" exit button via a stable `data-setup-wizard-escape` attribute instead of the first `.setup-wizard-skip` match (which on Steps 2 + 3 was the "Back" button).
- **AgentToolbar wraps** (`flex-wrap: wrap`) so the 10+ chips/buttons on a narrow window drop to a second row instead of clipping.
- **ModelPicker split** — `__native__` and `__browse__` are now real buttons next to the `<select>`, not synthetic options inside it (assistive tech no longer announces them as model choices).
- **Long-running chip** in the agent confirm modal when `run_shell` requests `timeout_secs > 60`.
- **Plain-language danger chips** for `kill_process` (SIG + pid + irreversible), `delete_path` (recursive / path), `agent_undo` (revert + can't redo). Each in addition to the existing destructive risk badge.
- **`agent_undo` toolbar surface.** New "↶ Undo `<file>`" button on AgentToolbar reading the snapshot stack every 3 s. Stays disabled when stack is empty.
- **Sidebar "VIEWS" micro-section** groups Workflows + Images. `aria-current="page"` for the active view (in addition to `aria-pressed` for CSS).
- **Header parity** — `topbar-view-title` is 13px to match ModelPicker so chrome height is constant.
- **Header label sync** — "Images" instead of "Image generation" matches the sidebar entry.

### Security (2026-05-24 review sweep)
- **Payload-bound approval tokens for every dangerous IPC.** Tokens now bind to a SHA-256 of the live arguments (path, pid+signal, command, URL, mcp-command+args+env-keys, etc.) so a token approved for one payload cannot be silently spent on another within the 60s TTL. Covers `agent_run_shell`, `agent_write_file`, `agent_edit_file`, `agent_multi_edit`, `agent_move_path`, `agent_copy_path`, `agent_delete_path`, `agent_make_dir`, `agent_undo_last`, `agent_kill_process`, `agent_clipboard_set`, `agent_open_app`, `agent_show_notification`, `agent_open_path_in_editor`, `agent_format_code`, `agent_screenshot`, `agent_http_request`, `agent_browser_navigate`, `mcp_start_server`.
- **Approval gates added** where they were missing: `agent_clipboard_set` (clipboard hijack), `agent_open_app` (arbitrary app launch), `agent_show_notification` (notification phishing), `agent_open_path_in_editor`, `agent_format_code`, `agent_screenshot` (window-content exfil), `agent_browser_navigate`, `mcp_start_server` (was unauthenticated — user-level RCE).
- **Workspace confinement default** — `within_workspace` no longer returns true when no explicit root is set; falls back to `$HOME` so a fresh install isn't free-roaming. Protected prefixes expanded to cover `~/Library/LaunchAgents`, `~/Library/LaunchDaemons`, shell init files (`.bash_profile`, `.zshrc`, `.zshenv`, `.profile`, `.zprofile`), `Terminal.plist`, `~/.local-llm-app`, `~/Library/Application Support/Froglips`, `.pypirc`, `.gitconfig`, `.docker/`, `.kube/`.
- **Browser navigate SSRF guard** — `agent_browser_navigate` now rejects non-http(s) schemes (no `file://`, `chrome://`, `javascript:`, `data:`) and reuses `agent::web::is_safe_public_host` so the headless browser can no longer be driven at private IPs / link-local / metadata endpoints.
- **HTTP deny-headers expanded** with `Referer`, `Origin`, `User-Agent`, `Sec-Fetch-*` — prevents the model from forging Origin (defeats naive CSRF), impersonating browser/bot UAs, or lying about navigation provenance.
- **Prompt-injection scanner normalizes input** — strips zero-width chars (U+200B-U+200D, U+FEFF, U+2060, U+180E), bidi overrides (U+202A-U+202E, U+2066-U+2069), and C0/C1 controls before pattern matching. `i​gnore previous in​structions` (zero-width-space between letters) no longer sails past the literal-word regex. Wrapper also flags "invisible formatting chars" finding so the agent knows the content carried smuggling characters.
- **MCP tool descriptions sanitized** before they hit the system prompt: same invisible/control char strip, newline collapse (defeats multi-line fake-instruction smuggling), 1024-byte cap, conservative name validation (`[A-Za-z0-9_.-]{1,64}`).
- **`asset://` scope tightened** from `images/**` to `images/*.png` + `images/**/*.png` so the model can't drop arbitrary-content files under that prefix and have the renderer fetch them.
- **Approval-token RNG hard-fails** on `/dev/urandom` read failure instead of falling back to a time+counter+pid mix the reviewer flagged as bruteforceable in the 60s TTL window.
- **Approval-token store capacity** — `approval::mint` refuses when 256 live tokens exist rather than evicting; eviction would let a spam attacker invalidate legitimate live tokens.
- **`image_save_to` requires `.png` extension** — image bytes are PNG-encoded; the suffix check stops the model from using this IPC to drop arbitrary-named bytes anywhere the user has approved.
- **`ask_user` answer scanned + wrapped** — the user is trusted for intent but the *content* may be pasted external text carrying jailbreak phrases. Now treated as data via `injection_scan::scan_and_wrap` before flowing back into the agent loop.
- **Project policy file ownership check** — `policy::load_for_cwd` refuses `.froglips/policy.json` files not owned by the current uid. Stops an untrusted git repo from shipping a policy that auto-approves arbitrary shell commands.

### Code quality (2026-05-24 review sweep)
- **Read-only tool cache bounded** at 256 entries with FIFO eviction in `runAgentLoop` — was unbounded for the lifetime of one agent run.
- **Task-queue auto-prune** — `task_queue::create` runs an opportunistic prune of TaskEntrys older than 30 minutes before counting against the cap. Long sessions no longer leak terminal task rows.
- **`setActiveShell` / `clearActiveShell` / `cancelActiveShell`** no longer collide on the unkeyed fallback path — bounded `Map<symbol, string>` replaces the module-level mutable singleton.
- **`useChatSend` rAF flush** bails when `ctrl.signal.aborted` so a stale snapshot can't land on the next conversation after a user-abort + restart.
- **`image_gen` idle evictor race** closed — evictor now takes `generate_mutex` before its check-then-drop dance.
- **`db_unavailable_notice` IPC** wired so the UI can render an actionable banner when SQLite init fails, instead of every downstream IPC returning a generic error.
- **`redactValue` depth-capped** at 32 levels to prevent stack overflow on a pathologically deep arg tree.
- **`useChatSend` settings cache** — caches `AppSettings` per-renderer + invalidates via a new `settings-changed` Tauri event emitted from `settings_set`. Was round-tripping the whole settings blob per send just to read `user_profile`.
- **`classify_shell_risk` normalizes whitespace** before substring match — `rm  -rf  /`, `rm\t-rf /`, and ` rm -rf ~ ` are now caught.
- **MCP autostart parallel** — `for ... await` replaced with `tokio::spawn` + `join_all`, each task wrapped in a 15s per-server timeout so one wedged server can't gate the rest.
- **Streaming-response truncation** at `ACC_MAX=262144` bytes now surfaces a diagnostics warning instead of silently aborting.

### UX (2026-05-24 review sweep)
- **Sidebar "VIEWS" micro-section label** groups the Workflows + Images buttons so they read as a navigation cluster rather than orphaned verbs.
- **Per-view header title** — the chrome no longer collapses to a lone theme-toggle on Workflows / Images; renders an h1 with the active view name.
- **SetupWizard Step 2 Next** no longer hard-gates on a fresh starter download — also enabled when the user already has any installed model or no starters exist.
- **SetupWizard Esc** moves focus to the Skip button instead of being a silent no-op so users discover the escape hatch.
- **Sidebar error-bar** now has an explicit × dismiss button + `role="alert"` for screen reader announcement.

### Added
- **Agent mode on the Native backend** — `mistralrs-core` 0.8.1 exposes a real `tools`/`tool_choice` API and returns `tool_calls` in its stream, so the native chat command now accepts tool definitions and tool-role messages and the agent loop routes the native backend through a native agent-chat path. **Agent mode now works on all three backends** (Ollama, MLX, Native); it is no longer rejected on Native.
- **Agent-loop context-window manager** — before each model call the message array is budgeted against the model's context size: oversized tool results are truncated in the sent copy and the oldest turns collapse into a synthetic summary, while the system prompt is always kept. Stops long agent runs from overflowing small-context models and evicting their own tool definitions.
- **Per-conversation model parameters** — a `params` column plus commands and a params panel for temperature / top-p / max-tokens / system-prompt, threaded through all three backends, with a context-usage meter by the composer. Every field is independently nullable and falls back to the backend default.
- **Conversation organization** — conversations can be pinned and tagged; message-content search replaces title-only search; pinned conversations sort first. Pin/tag affordances use the existing hover-button pattern (the locked sidebar layout is untouched).
- **Conversation auto-titling** — new conversations are titled from the first user message (whitespace-collapsed, word-boundary-truncated) so the sidebar is navigable instead of a wall of "New chat".
- **Data backup / export / import** — an online-backup command for the SQLite database, a versioned JSON export of conversations + messages + memory, and an additive import that remaps ids inside a transaction. Surfaced in the Diagnostics panel.
- **Local crash logging** — a process-global panic hook appends timestamped panic records with backtraces to `~/.local-llm-app/crash.log` (size-capped, rotated). A `read_crash_log` command surfaces it in a refreshable Diagnostics-panel section. Purely on-disk, no network.
- **Observability** — a rolling on-disk `app.log` via `tracing`, plus an export-diagnostics-bundle command (logs + crash log + redacted settings + versions) for actionable bug reports.
- **DB corruption recovery** — startup runs `PRAGMA integrity_check` and quarantines a corrupt `db.sqlite` (renamed with a timestamp) so the app starts fresh instead of panicking into a bricked state.
- **Numbered migration ladder** — ad-hoc per-column migrations are replaced by a numbered `user_version` ladder; each step is transactional and idempotent, and fresh and existing databases converge on the same schema.
- **Model-server auto-restart** — a crashed MLX model server is auto-restarted with bounded retries and backoff; after the cap it gives up with a clear diagnostic. A user-initiated stop never triggers a restart.
- **Empty-chat landing** — the blank chat surface is replaced with clickable example prompts; agent mode surfaces its active preset + workspace as chips and shows a one-time coach hint.
- **Error states with retry** — backend/model start, library fetch, model download, and MCP connection failures now surface clear, recoverable inline errors with retry/restart affordances instead of failing silently.
- **Undo for conversation delete** — deleting a conversation soft-deletes it with a 5-second undo toast that preserves the conversation and its messages.
- **Cross-platform CI** — a job compile-checks the Rust crate on Linux and Windows on every PR, so platform-specific breaks surface before release-tag time.
- **Release hardening** — `release.sh` smoke-tests the built app before installing, and `release.yml` publishes a `SHA256SUMS` file.
- **Agent mode on the MLX backend** — agent mode previously ran only against Ollama. The agent loop now dispatches its tool-calling LLM call by backend: Ollama via NDJSON `/api/chat`, MLX via the OpenAI-compatible `/v1/chat/completions` tools API (parsing `tool_calls` from the streaming deltas).
- **Edit-message** — the previously dead edit feature is now wired: edit and resend your last user prompt via the per-message Edit action.
- **Sidebar collapse/expand toggle** — hide the conversation sidebar to give the chat full width.
- **Native model load progress** — listeners surface download/load progress while a HuggingFace model loads on the Native backend.
- **Chat ModelPicker non-chat-repo filter (defense in depth)** — `src/lib/chat-model-filter.ts` mirrors the Rust-side `is_non_chat_repo` blocklist (FLUX weights, CLIP/SigLIP encoders, T5 encoder-only + tokenizer-only repos, standalone VAE) and is applied in `ModelPicker` (chat dropdown) and `CardForm` (workflow agent dropdown). The Rust filter is authoritative; this is the safety net for stale binaries / future HF cache shape changes. `ModelBrowser` intentionally stays unfiltered. 7 unit tests pin the patterns.
- **Agent file-ops tools** — `move_path`, `copy_path`, `delete_path`, `make_dir` IPCs + agent-loop tool defs. Eliminates most of the "ask shell approval for `mv` / `cp` / `rm` / `mkdir`" round trips: the dedicated tools still gate destructive ops with a confirmation, but the approval modal copy is now honest about the operation ("Move A → B?" instead of "Run `mv A B`?"). All paths are workspace-confined via the existing `validate_for_write` / `validate_for_read` gates; `copy_path` caps source at 256 MiB; `delete_path` caps recursive trees at 1000 entries.
- **`hash_file`** — SHA-256 / SHA-512 of a file, streamed in 64 KiB chunks. Source ≤ 1 GiB. Read-only.
- **`diff_files`** — unified diff between two arbitrary files via `git diff --no-index` (works outside repos). Each side ≤ 4 MiB.
- **`list_processes` + `kill_process`** — `ps`-backed listing (top 200 by CPU, optional name filter, current uid only) and a signal-sender that refuses pid ≤ 1 and clamps to a fixed signal allow-list (TERM/KILL/HUP/INT/QUIT/USR1/USR2; other inputs fall back to TERM). `kill_process` is approval-gated; `list_processes` is read-only.
- **`agent_undo` + `list_undo`** — every `write_file` / `edit_file` / `multi_edit` snapshots the file's prior contents (or marks it absent if the path was new) into an in-memory LIFO capped at 50 entries / 4 MiB per entry. `agent_undo` pops the most recent entry and writes the bytes back (or deletes the file). `list_undo` lets the model preview what would be reverted. The stack drops on app restart by design — this is a per-session safety net, not version control.
- **Per-call `run_shell` timeout** — the tool now accepts `timeout_secs` (clamped server-side to [1, 600]) so long builds / installs / test suites don't have to live inside the old 30s ceiling.
- **Read-only tool cache** — the agent loop now caches results for known-read-only tools (`read_file`, `list_dir`, `file_exists`, `search_files`, `git_status` / `git_diff` / `git_log` / `git_show` / `git_branches`, `hash_file`, `diff_files`, `list_processes`, `list_undo`, `find_definition`, `find_references`) keyed by a stable hash of `(name, args)`. Duplicate calls within the same agent run short-circuit; the cache is invalidated whenever any non-read-only tool succeeds.
- **Image generation (FLUX)** — text-to-image surface under a new "🎨 Images" sidebar entry. In-process `mistralrs-core` `FluxLoader` with the upstream BFL repos (`schnell` for fast 4-step gens, `dev` for higher-quality 28-step gens; `dev` requires a HuggingFace license accept). Canvas-left layout + vertical thumb strip + sticky composer. Per-conversation gallery filter chip (All / This chat / Standalone). Generated PNGs are persisted to `~/.local-llm-app/images/` with full provenance baked into PNG tEXt chunks (prompt, model, params, version) and a SQLite `images` table (migration v10). Six new IPCs (`image_generate`, paginated `image_list`, `image_get`, `image_delete`, `image_cancel`, `image_unload`, `image_save_to`).
- **`generate_image` agent tool** — the agent loop can drive FLUX directly; useful in workflows + "draw me X" turns. Long prompts (>~250 words) overflow `schnell`'s 256-token T5 cap → the tool's `dev` option is documented for those.
- **In-app right-click image menu** — WebKit's default context menu can't open new windows or download from `asset://` URLs, so the built-in actions were dead end-to-end on generated images. A custom floating menu (Open in Preview · Save image as… · Reveal in Finder · Copy file path · Send to current chat) replaces them, backed by two new Rust IPCs (`image_open_external`, `image_reveal_in_finder`) that shell `/usr/bin/open` after a path-safety check.
- **About You profile** — a local-only structured profile (name / occupation / location / about / response-style + an enabled toggle) injected as a system-prompt block into every chat and workflow agent run. Stored under `user_profile` in `settings.json`; never leaves the device.
- **Auto-continue at context limit** — when estimated context use crosses ~85% of the active model's window, a banner above the composer counts down 5 s, then summarizes prior turns via the active backend and forks the conversation into a fresh "Continued: …" child seeded with the summary as a system message. No more abrupt context overflows mid-thought.
- **Workflows canvas** — full agent-orchestration surface (card deck + table-top, drag/drop card connections, scheduled runs, explicit unattended opt-in). Lives under `src/components/workflows/`, `src/lib/workflow/`, `src-tauri/src/workflows.rs`. Migration v9 adds `workflow_card_fired.workflow_id` to fix a delete-by-LIKE prefix-collision bug.

### Changed
- Hamburger button pinned beside the macOS traffic lights; slides left into the freed corner when the window enters fullscreen (driven by a `data-fullscreen` attribute on `<html>`).
- `+ New chat` moved directly above the conversation search field.
- Header padding compacted to 10px above/below the model-picker row.
- Removed a dead `.sidebar-top > .new-chat` CSS rule and corrected several stale layout comments.
- An explicitly chosen agent preset now owns its tool scope; the General preset's empty `allowedTools` means full access, not parent inheritance.
- The agent system prompt now lists available MCP tools so the model knows they exist.
- Chat autoscroll now pauses when the user scrolls up to read, and resumes when they return to the bottom.
- The three backends now share one resolved per-backend chat config so agent behaviour is consistent across them (per-conversation params still override).
- Memory modes are relabelled to plain language (Off / Suggest / Review / Auto) without changing stored enum values.
- The duplicate model id is dropped from the header status text — status now reads backend + state only; voice dictation segments are space-joined and user-message bubbles use `pre-wrap` so original spacing survives.
- Settings writes are now atomic (temp file + rename).
- `ChatWindow` decomposed (~1300 → ~610 lines): the send pipeline moved into a `useChatSend` hook, the near-identical modals collapsed into one `ConfirmDialog`, and the agent toolbar, settings panel, and export menu extracted as components.
- One shared polite `aria-live` region; entrance motion gated behind `prefers-reduced-motion`; an accessibility pass adding dialog roles, Escape-to-close, `role="alert"` error banners, and icon-button labels.
- **Streaming scroll perf** — chat scroll no longer stutters during model streaming on long histories. `MessageList` was re-rendering the full row list every animation frame; pulled the row-list rendering and pin state into a memoized `<MessageHistory>` subtree so streaming-text updates re-render only the live bubble. The scroll container now sets `contain: layout paint` + `overscroll-behavior: contain`, the scroll listener is registered passively with a rAF-coalesced stick check, and autoscroll-to-bottom is throttled to every third rAF tick while streaming.
- **`ModelPicker` freshness** — the dropdown now re-lists models on `mousedown`/`focus` and on Library-modal close, so cloud-tagged Ollama models pulled via the CLI show up without an app restart.
- **Context-meter accuracy** — the meter pulls the real `context_length` from Ollama's `/api/show` (`Modelfile num_ctx` → `model_info[*.context_length]`), cached per `(backend, model)`. Heuristic regex stays as the fallback for MLX/native.

### Security
- **API keys moved to the macOS Keychain** — custom-backend API keys are stored in the Keychain instead of plaintext `settings.json`, with a one-time migration and redaction of keys from the settings blob returned to the webview.
- **SSRF redirect IP-pinning** — redirects are followed manually with the connection pinned to each hop's validated IP set, closing a DNS-rebinding TOCTOU. IPv4-mapped/compatible IPv6 literals and NAT64 ranges are now rejected.
- **Untrusted-content scanning** — `read_file`, `read_pdf`, `clipboard_get`, browser get-text, and the git read tools route through the injection-scan wrapper so file, clipboard, and repo content can't smuggle instructions to the model.
- **Citation-chip opens confined** — citation-chip file opens are now restricted to the workspace root and confirm the resolved path before opening; absolute/traversal paths are rejected.
- **Agent authorization tightened** — subagents no longer inherit the parent's blanket shell/write approvals, `spawn_subagent` is confirmation-gated, repo-supplied policy can't auto-approve `run_shell`/`applescript_run` (and a banner warns when one is in effect), and any `http_request` carrying a body is treated as elevated risk.
- Read-protected path list extended to credential files and browser profile directories (`.netrc`, `.npmrc`, `gh`/`gcloud` config, Chrome/Firefox/Safari profiles, the app's own settings file).
- MCP tool descriptions are sanitized before entering the system prompt; secrets are redacted from the tool audit log; raw MCP protocol lines are no longer logged.
- Inline images restricted to `data:image` sources (blocking remote image beacons); markdown URI policy handed to DOMPurify.
- Closed a symlink-write TOCTOU in agent fs; bounded child stdout reads, `kill_child`, and shutdown with timeouts.
- **MCP tools are now risk-classified and always require confirmation** — a malicious MCP server can't slip an auto-approved tool call past the user.
- A **consecutive-tool-error budget** stops the agent loop after repeated failures instead of burning every iteration.

### Fixed
- **Panel gap** — the sidebar and main panels rendered flush to the window's top edge instead of floating with an even inset. Root cause: `.main { height: 100vh }` forced the CSS grid row to full window height, overflowing `.app`'s padded content box and pinning both panels to the top. Switched to grid-stretch sizing (`.main` → `min-height: 0`, `.app` → `height: 100%` + uniform `padding: 12px`); all four panel gaps are now an even 12px.
- Suppressed the spurious "Switched to" model divider after fork or regenerate by keying it off the real last assistant turn.
- Guarded `run_shell` and `read_pdf` truncation against panicking on a non-UTF-8 char boundary.
- `delete_message` now emits the real conversation id so detached windows refresh after a delete.
- Fixed the ModelPicker desired-model restore race; the memory count badge refreshes while the panel is closed; the recall threshold is clamped.
- RagPanel colors that were unreadable in light mode are fixed.
- **In-flight image-gen survives tab nav** — `useImageGeneration` lived inside `ImageView`, so switching tabs unmounted the hook and silently dropped the `image-done` event mid-run (Rust kept generating, PNG landed in DB, UI forgot it was running). Hoisted to `App` so the Tauri event listeners are App-lifetime; the spinner persists across tab swaps and the gallery picks up the finished PNG on re-mount.
- **FLUX dev errors now surface** — `mistralrs`'s `handle_pipeline_forward_error!` macro routes image-gen failures through `Response::CompletionModelError`, not `ModelError`. Without the arm, dev-tier failures showed `"diffusion response channel closed"` instead of the real cause (HF 401, T5 cap, OOM). Added the arm + a `humanize_diffusion_error` helper that translates those into actionable copy ("Accept the license at hf.co/…", "Prompt exceeds 256 T5 tokens — try `dev`", etc.).
- **Migration v9 safety** — `ensure_card_fired_workflow_id_column` now calls `ensure_workflow_tables(conn)` first; existing v8 DBs that hadn't yet seen the `workflow_card_fired` table no longer fail the migration with a missing-table error.
- **`scripts/release.sh` bash 3.2 compat** — replaced a bash-4 `declare -A` associative array with a `mktemp` tempdir of per-log size files; macOS ships bash 3.2 and was erroring out at `"declare: -A: invalid option"`.
- **WorkflowCanvas card sizing** — added `initialWidth`/`initialHeight` + a `measuredRef` cache; React Flow needs measured dimensions before edges render, and without these the cards rendered invisible.
- **`ContextRolloverBanner` gate** — the auto-continue countdown no longer fires while the backend is stopped; added a `backendReady = status?.running && status.model` gate.

### Internal
- Large maintainability refactor (no behavior change): `lib.rs` split into a thin `run()`/`setup()` file plus a `commands/` module tree; `mlx_server.rs` renamed to `backend_process.rs`; new `util.rs` for shared helpers; `ChatWindow` decomposed into hooks under `src/hooks/`; `ModelBrowser` decomposed into `src/components/model-browser/`; `dispatch.ts` split into `url-safety.ts`/`dry-run.ts`/`diff.ts`; `App.css` split into per-concern files under `src/styles/`.

## [0.11.0] — 2026-05-21

### Added
- **ModelBrowser Ollama tab → full library view** (clones `ollama.com/library`). New Rust `ollama_library_fetch` cmd scrapes the page (resilient `scraper`-crate selectors, 10-min in-memory cache, SSRF-pinned + custom UA). Per card: bold name, 2-4 line description, colored capability chips (`vision` orange, `tools` blue, `thinking` purple, `audio` teal, `cloud` green, `embedding` yellow, sizes slate), ↓ pulls + 🏷 tags + relative-updated metadata. Top filter chips (Cloud / Embedding / Vision / Tools / Thinking) multi-select intersection. Sort dropdown (Popular / Newest / Updated). Falls back to curated `OLLAMA` array w/ yellow banner if scrape fails. New `scraper = "0.20"` dep.
- **ModelBrowser HuggingFace tab → full library view** (clones `huggingface.co/models`). Lazy-loaded chunk. Left sidebar w/ collapsible filters: Tasks, Parameters (2-thumb range slider), Libraries, Apps, Inference Providers. Main pane: live total-count from `x-total-count` header, debounced filter-by-name, "Inference Available" toggle, 5-option sort, responsive 1/2-col card grid. Action button auto-routes: `mlx` → Pull, `gguf` → "View files" (jumps to GGUF tab pre-filtered), other → "Open on HF ↗". Apps + Inference Providers + param slider are client-side filters (HF API has no direct params); banner notes this when active. "Load more" pagination.

### Fixed (regressions from UI redesign)
- `e2e/memory-save.spec.ts`: opens Menu → Memories modal then closes it before pressing Send (v0.10.7 modal overlay otherwise intercepted clicks).
- `e2e/model-download-flow.spec.ts`: new HF library view aliases the search input + card testid (`model-search` + `hf-model-card`) for back-compat.

### Tests
- Rust: **87 passing** (was 82). +5 Ollama HTML parser (3+ cards, capability/size extraction, K/M/B pulls conversion, malformed HTML returns empty).
- Vitest: **172 passing** (was 155). +5 OllamaLibraryView, +5 HuggingFaceLibraryView component, +7 HF loader.
- Playwright: **11 passing** (regressions fixed).
- **Grand total: 270 tests.**

## [0.10.9] — 2026-05-21

### Changed
- Stack sidebar actions vertically: `☰ Menu ▾` now sits directly under `📊 Dashboard` instead of side-by-side.

## [0.10.8] — 2026-05-21

### Changed
- **Sidebar layout**: `Dashboard` button + `☰ Menu ▾` dropdown moved from the chat-header back into the sidebar — now sits as its own row above the conversation search box.
- **Theme toggle relocated**: light/dark `☀` / `☾` button moved out of the sidebar `+ New chat` row to the far right of the model-picker bar (`margin-left: auto`). Header is now `display: flex` so right-alignment works cleanly.

## [0.10.7] — 2026-05-21

### Changed (UI redesign — Claude-Code-inspired shell)
- **App shell w/ inner gap**: sidebar + main are now rounded panels inside a soft-gradient outer frame (6 px inset, 12 px corner radius, subtle border). Matches the "panel-in-panel" elegance seen in Claude Code's interface.
- **Top-bar action menu**: `Dashboard` button + `☰ Menu ▾` dropdown moved into the chat header (next to the model picker). Dropdown items: **Memories**, **Branches** (when a conversation is selected), **Diagnostics**, **Re-run setup wizard**. Closes on blur / item-click.
- **Memories now opens as a centered modal overlay** instead of an always-mounted sidebar panel. Click outside or the `×` to dismiss.
- Sidebar collapses to its core role: New chat + theme toggle + search + conversation list.

## [0.10.6] — 2026-05-21

### Added
- **Per-conversation model memory**: clicking an old conversation in the sidebar now restores the model that was used in it (already persisted to `conversations.model` since v0.1.x — frontend wiring landed here). `ModelPicker` accepts a new `desiredModel` prop, preselects the matching local model on conversation switch, and silently falls back if that model is no longer installed (stale config doesn't pollute the picker). Skips the swap when a model is already running so an active stream isn't yanked.

## [0.10.5] — 2026-05-21

### Fixed
- **CRITICAL — markdown render crash on every link** (`"undefined is not an object (evaluating 'this.parser.parseInline')"`). Our custom `renderer.link` override mounted via `marked.use({ renderer })` called the default marked Renderer.link via `.bind(renderer)`. Marked v18's default link renderer does `this.parser.parseInline(tokens)`, but our standalone Renderer instance never had `parser` attached — so any markdown containing a link crashed the entire React tree, leaving a black window (the "reload fixes it" wedge that v0.10.4's ErrorBoundary first exposed). Removed the override entirely — the same `target="_blank"` + `rel="noopener noreferrer"` behaviour is already applied by DOMPurify's `afterSanitizeAttributes` hook below.

### Tests
- New `src/lib/__tests__/markdown-links.test.ts` — 4 regression cases pinning the v0.10.5 fix (link renders, target+rel applied, javascript: stripped, multi-link mixed content doesn't throw). Vitest: 155 passing (was 151).

## [0.10.4] — 2026-05-21

### Added
- **`<ErrorBoundary>`** wrapping App / QuickPrompt / DetachedChatView in `main.tsx`. Catches render-phase + lazy-chunk module errors that previously unmounted the whole React tree → black window (the "right-click → reload" workaround). Now shows an inline retry card and funnels the error to the Diagnostics panel.

### Fixed (audit follow-up)
- **F-H3 streaming perf regression**: `App.tsx` inline `onFork={async ...}` busted `MessageRow` (`React.memo`) on every parent render — during streaming, one re-render per rAF frame. Wrapped `onForked`, `onConversationCreated`, `onMemoriesChanged` in `useCallback` so identity is stable.

## [0.10.3] — 2026-05-21

### Added
- **"All HuggingFace" tab in ModelBrowser**: broad text-generation search across HF with no author/library pin. Pipeline-filtered to `text-generation` so vision/audio repos don't pollute the picker. Each card auto-detects format from tags + routes the action button:
  - MLX repos → `Pull` (existing flow, same as MLX tab)
  - GGUF repos → `View GGUF files` (jumps to GGUF tab pre-filtered to that repo)
  - safetensors-only → `Open on HF ↗` (external link, no in-app download)
  Sits alongside the existing `HuggingFace MLX` and `HuggingFace GGUF` tabs.

## [0.10.2] — 2026-05-20

### Fixed
- **Huge-model cold-load aborted prematurely**: `STREAM_CONNECT_TIMEOUT_MS` was 30s. Models ≥30 GB take longer than that to load in MLX before producing the first byte, so the timeout fired → fetch aborted → chat showed `[stopped before response]` even though user didn't click Stop. Bumped to 5 min and now explicitly `clearTimeout` the moment fetch headers arrive (was only cleared on abort). Streaming itself remains unbounded — token gaps don't trip it.

## [0.10.1] — 2026-05-20

### Added (v2.0 batch B — v2.0 sprint complete)
- **First-run setup wizard**: detects available backends (Native/MLX/Ollama probe), guides install of missing OR pick existing, recommends starter model per backend, lands user in sample chat w/ pre-filled prompt. Gated on `setup_complete` settings field; "Re-run setup wizard" button in sidebar for manual trigger. Heuristic: existing users w/ `last_model` set skip the wizard (auto-marks complete). Four new Tauri cmds (`setup_complete_get`/`set`, `mlx_probe`, `ollama_probe`). New `SetupWizard.tsx` (519 LOC, lazy-loaded). Recommendations live in TS so tweakable w/o recompile.
- **Standardized destructive confirms**: new `src/lib/use-two-click-confirm.ts` hook (first click arms 4s timer + flips label to "Click again to confirm", second click invokes). Wired into App.tsx conversation delete, MemoryPanel memory delete, McpSettings server remove, RagPanel corpus delete, MessageList fork-from-here. 5 broken `confirm()` call sites eliminated. Zero `window.confirm(`/`confirm(` calls remain in `src/`.
- **Bundle code-split**: React.lazy + Suspense around Dashboard, AuditLog, RagPanel, PromptLibrary, ForkTree, ModelBrowser, DiagnosticsPanel, SetupWizard. Main chunk **588 → 514 kB** (−12.6%, −19 kB gzip). 8 lazy chunks emitted. Markdown pipeline (highlight.js + 18 langs) remains main-chunk-bound since MessageList needs it for first paint.

### Tests
- Rust: **82 passing** (+1 setup_complete round-trip).
- Vitest: **151 passing** (+3 wizard, +5 two-click hook).
- Playwright: **11 passing** (mock updated for setup_complete_get).
- **Grand total: 244 tests.**

### v2.0 sprint complete (6/6)
| # | Item | Shipped |
|---|---|---|
| 28 | GGUF picker (llama.cpp Phase 3) | v0.10.0 |
| 29 | CI matrix (llama.cpp Phase 4) | v0.10.0 |
| 32 | Diagnostics panel | v0.10.0 |
| 30 | First-run setup wizard | v0.10.1 |
| 31 | Standardize destructive confirms | v0.10.1 |
| 33 | Bundle code-split | v0.10.1 |

## [0.10.0] — 2026-05-20

### Added (v2.0 batch A)
- **GGUF picker (llama.cpp Phase 3)**: new `hf-gguf` source in ModelBrowser. Browse HuggingFace GGUF repos via `library=gguf` (no `mlx-community` author filter). Click repo to expand → fetches `https://huggingface.co/api/models/{repo}/tree/main` → lists `.gguf` files w/ size + quant suffix. Per-file download button → new Rust cmd `native_download_gguf(repo, filename)` streams to `~/Library/Application Support/.../models/gguf/{repo}/{filename}` with Range-resumable + progress events + in-flight dedupe. New `native_list_gguf_files` + `native_delete_gguf` cmds. "Installed (GGUF)" subsection w/ two-click Remove. Path-safety: filename validators (no `..`/`\0`/non-`.gguf`), repo validators (org/name shape, alnum+`._-`), canonical-path containment check before any write/delete.
- **CI matrix + cross-platform binaries (llama.cpp Phase 4)**: rewrote `.github/workflows/release.yml` w/ 4-target matrix:
  - `macos-14 / aarch64-apple-darwin / native-mistralrs` → DMG + signed updater (matches `release.sh` output shape)
  - `macos-13 / x86_64-apple-darwin / native-llamacpp` → DMG
  - `ubuntu-22.04 / x86_64-unknown-linux-gnu / native-llamacpp` → AppImage + deb
  - `windows-2022 / x86_64-pc-windows-msvc / native-llamacpp` → NSIS installer
  Publish job aggregates artifacts + writes a 4-platform `latest.json` updater manifest. Tauri 2 Linux deps + Windows LLVM/clang setup researched + documented inline. Workflow ready for next `v*` tag push.
- **Diagnostics panel**: new in-app surface for previously-silent errors. New `src/lib/diagnostics.ts` (ring buffer cap 500, localStorage persists last 100, pub/sub). New `DiagnosticsPanel.tsx` modal (filter by level/source, sort, copy-for-bug-report, two-click clear). Wired 52 `logDiag()` calls into formerly silent `catch{}` / `.catch(() => {})` blocks across `App.tsx`, `memory-client.ts`, `agent-loop/dispatch.ts` + `subagent.ts` + `ollama-client.ts`, `McpSettings.tsx`, `ChatWindow.tsx`, `QuickPrompt.tsx`, `MemoryPanel.tsx`, `MessageList.tsx`. New `src-tauri/src/diagnostics.rs` bridges Rust warnings → frontend via `app-diagnostics` Tauri event. Recovery behavior unchanged — purely observational.

### Fixed
- `ModelBrowser.refreshGgufInstalled` crashed when `nativeListGgufFiles` returned null (default mock fallback). Added `Array.isArray()` guard.

### Tests
- Rust: **81 passing** (was 72). +6 GGUF validators, +3 diagnostics.
- Vitest: **143 passing** (was 129). +3 GGUF tab, +7 diagnostics store, +4 diagnostics panel.
- Playwright: **11 passing** (unchanged).
- **Grand total: 235 tests across 3 runners.**

## [0.9.18] — 2026-05-20

### Fixed
- **Model Library "Remove" button did nothing**: `window.confirm()` is disabled in Tauri 2 webview — sync dialogs return undefined → `remove()` exited early. Replaced with two-click inline confirm: first click arms (button label → "Click again to confirm", 4s timer), second click within window deletes. No dialog plugin dep added.

## [0.9.17] — 2026-05-20

### Fixed (full code-review pass)
- **CRITICAL — startup panic in v0.9.15**: `tauri.conf.json` had `"global-shortcut": {}` left by the menu-bar quick prompt feature. Tauri 2's plugin config expected `null` (unit). Removed the entry; the plugin self-registers from Rust at runtime. App now boots clean.
- **`McpSettings.tsx` + `RagPanel.tsx` null-guard**: list-endpoint Tauri calls now `Array.isArray()`-guard the response. Previously a null return from the backend crashed the panel render on `null.length`.
- **`mistralrs_backend.rs`**: removed redundant closure wrap + unneeded `mut` on `on_chunk` param (clippy `--features native-mistralrs --all-targets -D warnings` now clean).
- **`cargo fmt`** drift fixed across 28 files touched during sprint (browser.rs, fs_watcher.rs, mcp/mod.rs, memory.rs, native_inference/*, quick_prompt.rs, rag.rs, etc.).

### Verified
- `cargo check` clean for: default, `native-mistralrs`, `browser-automation`.
- `cargo clippy --all-targets -D warnings` clean for: default, `native-mistralrs`, `browser-automation`.
- `cargo test`: **72 passed** (default), **73 passed** (`browser-automation`).
- `npx tsc --noEmit`: clean.
- Vitest: **129 passed** across 24 files.
- Playwright: **11 passed**.
- **Grand total: 212 tests** — all green.
- Tool wiring audit: 46 unique tool schemas in `tools.ts`, 51 dispatch cases in `dispatch.ts` (extras for subagent + MCP routing + fallback). All schemas have matching dispatch routes.

## [0.9.15] — 2026-05-20

### Added (v1.3 batch B — v1.3 sprint complete)
- **Conversation branching**: fork from any user message → new conversation with messages up to cutoff deep-copied. Idempotent SQLite migration adds `parent_conv_id` + `parent_message_id` columns. Three Tauri cmds (`conversation_fork`, `conversation_list_branches`, `conversation_fork_tree`, depth-cap 10). "🌿 Fork from here" button on each user message in MessageList. Sidebar indents children under parent w/ `↳` marker. New "🌳 Branches" button opens `ForkTree.tsx` modal w/ click-to-select tree view.
- **Menu-bar quick prompt**: `Cmd+Shift+L` global hotkey + tray menu item open a 600×120 frameless always-on-top window centered on screen. Auto-focused textarea, Enter to submit, Shift+Enter newline, Esc to hide. Streams response via MLX or Ollama (whichever is default). Strict ephemeral — no DB writes, no memory recall. Main window flashes "Quick reply ready ↗" toast on completion. Added `tauri-plugin-global-shortcut = "2"`.
- **Multi-window mode**: detach any conversation into its own window via `⧉` button next to each sidebar row. New Tauri cmds `open_conversation_window(conversation_id, title?)` (dedup-by-label so double-click focuses existing) + `list_open_conversation_windows`. `main.tsx` branches on `?detached=1&conversation_id=N` URL → renders `DetachedChatView` instead of full App. Cross-window sync via `conversation-updated` Tauri event emitted after `add_message`/`delete_message`. Each window has its own React tree; no state-management lib.

### Fixed
- `QuickPrompt.test.tsx` vi.mock hoisting bug (`Cannot access 'invokeMock' before initialization`) — wrapped mock setup in `vi.hoisted()`. Also fixed textarea-value React-tracking issue by using the native setter so `onChange` fires correctly.

### v1.3 sprint complete (6/6)
| # | Item | Shipped |
|---|---|---|
| 23 | Prompt library + slash commands | v0.9.14 |
| 24 | Multi-modal vision input | v0.9.14 |
| 26 | Usage dashboard | v0.9.14 |
| 22 | Conversation branching | v0.9.15 |
| 25 | Menu-bar quick prompt | v0.9.15 |
| 27 | Multi-window mode | v0.9.15 |

### Tests
- Rust: **72 passing** (was 67). +3 fork, +2 multi-window.
- Vitest: **129 passing** (was 112). +4 fork, +10 detached-params, +3 QuickPrompt.
- Playwright: **11 passing** (unchanged).
- **Grand total: 212 tests across 3 runners.**

## [0.9.14] — 2026-05-20

### Added (v1.3 batch A)
- **Prompt library + slash commands**: 5 built-in templates (`/explain`, `/refactor`, `/test`, `/summarize`, `/commit`) + user-defined custom templates. Slash autocomplete in ChatInput w/ ArrowUp/Down/Enter/Tab/Esc nav. Variable extraction (`{foo}` → `[foo]` placeholders w/ first-placeholder auto-select). New `PromptLibrary.tsx` modal manager (book-icon button next to mic): list/add/edit/delete custom, hide/unhide built-ins. Persisted to `localStorage["prompt.templates"]` + `localStorage["prompt.templates.hiddenBuiltIns"]`. Custom override built-in via same trigger.
- **Multi-modal vision input**: drag-drop image overlay in ChatInput (PNG/JPG/WebP). Max 4 images per message, max 4 MiB each, EXIF stripped via Canvas re-encode to PNG. Capability gating via `modelSupportsVision()` (heuristic patterns: `llava`, `vision`, `qwen2-vl`, `gemma-3`, `minicpm-v`, `pixtral`). New `messages.images_json` SQLite column (idempotent migration). Ollama path emits `{role, content, images: [base64]}` (raw base64, no `data:` prefix). MLX path wraps in OpenAI multi-content array `[{type:"text"}, {type:"image_url", image_url:{url:"data:..."}}]`. Native path deferred (mistralrs IPC bridge needs Rust-side struct change).
- **Usage dashboard**: 5-section modal accessible via 📊 button next to Memories. (1) Top 15 tools bar chart, (2) per-tool latency p50/p95/max sortable table, (3) agent iteration histogram, (4) tok/s throughput line chart, (5) approval source pie (auto/session_allowed/user_allowed/denied/dry_run). Window selector (1h/24h/7d/all) + 30s auto-refresh. All charts inline SVG, zero deps. New SQLite table `agent_session_metrics` (idempotent migration). Runner records one row per `runAgentLoop` execution in a `finally` block — completion/abort/throw/iter-cap all captured. Backend percentile computation in Rust.

### Tests
- Rust: **67 passing** (was 64). +1 multi-modal migration, +2 dashboard schema/aggregation.
- Vitest: **112 passing** (was 78). +18 prompt-templates, +4 ChatInput slash autocomplete, +2 model-capabilities, +5 vision-payload, +3 Dashboard render.
- Playwright: **11 passing** (unchanged).
- **Grand total: 190 tests across 3 runners.**

## [0.9.13] — 2026-05-20

### Added (v1.2 batch B — v1.2 sprint complete)
- **Project RAG**: drag-drop folder → walk → chunk (512-char w/ 64-char overlap, UTF-8 safe) → embed (feature-hashed TF-IDF, 512-dim L2-normalized; ONNX BGE-small deferred to v1.3) → SQLite vector store (`rag_corpora` + `rag_chunks` tables). New agent tool `search_project_knowledge(corpus_name, query, top_k)` returns ranked chunks. Four Tauri cmds (`rag_ingest_folder`/`search`/`list_corpora`/`delete_corpus`). New `RagPanel.tsx` UI: list corpora, ingest form, delete, debug search. File-size cap 2 MB; max 200k chunks per ingest. Walker skips `.git`/`node_modules`/`target`/etc. + hidden dirs + symlinks. Re-ingest of same corpus name replaces all chunks. Tool count: 45 → 46.
- **Memory scopes**: every memory belongs to one of `global` / `project` / `conversation`. Idempotent SQLite migration (`PRAGMA table_info` detect → ALTER) adds `scope TEXT NOT NULL DEFAULT 'global'` + `project_root TEXT`. Legacy data migrates to `global`. `MemoryContext { workspace_root, conv_id }` threads through `recall_memories` so search post-filters by scope. Three new Tauri cmds (`memory_promote`/`demote`/`set_context`). `MemoryPanel.tsx` gains G/P/C badges + filter chips + per-row ↑/↓ buttons. Pin-to-memory in `MessageList.tsx` gets a scope dropdown (defaults to conversation). Drive-by clippy fix in `rag.rs` (approx_constant lint) unblocked `--all-targets -D warnings`.

### v1.2 sprint complete (4/4)
| # | Item | Shipped |
|---|---|---|
| 20 | Inline file citations | v0.9.12 |
| 21 | Markdown export modes | v0.9.12 |
| 18 | Project RAG (TF-IDF) | v0.9.13 |
| 19 | Memory scopes | v0.9.13 |

### Tests
- Rust: **64 passing** (was 56). +5 RAG, +3 memory scopes.
- Vitest: **78 passing** (was 70). +4 RAG dispatch + 2 memory scopes UI + 2 RAG panel.
- Playwright: **11 passing** (unchanged).
- **Grand total: 153 tests across 3 runners.**

### Tool count
45 → **46** (+1 search_project_knowledge).

## [0.9.12] — 2026-05-20

### Added (v1.2 batch A)
- **Inline file citations**: paths inside `` `code` `` spans matching `…/file.{rs,ts,tsx,…}(:line)?` get chip-ified post-DOMPurify (XSS-safe via `document.createElement` + `textContent`). Click → `agent_open_path_in_editor(path, line)` which tries `code --goto path:line` → `cursor --goto path:line` → `open path`. Path safety: must be absolute or `~/…`, canonicalized, must live under `$HOME`/`/tmp`/`/Volumes`. `/etc/*` etc. rejected. Session-scoped `citedPathsByConv` Map tracks paths from `read_file` outcomes (consumed by future plain-text trigger). Fenced code blocks untouched — only inline code.
- **Markdown export modes**: Export button is now a split-button dropdown ("Plain Markdown" / "Detailed Markdown"). Detailed mode renders each tool call as a GitHub-flavored `<details>` block with pretty-printed JSON args + 500-char-capped result body. Filename suffix `-detailed.md` distinguishes the two. Plain mode strictly user + assistant prose (drops tool envelopes entirely).

### Tests
- Rust: **56 passing** (was 51). +5 `open_path_in_editor` (relative/.. /nonexistent/protected/allowlist helper).
- Vitest: **70 passing** (was 55). +8 citation chip (path:line wrap, URL not wrapped, bare filename ignored, fenced code untouched, XSS-safe), +7 export modes.
- Playwright: **11 passing** (was 10). +1 detailed-export filename + content.
- **Grand total: 137 tests across 3 runners.**

## [0.9.11] — 2026-05-20

### Added (v1.1 final batch)
- **Dry-run mode**: checkbox in agent settings + yellow chat-header banner. When ON, `write_file`/`edit_file`/`multi_edit`/`run_shell`/`applescript_run`/`browser_navigate`/`browser_click`/`browser_fill` short-circuit in frontend dispatch shim — return `{ok:true, dry_run:true, would_*: ...}` (incl. in-memory unified diff for edits) without invoking Tauri. Read-only tools execute normally. `browser_navigate` still runs SSRF preflight in dry-run (rejected URLs report `blocked_by_safety` reason). Audit log records every dry-run with `outcome: "dry_run"` for visibility. Persisted to `localStorage["agent.dryRun"]`.
- **llama-cpp-2 backend (Phase 2 of cross-platform Native rollout)**: behind new `native-llamacpp` Cargo feature (default off). `chromiumoxide`-style optional dep. `LlamaCppRuntime` implements `NativeBackend` trait. Local GGUF path loading; HF repo download deferred to Phase 3. ChatML fallback prompt rendering; sampler chain (top-p + temp + dist). `compile_error!` if both `native-mistralrs` + `native-llamacpp` enabled. Feature flag scheme: `native-inference` (umbrella) ← `native-mistralrs` (macos-aarch64) / `native-llamacpp` (cross-platform). `release.sh` switched from `--features native-inference` to `--features native-mistralrs`. Default + mistralrs `cargo check` clean. Real-world native-llamacpp build deferred (cmake compile of llama.cpp takes 3-6 min on M-series).

### v1.1 sprint complete
| # | Item | Shipped |
|---|---|---|
| 11 | Tool-call audit log | v0.9.9 |
| 12 | Per-project policy | v0.9.9 |
| 13 | Prompt-injection scan | v0.9.9 |
| 15 | Parallel subagents | v0.9.10 |
| 16 | Filesystem watcher | v0.9.10 |
| 17 | Browser automation | v0.9.10 |
| 14 | Dry-run mode | v0.9.11 |

### Tests
- Rust: **51 passing** (no change).
- Vitest: **55 passing** (was 37). +16 dry-run dispatch + 2 dry-run audit integration.
- Playwright: **10 passing** (unchanged).
- **Grand total: 116 tests across 3 runners.**

## [0.9.10] — 2026-05-20

### Added (v1.1 batch B)
- **Parallel subagents**: `spawn_subagent` accepts new optional `mode: "sync"|"async"`. Async returns `{subagent_id, status: "running"}` immediately. New `await_subagents(ids, timeout_seconds)` tool joins; new `list_subagents()` snapshot tool. `MAX_SUBAGENT_DEPTH=3` still enforced on both paths. Parent abort propagates to child via AbortController. Completed handles GC'd after 60s. Tool count: 33 → 35.
- **Filesystem watcher**: new `notify = "8"` + `globset = "0.4"` deps. Four tools: `watch_path(path, glob?, debounce_ms?)`, `poll_watch(id, since_ms?, max_events?)`, `stop_watch(id)`, `list_watches()`. Per-watch ring buffer 4096 events, overflow tracked in `dropped` counter. Auto-GC watchers after 30 min poll inactivity. Cleanup wired into `RunEvent::Exit`. NOT in DANGEROUS_TOOLS (read-only). Tool count: 35 → 39.
- **Browser automation** (behind `browser-automation` feature; default off — needs Chrome/Chromium): `chromiumoxide = "0.7"` + `futures-util`. Six tools: `browser_navigate`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_get_text`, `browser_close`. Persistent one-tab CDP session via `tokio::sync::Mutex<Option<Session>>`. All marked DANGEROUS (confirmation gated). SSRF preflight via shared `is_safe_public_host` + `resolve_to_safe_addrs` — blocks loopback / RFC1918 / `*.local` / `*.internal` / `file://` / `chrome://`. Auto-shutdown on `RunEvent::Exit`. +19.8 MB debug binary w/ feature; 0 MB default. Tool count: 39 → 45.

### Tests
- Rust: **51 passing** (was 42). +3 fs_watcher, +6 browser SSRF preflight (both feature configs).
- Vitest: **37 passing** (was 32). +5 parallel subagents.
- Playwright: **10 passing** (unchanged).
- **Grand total: 98 tests across 3 runners.**

### Tool count
33 → **45** (+12 in this release: +2 subagents, +4 fs watcher, +6 browser).

## [0.9.9] — 2026-05-20

### Added (v1.1 batch A)
- **Tool-call audit log**: every agent tool invocation persisted to SQLite (`agent_audit` table). Captures `ts, conversation_id, tool_name, args_json, result_hash` (sha256 first 16 hex chars), `result_size, duration_ms, approval, outcome, error_kind`. Four Tauri cmds (`agent_audit_record`/`list`/`purge`/`stats`). Args redaction client-side truncates `content`/`old_string`/`new_string` to 256 chars before IPC. Runner records every outcome branch (auto, session_allowed, user_allowed, denied, stall_guard, duplicate_call, policy_denied, error). New `AuditLog.tsx` UI: filterable table + 24h stats + purge control. Audit failures swallowed both sides — never breaks the agent loop. Added `sha2 = "0.10"` dep.
- **Per-project policy** (`.froglips/policy.json`): walks up from workspace cwd looking for the file. Schema: `allowed_shell_prefixes`, `allowed_write_paths`, `denied_write_paths`, `allowed_env_vars`, `auto_approve_dangerous_tools`, `max_iterations`, `notes`. Three Tauri cmds (`policy_load`, `policy_evaluate_shell`, `policy_evaluate_write`). Runner consults policy first in the confirmation gate: `auto` skips prompt, `denied` injects `policy_denied` tool result without executing. Green chip "Policy: project — <notes>" near agent toggle when active. Bad JSON → eprintln + treat as absent. Glob matcher (`*.key`, `secrets/`) in-file, no new crates.
- **Prompt-injection scan**: scans `web_fetch` / `web_search` / `http_request` / `read_pdf` / MCP tool results for injection patterns (ignore-previous-instructions, ChatML tokens `<|im_start|>`/`<|im_end|>`, Llama `[INST]`/`[/INST]`, `</s>`/`<s>`, role-mimic at line start, ≥500-space padding, repeated-token spam). Findings cap at 10. Wraps suspicious results with `[!] prompt_injection_warning: ...` header + `---BEGIN/END UNTRUSTED CONTENT---` markers. Pattern names in warning use U+00B7 middle-dot to avoid re-tripping detector on idempotent rescan. Defensive against malformed UTF-8 + huge inputs.

### Tests
- Rust: **42 passing** (was 13). New: 5 audit, 6 policy, 18 injection scan.
- Vitest: **32 passing** (was 17). New: 6 audit, 5 policy, 3 injection wrapper, +1 invariant.
- Playwright: **10 passing** (no change).
- **Grand total: 84 tests across 3 runners.**

## [0.9.8] — 2026-05-20

### Refactor
- **`native_inference.rs` split into trait + backend modules** (Phase 1 of cross-platform Native rollout). New layout:
  - `native_inference/mod.rs` — `NativeBackend` trait, `ModelRef::{HfRepo, GgufPath}`, `SamplingOpts`, `ChatMsg`, `native_enabled()`, cfg-gated dispatch.
  - `native_inference/mistralrs_backend.rs` — current mistralrs impl moved verbatim + `NativeBackend` trait impl. cfg = `all(feature="native-inference", target_os="macos", target_arch="aarch64")`.
  - `native_inference/stub.rs` — error stub for all other targets.
  - Phase 2 (add `llama-cpp-2` behind `native-llamacpp` feature), Phase 3 (GGUF picker UI), Phase 4 (CI matrix) tracked as follow-up tasks.

### Added
- **Playwright e2e suite** — 10 happy-path tests under `e2e/` driving the Vite dev server with a mocked `__TAURI_INTERNALS__` shim. Covers new chat, send/stream, agent tool dispatch, settings, model browser, agent confirm/deny, abort mid-stream, export, memory save, preset switch. `npm run e2e` exits 0 in ~2s. Test infra: `playwright.config.ts`, `e2e/fixtures/tauri-mock.ts`, 12 `data-testid` attrs added across 6 React components.

### Tests
- Rust: 13 passing (no change).
- Vitest: 17 passing (no change).
- Playwright: 10 passing (new).
- **Total: 40 tests across 3 runners.**

## [0.9.7] — 2026-05-20

### Added
- **Streaming agent loop**: agent mode now streams content + tool_calls progressively (NDJSON parse via `TextDecoderStream`, line-buffered, tool_call chunks merged by index). Renders into the in-flight assistant bubble. `callOllamaWithRetry` preserved as a compat wrapper. New `streamOllamaChat` in `ollama-client.ts`. `onAssistantDelta` opt threaded through runner → ChatWindow w/ rAF coalesce. +2.15 kB raw / +0.69 kB gzip.
- **MCP (Model Context Protocol) client**: spawn user-configured MCP servers via stdio, expose their tools as agent tools (prefixed `mcp__{server}__{tool}` to avoid collisions). Hand-rolled JSON-RPC 2.0 over stdio (~536 LOC in `src-tauri/src/mcp/mod.rs`), zero new crates. Six new Tauri commands: `mcp_start_server`, `mcp_stop_server`, `mcp_list_servers`, `mcp_list_tools`, `mcp_call_tool`, `mcp_server_stderr`. Settings persisted to `settings.rs`, auto-start on app launch, graceful shutdown on `RunEvent::Exit`. New `McpSettings.tsx` UI (list/add/remove/start/stop/restart/stderr). `runAgentLoop` fetches MCP tools once per run and merges into TOOLS dynamically. +9.22 kB raw / +1.9% gzip.

### Fixed
- `clippy::items_after_test_module` warning in `src-tauri/src/models.rs` — `dir_size` helper moved above test module so `cargo clippy --all-targets -D warnings` now passes (required for the CI gate added in v0.9.6).

### Tests
- TypeScript: 17 passing (5 baseline + 3 streaming + 7 MCP + 2 invariant updates).
- Rust: 13 passing (10 baseline + 3 MCP).

## [0.9.6] — 2026-05-20

### Refactor
- **`agent.rs` split**: 1874-LOC single file → `agent/` directory with 7 submodules (`fs.rs`, `shell.rs`, `web.rs`, `git.rs`, `system.rs`, `code.rs`, `mod.rs`). `pub use` re-exports preserve the `agent::*` public surface — `lib.rs` untouched. `cargo test` still 10/10.
- **`agent-loop.ts` split**: 1251-LOC single file → `agent-loop/` directory with 8 submodules (`tools.ts`, `runner.ts`, `dispatch.ts`, `ollama-client.ts`, `subagent.ts`, `types.ts`, `system-prompt.ts`, `index.ts` barrel). External imports unchanged.

### Added
- **Vitest** with first 5 unit tests (`tools.test.ts`, `stall-guard.test.ts`, `dedupe.test.ts`). `npm test` exits 0.
- **CI gate** at `.github/workflows/ci.yml`: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo audit`, `tsc --noEmit`, `npm test`, `npm run build`. Runs on every PR + push to main.
- **Roadmap research**: `docs/research/llamacpp-backend.md` — `llama-cpp-2` chosen for cross-platform Native backend (Phase 1 of v1.0 sprint).

## [0.9.5] — 2026-05-20

### Fixed
- **Agent stall on chunked file reads**: small-language models would call `read_file` with `limit: 300` (copied from schema example) and burn the whole iteration budget reading one file 200 bytes at a time. Three-part fix:
  - `agent.rs` clamps `limit` up to `MIN_READ_BYTES = 8_192` server-side.
  - `read_file` tool schema explicitly tells the model not to pass a small limit and documents the auto-raise floor.
  - `agent-loop.ts` tracks per-path read counts and trips a `stall_guard` after >6 reads of the same file, feeding the model a hint to stop chunking instead of silently looping.
- `MAX_ITERATIONS` raised 20 → 40 so larger files still fit when the agent legitimately needs pagination.

## [0.9.4] — 2026-05-20

### Security
- **TOCTOU between `lookup_host` and reqwest's connect-time resolve**: `web_fetch` + `http_request` now pin reqwest's DNS to the pre-validated IPs via `Client::builder().resolve_to_addrs(host, &[ip])`. The transport can no longer re-resolve to a new (unsafe) address between our pre-flight check and the socket open.
- **Social-engineering double-check on destructive tool calls**: agent-loop classifies `applescript_run` (`do shell script`, Finder delete, system shutdown/restart/logout, system-events keystroke/click, `with administrator privileges`) and `http_request` (DELETE/PUT/PATCH → destructive, POST+Authorization → privileged). New destructive checkbox in the confirmation modal must be ticked before Allow is enabled. State resets on every confirm.

## [0.9.3] — 2026-05-20

### Security
- **HIGH — SSRF via HTTP redirect**: replaced `redirect::Policy::limited(5)` with a custom policy that re-validates each hop's scheme + host against the SSRF allowlist. Affects `web_fetch` and `http_request`.
- **MEDIUM — DNS rebinding-class hosts**: added `assert_resolved_host_safe()` pre-flight `lookup_host` so names like `localtest.me` / `*.lvh.me` that resolve to loopback are caught before any socket opens.
- **MEDIUM — Response-body OOM**: `read_capped()` streams the body via `bytes_stream()` and bails at `WEB_FETCH_MAX_BYTES`. Previously `resp.bytes()` buffered the whole body before we truncated.
- **MEDIUM — AppleScript injection in `show_notification`**: sanitiser now swaps `"` → `'`, `\` → `/`, and any C0 control (newline / CR / tab / etc.) + DEL → space. Newline-based script-line truncation closed.

## [0.9.2] — 2026-05-20

### Fixed
- `looks_binary` only checked NUL bytes; ELF/Mach-O/PE/PNG/JPG were classified as text. Now scans first 8 KiB for NUL + C0 controls (except tab/LF/CR) + DEL. Caught by `cargo test`'s `looks_binary_detection`.

### Changed
- Removed unused `ask()` helper in ask_user.rs.
- `thread_local` SEED initialiser now const-able.
- `type EmbeddingMap` alias factored out of the verbose `Lazy<RwLock<Option<HashMap<i64, Vec<f32>>>>>`.
- 3× `.map_or(true, …)` → `.is_none_or(…)`.
- `push_str("…")` → `push('…')`.
- Removed `.map_err(|e| e)` no-op.

### Verified
- 71 Tauri commands ↔ 71 frontend invokes (set-equal).
- 33 tool defs ↔ 32 executeTool cases (subagent intentionally special-cased).
- 10/10 Rust unit tests passing.

## [0.9.1] — 2026-05-20

### Fixed
- User-message bubble: skip Markdown render pipeline (typed plain text doesn't need it), tighter padding + line-height. Single-line bubble height drops ~60 px → ~30 px.

## [0.9.0] — 2026-05-20

### Added — agent tools (10 → 32 total)
- `applescript_run` — osascript wrap (dangerous, requires approval).
- `http_request` — generic HTTP w/ method + headers + body, SSRF + Host-header guards.
- `find_definition` / `find_references` — heuristic regex code intelligence.
- `format_code` — prettier / rustfmt / black / gofmt / swift-format by extension.
- `task_create` / `task_status` / `task_list` / `task_cancel` / `task_prune` — fire-and-forget background shell tasks. New `task_queue.rs` module.
- `ask_user` — agent pauses, modal pops up in ChatWindow w/ a textarea, user submits answer, agent receives it. New `ask_user.rs` module + Tauri event-driven request/response.
- `spawn_subagent` — recursive agent run in isolated context, depth-capped at 3.

### Changed
- `ShellResult` gains `#[derive(Clone)]` so the task queue can snapshot task state.

## [0.8.0] — 2026-05-20

### Added — agent tools (10 → 23 total)
- `web_fetch` — GET + auto-HTML-strip. SSRF-protected (rejects loopback / RFC1918 / link-local / .local / .internal).
- `web_search` — DuckDuckGo HTML scrape, no API key.
- `git_log` / `git_show` / `git_branches` — read-only.
- `git_commit` — dangerous, requires approval.
- `read_pdf` — pdf-extract on a blocking thread.
- `screenshot` — macOS `screencapture -x`.
- `clipboard_get` / `clipboard_set` — pbpaste / pbcopy. `clipboard_set` dangerous.
- `open_app` — `open -a` w/ name regex validation. Dangerous.
- `show_notification` — osascript display-notification.
- New deps: `reqwest` (rustls), `base64`, `pdf-extract`, `html2text`.

## [0.7.4] — 2026-05-20

### Performance
- Streaming render rate coalesced via `requestAnimationFrame` — 100+ tok/s no longer thrashes the renderer.
- `memory.rs` placeholder build: `String::with_capacity` + `write!` instead of one `format!` per id. ~500 mini-allocs → 1.

## [0.7.3] — 2026-05-20

### Performance
- `MessageRow` + `StreamingMessage` + tool blocks wrapped in `React.memo`. Streaming chunks no longer re-render every prior message.
- Per-content Markdown cache w/ FIFO eviction.
- Stable `onRegenerate` handler via ref-pattern so memoized rows don't bust on each parent render.

## [0.6.3] — 2026-05-20

### Fixed
- Pinned model identity via authoritative system preamble — cloud tags (`deepseek-v4-pro:cloud`, `kimi-*:cloud`) no longer misidentify themselves on "what model are you?".

## [0.6.2] — 2026-05-20

### Security
- All Markdown rendered via `dangerouslySetInnerHTML` now sanitized through DOMPurify with a strict tag + attribute allowlist. `javascript:` / `vbscript:` / `data:` URIs blocked on anchors.
- `.gitignore` extended to cover common secret-file patterns (`.env*`, `*.key`, `*.pem`, `.tauri/`, etc.).
- CI now runs `npm audit` + `cargo audit` on every push (informational; will fail builds once baseline is clean).

## [0.6.1] — 2026-05-20

### Added
- First cross-platform release: GitHub Actions matrix builds for Linux (`.deb` + `.AppImage`) and Windows (`.msi` + `.exe`). Builds attached to the GitHub Release automatically on tag push.

### Fixed
- DMG bundling flake: `scripts/release.sh` now detaches stale hdiutil mounts before each build and retries once on failure.

## [0.6.0] — 2026-05-20

### Added
- Markdown rendering w/ syntax highlighting (highlight.js, 20+ languages registered).
- Light theme toggle in sidebar (☀/☾), persisted to settings.
- Conversation search bar in sidebar.
- Slide-out tool-history panel (⌖ Tools button) — shows every tool call w/ args + result, ok/err status.
- `release.yml` cross-platform CI workflow.

### Changed
- `scripts/release.sh` pkill filter narrowed to `Contents/MacOS` so bundle_dmg.sh isn't killed mid-stream.

## [0.5.0] — 2026-05-20

### Added
- MIT LICENSE, CHANGELOG, SECURITY, CONTRIBUTING files.
- GitHub Actions CI: `cargo test`, `cargo clippy -- -D warnings`, `tsc --noEmit`.
- Rust unit tests for `agent.rs` (path validation + classify_shell_risk) and `models.rs` (delete_mlx_model containment).
- Embedding cache now LRU-bounded at 10 000 entries.
- HTTP fetches to Ollama use a 60 s `AbortSignal.timeout` to avoid wedges.
- New agent tools: `git_status`, `git_diff`, `multi_edit` (atomic multi-replace).
- `search_files` supports a `regex` flag.
- `read_file` detects non-UTF8 content and returns `{kind: "binary"}` instead of garbled lossy text.
- `edit_file` confirm dialog now shows a unified diff preview before approval.
- Memory: edit-in-place, JSON export/import, configurable embedding model + recall threshold, per-memory tag editing.
- `formatRecallBlock` now escapes `<`, `>`, and Unicode RTL/control marks against prompt injection.
- Settings file persists last_model, memory_mode, active_preset, embedding_model, recall_threshold, window_size, and window_position.
- Window position + size restored on startup.
- Keyboard shortcuts: Cmd+N (new chat), Cmd+K (model picker), Cmd+, (settings), Cmd+L (model library).
- Conversation export to Markdown (per-conversation, includes timestamps + tool calls).
- Copy + Regenerate + Edit-and-retry actions on assistant messages.
- Syntax highlighting in code blocks via shiki.
- Installed tab: filter chips by tag, sort options (size/name), total disk usage summary.
- HuggingFace MLX tab paginated beyond first 100 results.
- ModelBrowser catalog data extracted to `src/lib/catalog.ts`.
- Light theme toggle.

### Changed
- `lib.rs` Tauri commands split into `commands/{server,conv,memory,agent,models}.rs`.
- `ChatWindow.tsx` split: `<AgentSettingsPanel>` and `<AgentConfirmModal>` extracted.
- `MessageList` items wrapped in `React.memo` to skip re-render on streaming updates.

### Fixed
- DMG bundling: build now ships with `targets: ["app", "updater"]` by default; DMG produced via separate manual step.
- mlx_lm.server stderr now surfaced to UI on failure (no more silent "stopped" with no reason).

## [0.4.1] — 2026-05-20
- Model Library tabs replaced with a labeled dropdown source selector.

## [0.4.0] — 2026-05-20
- Installed tab in ModelBrowser, with delete buttons for pulled Ollama + MLX models.
- Inline ✓ installed badge + Remove button on catalog cards.
- Civitai data expanded: updatedAt, comment + favorite counts, SHA256, availability, mode.
- `kimi-k2-thinking:cloud` added to Ollama curated catalog.
- Backend: `delete_ollama_model`, `delete_mlx_model` (canonicalized rm -rf w/ containment guard).

## [0.3.0] — 2026-05-20
- Workspace root persisted to settings.json, restored on startup.
- Shell cancellation: per-op AbortHandle map, cancelActiveShell wired to user abort.
- Token tracking from Ollama `prompt_eval_count` + `eval_count`.
- Command-prefix approve-all via "remember this pattern" checkbox.
- Agent presets: General / Coder / Researcher / Shell (dropdown in toolbar, persisted).
- Auto-updater via tauri-plugin-updater + GitHub Releases.
- `scripts/release.sh`: kill app, build, install, codesign ad-hoc, refresh Desktop alias.

## [0.2.0] — 2026-05-20
- Agent layer maturation across security, capability, loop, UX.
- New agent tools: edit_file, search_files, file_exists.
- read_file pagination, list_dir truncation signal, structured ToolError enum.
- Optional workspace root sandbox + canonicalized path validation.
- classify_shell_risk heuristic + red-banner destructive confirm.
- Agent settings panel: workspace picker, per-conversation allowlist, session approve-all toggles.
- Dynamic system prompt injecting workspace + OS + tool list.
- Dedupe, retry, live metrics (iterations, tool calls, latency, retries).

## [0.1.1] — 2026-05-19
- `ensure_path_for_gui()` extends PATH at startup to fix "ollama not found on PATH" when launched from Finder/Dock.

## [0.1.0] — 2026-05-19
- Initial public release: Tauri 2 + React 19 + Rust desktop app.
- MLX + Ollama backends, conversation history, memory system, agent mode skeleton, model library w/ HF + Civitai search.
