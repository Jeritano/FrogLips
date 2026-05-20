# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

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
