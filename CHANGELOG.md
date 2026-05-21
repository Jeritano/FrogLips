# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

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
