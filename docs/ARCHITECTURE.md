# Architecture

Froglips is a Tauri 2 app with a Rust core, a React 19 + TypeScript frontend, and three backends:

1. **Ollama** — external daemon at `127.0.0.1:11434`, HTTP IPC
2. **MLX** — `mlx_lm.server` Python subprocess, HTTP IPC
3. **Native** — `mistralrs-core` + candle + Metal kernels embedded directly in the Tauri Rust process (no subprocess, no HTTP, no Python)

## High-level diagram

```
┌────────────────────────────────────────────────────────────────┐
│                       Froglips.app                             │
│  ┌───────────────────────┐    ┌─────────────────────────────┐  │
│  │   Frontend (React)    │◀──▶│   Tauri Core (Rust)         │  │
│  │   src/                │IPC │   src-tauri/src/            │  │
│  │                       │    │                             │  │
│  │  ChatWindow + hooks/  │    │  lib.rs   (run/setup only)  │  │
│  │  ModelBrowser + tabs/ │    │  commands/ (IPC adapters)   │  │
│  │  ModelPicker          │    │  agent/   (tools + sandbox) │  │
│  │  MemoryPanel          │    │  history.rs (SQLite + mig.) │  │
│  │  MessageList          │    │  memory.rs (embeddings)     │  │
│  │  ChatInput            │    │  models.rs (list + delete)  │  │
│  │  ParamsPanel          │    │  backend_process.rs (procs) │  │
│  │  ImageView + image/   │    │  image_gen/ (FLUX pipeline) │  │
│  │  WorkflowsPage        │    │  workflows.rs (scheduler)   │  │
│  │  AboutYouModal        │    │  data_backup.rs (export)    │  │
│  │  DiagnosticsPanel     │    │  crash_log.rs / logging.rs  │  │
│  │  lib/agent-loop/      │    │  settings.rs (persistence)  │  │
│  │  lib/memory-client.ts │    │  util.rs (shared helpers)   │  │
│  │  lib/mlx-client.ts    │    │  + tauri-plugin-updater     │  │
│  └───────────────────────┘    └─────────────────────────────┘  │
└────────────────────────┬───────────────────────────────────────┘
                         │ HTTP (OpenAI-compatible)
            ┌────────────┴────────────┐
            │                         │
   ┌────────▼────────┐       ┌────────▼────────┐
   │  mlx_lm.server  │       │  ollama serve   │
   │  (MLX backend)  │       │  (local+cloud)  │
   └─────────────────┘       └─────────────────┘
```

## Process model

Froglips itself is one process (the Tauri binary `local-llm-app`). It spawns and supervises:

- **One model server at a time** — either `mlx_lm.server` or none (Ollama runs on its own as a system service). When the user clicks *Start*, `backend_process.rs` either spawns `mlx_lm.server` and polls TCP readiness, or in Ollama mode just probes that Ollama is listening on `127.0.0.1:11434`.
- **Shell subprocesses on demand** via the agent's `run_shell` tool — short-lived, killed on drop, 30 s timeout.

The main process is `tokio` based throughout the Rust side. React state lives in components; no global state manager (no Redux, no Zustand).

## Rust modules

### `lib.rs`

Thin entry point. Holds `run()` / `setup()` only — wires plugins (opener, updater, process), builds the tray menu, registers the `generate_handler!` command list, manages the `ServerHandle` (shared `Arc<ServerState>`), initializes PATH for GUI launches, and restores the persisted workspace root before showing the window. (It used to be a ~1800-line monolith; the command bodies now live in `commands/`.)

### `commands/`

The Tauri command layer — every `#[tauri::command]` wrapper that JS reaches via `invoke`. Each wrapper is a thin IPC adapter delegating to a domain module. Grouped by domain:

- `commands/mod.rs` — shared handle types (`ServerHandle`, `NativeHandle`), input-size limits, the `blocking()` helper that collapses the repeated `spawn_blocking` error-mapping tail.
- `commands/agent.rs` — agent tool commands.
- `commands/server.rs` — backend start/stop/probe.
- `commands/models.rs` — model list / pull / delete.
- `commands/history.rs` — conversation + message persistence.
- `commands/memory.rs` — memory store and recall.
- `commands/mcp.rs` — MCP server management.
- `commands/data.rs` — data backup, JSON export, and additive import.
- `commands/image.rs` — image-generation IPCs (`image_generate`, paginated `image_list`, `image_get`, `image_delete`, `image_cancel`, `image_unload`, `image_save_to`, `image_open_external`, `image_reveal_in_finder`). Delegates to `image_gen/` for the actual sampler; mints op-ids, validates paths via shared `commands/path_safety.rs`, persists rows, emits `image-progress` / `image-done` / `image-error` Tauri events keyed by op-id.
- `commands/workflows.rs` — workflow CRUD, scheduler control, and run history (backs the Workflows canvas).
- `commands/misc.rs` — settings, diagnostics, crash-log read, the diagnostics bundle, and the remaining odds and ends.

### `util.rs`

Shared helpers extracted from the old monolith: `expand_home`, blob/`Vec` conversion, and the xorshift PRNG.

### `agent/`

Agent logic split into a module tree (`agent/fs.rs`, `agent/git.rs`, `agent/shell.rs`, `agent/web.rs`, `agent/code.rs`, `agent/system.rs`, `agent/browser.rs`, `agent/fs_watcher.rs`). Pure logic — no Tauri dependency aside from being called by command wrappers. Defines:

- `validate_path` / `resolve_path` — canonicalize, reject `..`, then check against `is_protected_for_read` / `is_protected_for_write` and `within_workspace`.
- `ToolError` enum, JSON-serialized — `not_found`, `permission_denied`, `protected`, `outside_workspace`, `invalid_argument`, `too_large`, `timeout`, `cancelled`, `io`.
- 7 tool functions: `read_file`, `list_dir`, `search_files`, `file_exists`, `edit_file`, `write_file`, `run_shell`.
- `WORKSPACE_ROOT: RwLock<Option<PathBuf>>` — global optional sandbox.
- `SHELL_HANDLES: Mutex<HashMap<String, AbortHandle>>` — per-op cancellation tokens for `run_shell`.
- `classify_shell_risk` — heuristic for visibly destructive patterns. Drives UI badging only, not a security boundary.

### `history.rs`

SQLite via `rusqlite` + `r2d2` connection pool (max 4 connections, `PRAGMA busy_timeout=5000`, `journal_mode=WAL`). Core tables: `conversations` and `messages`.

**Schema migration ladder.** Ad-hoc per-column migrations have been replaced by a numbered `user_version` ladder. Each step is transactional and idempotent, and a fresh database and an old one converge on the same schema by running every step at or above their current `user_version`. The `conversations` table now carries `params` (per-conversation model parameter overrides as a JSON string), `pinned`, and `tags` (a JSON-array string) columns; message-content search queries `messages` directly rather than only conversation titles. Soft-deletion backs the conversation-delete undo toast.

**Corruption recovery.** On startup, before opening the pool, the app runs `PRAGMA integrity_check`. If the database is corrupt it is quarantined (renamed with a timestamp suffix) and a fresh one is created, so a damaged file degrades to a clean start instead of a permanent panic.

### `crash_log.rs` / `logging.rs`

`crash_log.rs` installs a process-global panic hook that appends timestamped panic records with backtraces to `~/.local-llm-app/crash.log` (size-capped and rotated, never networked). The `read_crash_log` command exposes the file for the Diagnostics-panel crash-log viewer.

`logging.rs` configures a rolling on-disk `app.log` via `tracing`. Together with the crash log and redacted settings, it feeds the export-diagnostics-bundle command (`commands/misc.rs`) that produces a single shareable bug-report archive.

### `data_backup.rs`

Data durability and portability: an online SQLite backup command, a versioned JSON export of conversations + messages + memory, and an additive import that remaps row ids inside a single transaction so importing never collides with existing data. Surfaced through `commands/data.rs` in the Diagnostics panel.

### `memory.rs`

Embedding cache (`RwLock<Option<HashMap<i64, Vec<f32>>>>` with double-checked lock). Cosine similarity search. `find_duplicate` checks both the active cache and a pending-DB scan. Dimension consistency guard rejects mixed-dim embeddings (otherwise dot products would silently underflow).

### `models.rs`

Lists MLX (scans HF hub directory, decodes `models--org--name` → `org/name`) and Ollama (parses `ollama list` stdout with 5 s timeout and child-kill on timeout). `delete_mlx_model` canonicalizes the path and verifies containment within the hub root to defeat any symlink escape. `delete_ollama_model` shells `ollama rm`.

### `native_inference.rs` (feature-gated `native-inference`)

Wraps `mistralrs-core` 0.8.1 + candle + Metal. Holds `Arc<MistralRs>` per loaded model. `NativeRuntime::load(model_id)` spawns the heavy HF download + model load on a blocking thread; `chat_stream(messages, opts, on_chunk)` builds a `Request::Normal` with `is_streaming: true`, sends it to mistralrs via `get_sender()`, and forwards `Response::Chunk` deltas through a callback so the Tauri layer can re-emit them as `native-chunk:<op_id>` events. Five Tauri commands (`native_supported`, `native_load_model`, `native_unload_model`, `native_current_model`, `native_chat_stream`) gate access. Falls back to CPU if Metal init fails. Requires full Xcode + Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`) at build time.

`mistralrs-core` 0.8.1 exposes a real `tools`/`tool_choice` API and returns `tool_calls` in its stream, so the native chat command accepts tool definitions and tool-role messages and collects tool calls from the stream. **Agent mode works on the native backend** alongside Ollama and MLX — see `docs/AGENT_LAYER.md`.

### `image_gen/` (feature-gated `native-mistralrs`)

In-process text-to-image, wrapping `mistralrs-core` 0.8.1's `FluxLoader` + `DiffusionPipeline`. The supported repos are upstream BFL only — `black-forest-labs/FLUX.1-schnell` (4-step distilled) and `black-forest-labs/FLUX.1-dev` (28-step, gated by a HuggingFace license accept); community GGUF / single-file fp8 repos don't ship the multi-file safetensors layout `FluxLoader` requires.

- `image_gen/engine.rs` — lazy pipeline cache (`OnceCell`), single-flight `generate_mutex`, `tokio_util::sync::CancellationToken` for in-flight cancel, idle evictor. Pipelines are dropped after each generate by default to dodge a `mistralrs` 0.8.1 sameness bug where the pipeline-scoped `Isaac64Rng` is never re-seeded — `opts.reuse_pipeline` opts back into the warm path. Routes `Response::ModelError` **and** `Response::CompletionModelError` (image-gen errors land in the latter; missing the arm surfaced as a misleading "diffusion response channel closed"). A `humanize_diffusion_error` helper rewrites T5 token-cap / HF 401 / OOM messages into actionable UI copy.
- `image_gen/metadata.rs` — PNG `tEXt` provenance chunks (`prompt`, `model`, `params_json`, `version`) baked into every generated PNG so a saved image carries its own reproduction recipe.
- `image_gen/mod.rs` — `ImageGenOpts` + `ImageGenModel` types shared with `commands/image.rs`.

DB schema: migration v10 adds an `images` table (`id`, `conv_id`, `model`, `prompt`, `params_json`, `path`, `width`, `height`, `seed`, `created_at`). On-disk PNGs live under `~/.local-llm-app/images/`; the Tauri `assetProtocol` scope is widened to `$HOME/.local-llm-app/images/**` and the CSP extended for `asset:` + `http://asset.localhost` so the webview can render them via `convertFileSrc`. The frontend `ImageView` component consumes this surface — see Frontend modules below.

### `workflows.rs`

Agent-orchestration canvas backing. Card definitions (input / agent / tool / output), connections, schedules, run history, and the scheduler tick loop. Migration v9 adds `workflow_card_fired.workflow_id INTEGER` to fix a delete-by-LIKE prefix-collision bug; the column-add helper calls `ensure_workflow_tables(conn)` first so existing v8 DBs that hadn't yet seen the table no longer fail the migration with a missing-table error. Unattended runs are explicit opt-in.

### `backend_process.rs`

Owns the spawned model-server child (formerly `mlx_server.rs`; renamed because it manages both the MLX and Ollama processes). Captures stderr to a 64-line ring buffer (`VecDeque`). TCP readiness probe with a 90 s timeout. An `AtomicU64` generation counter prevents stale-probe emissions emitting `ready` for a process that has since been killed. A crashed MLX server is auto-restarted with bounded retries and backoff; after the cap it gives up with a clear diagnostic, and a user-initiated stop never triggers a restart.

### `settings.rs`

JSON file at `~/Library/Application Support/Froglips/settings.json`. Stores `workspace_root` and other persisted prefs. Custom-backend API keys are **not** kept in this file — they live in the macOS Keychain, with a one-time migration off any legacy plaintext key and redaction of keys from the settings blob returned to the webview. Load on startup, save on change.

## Frontend modules

### `ChatWindow.tsx` + `src/hooks/` + extracted components

`ChatWindow.tsx` owns conversation state and coordinates plain streaming vs the agent loop. It has been decomposed from a ~1300-line component to ~610 lines:

- The **send pipeline** moved into a `useChatSend` hook — the whole "persist user message → recall memory → stream or run agent → persist assistant message → extract facts" flow, which also fixed a stale-closure lint. A `useEvent` hook replaces the old render-time ref-mutation pattern.
- The four near-identical confirmation modals collapsed into one `ConfirmDialog`.
- The agent toolbar, agent settings panel, and export menu are extracted as `AgentToolbar`, `AgentSettingsPanel`, and `ExportMenu` components.
- `EmptyChatLanding` replaces the blank chat surface with clickable example prompts.
- `ParamsPanel` edits per-conversation model parameters; `ContextMeter` shows live context usage by the composer.

Incidental concerns remain in focused hooks under `src/hooks/`:

- `useChatSend` — the send pipeline (above).
- `useAgentSettings` — agent preset, allowlist, approval flags, shell-prefix approvals.
- `useCitationOpener` — workspace-confined citation-chip file opens.
- `useAskUserModal` — the `ask_user` modal state.
- `useQuickPromptToast` — quick-prompt completion toast.
- `usePlatformChrome` / `useWindowGeometry` — window chrome and geometry.
- `useTauriEvent` — shared Tauri event-listener boilerplate, adopted across components that previously hand-rolled it.

`ChatWindow` still holds the race-safety primitives (`convRef`, `streamConvId` + `isStreamConvActive()`, `abortRef: AbortController`) and exposes a typed `send()` / `resend()` pair (the latter backing the edit-message feature).

### `lib/conversation-params.ts` / `lib/conversation-tags.ts`

`conversation-params.ts` decodes/encodes the `conversations.params` JSON string into a typed `ConversationParams` (temperature / top-p / max-tokens / system-prompt). Every field is independently nullable; a `null` field or absent params means "use the backend default", and bad or partial JSON degrades to all-null rather than throwing — a corrupt column must never break sending a chat. `conversation-tags.ts` similarly decodes/encodes the `tags` JSON-array string defensively (dedup, trim, case-insensitive).

### `lib/agent-loop/`

The tool-calling loop, split into focused modules:

- `runner.ts` — the iteration loop itself (`pushToolResult` and predicate helpers extracted out). Also enforces a consecutive-tool-error budget that stops the loop after repeated failures instead of burning every iteration.
- `agent-chat.ts` — the backend-aware chat primitive: dispatches the LLM call to Ollama (NDJSON `/api/chat`), MLX (OpenAI-compatible `/v1/chat/completions` with `tools`), or Native (in-process `mistralrs` tool-calling). **Agent mode is supported on all three backends.** The three backends share one resolved per-backend chat config so behaviour is consistent.
- `context-manager.ts` — budgets the message array against the model's context size before each call: oversized tool results are truncated in the sent copy and the oldest turns collapse into a synthetic summary, while the system prompt is always kept.
- `dispatch.ts` — tool dispatch, plus the split-out `url-safety.ts`, `dry-run.ts`, and `diff.ts` modules.
- `ollama-client.ts` / `stream-types.ts` — Ollama client and shared streaming types.
- `subagent.ts`, `system-prompt.ts`, `tools.ts`, `mcp-tools.ts`, `types.ts`, `tool-call-merge.ts`.

Per iteration:

1. POST `messages + tool defs` to `/api/chat` (stream=false)
2. Read `prompt_eval_count` + `eval_count` → accumulate token metrics
3. If response has `tool_calls`:
   - Dedupe: if all calls repeat the last 3 turns, inject `duplicate_call` hint and continue
   - For each call: parse args, allowlist gate, dangerous-tool confirmation (or session approve-all or prefix-match)
   - Execute via `executeTool` which calls the Tauri command
   - Append the result as a `role: "tool"` message
4. If no `tool_calls`: that's the final answer — return.

Retries Ollama 5xx + network errors twice with 500/1000 ms backoff. Aborts cleanly on `signal.aborted`.

### `lib/agent-presets.ts`

`AgentPreset` shape with `allowedTools` + `systemPromptOverride`. Four built-ins + room for user-defined ones (`agent.presets.custom` in localStorage). Active preset id in `agent.activePresetId`.

### `lib/memory-client.ts`

Embeddings via Ollama (`/api/embeddings` w/ `nomic-embed-text`). 16-entry LRU cache keyed by `model:trimmedContent`. Availability TTL 60 s when up, 5 s when down. `formatRecallBlock` wraps memories in `<memory>` tags with `<` HTML-escaped (defense against prompt injection that closes the block).

### `lib/mlx-client.ts`

`streamChat()` async generator over the OpenAI-compatible `/v1/chat/completions` endpoint with `stream: true`. Handles abort signal. 30 s connect timeout via `withTimeout(signal, ...)` so a hung daemon can't wedge the UI.

### `lib/native-client.ts`

`streamNativeChat()` async generator that subscribes to `native-chunk:<op_id>` Tauri events for each token delta, drains via an internal queue, and yields `{delta, done}` chunks. Drop-in replacement for `streamChat()` — `ChatWindow` picks branches by `status.backend === "native"`. Listeners cleaned up in `finally`.

### `lib/markdown.ts`

`renderMarkdown(md)` pipes user/assistant content through `marked` (GFM enabled) and `highlight.js` (20+ languages registered) for syntax highlighting, then through DOMPurify with a strict tag + attribute allowlist. Custom `afterSanitizeAttributes` hook blocks `javascript:` / `vbscript:` / `data:` hrefs and forces `target="_blank" rel="noopener noreferrer"` on anchors. All `dangerouslySetInnerHTML` callers in MessageList go through this single sanitization path.

### `components/MessageList.tsx`

Renders the chat transcript. The wrapper owns the scroll container, the rAF-coalesced autoscroll-to-bottom effect, and the streaming bubble. The persisted-row list and pin state live in a memoized `<MessageHistory>` subtree pulled out of the wrapper so streaming-text re-renders (~60 Hz during a reply) don't walk + diff every row each frame — only the live `<StreamingMessage>` re-renders. `.message-list` declares `contain: layout paint` + `overscroll-behavior: contain`; the scroll listener is registered passively with a rAF-coalesced stick check; autoscroll-to-bottom is throttled to every third rAF tick while streaming. Result: scroll stays responsive against long histories during streaming.

`MessageList` also caps initially-rendered rows at the most recent `WINDOW_SIZE = 150` and gates the rest behind an explicit "Show earlier messages" control (the newest messages — the ones that stream and that autoscroll targets — are always fully rendered).

### `components/ImageView.tsx` + `src/hooks/useImageGeneration.ts`

Top-level Image-generation surface (canvas-left + vertical thumb strip + sticky composer). Owns the gallery state, per-conversation filter chip (All / This chat / Standalone), pagination ("Load more"), the in-app right-click `<ImageContextMenu>` (Open in Preview · Save image as… · Reveal in Finder · Copy file path · Send to current chat), and the global `image-done` subscription that refreshes the gallery on any completed gen — including agent-tool-driven `generate_image` calls.

The in-flight generation state (`running` / `progress` / `error` / `generate`) lives one level up in `App.tsx` via `useImageGeneration` and is passed into `ImageView` as props. Tab navigation unmounts `ImageView` but `App` stays mounted, so the Tauri `image-progress` / `image-done` / `image-error` listeners survive — without this, switching tabs mid-gen silently dropped the completion event (Rust kept generating, PNG landed in DB, UI forgot it was running).

### `components/AboutYouModal.tsx` + `lib/user-profile.ts`

Local-only structured user profile (name / occupation / location / about / response-style + an enabled toggle). `formatUserProfile` renders the enabled profile as a system-prompt block (framed as context the model has, not something to repeat back) which `useChatSend` prepends to every chat. The workflow runner **intentionally does NOT inject** the profile — workflow agents are task-focused and some models (kimi-k2.6:cloud in particular) were observed picking the profile's name as a literal filename when the card prompt mentioned a file destination. Stored under `settings.user_profile`; never leaves the device. Saving with any field filled auto-enables the profile (foot-gun fix — the original required two clicks).

### `lib/auto-continue.ts` + `components/ContextRolloverBanner.tsx`

When estimated context use crosses ~85% of the active model's window (resolved via `lib/model-context-lookup.ts`, which hits Ollama `/api/show` for the real `Modelfile num_ctx` / `model_info[*.context_length]`, cached per `(backend, model)`), a banner above the composer counts down 5 s, then summarizes prior turns via the active backend and forks the conversation into a fresh "Continued: …" child seeded with the summary as a system message. The countdown is gated on `backendReady = status?.running && status.model` so it can't fire while the backend is stopped.

### `components/ToolHistory.tsx`

Slide-out panel listing every tool call in the current conversation. Walks message history, pairs `assistant.tool_calls` entries with their matching `role: "tool"` results by `tool_call_id`, and displays each with an ok/err status badge + collapsible args + JSON result.

### `lib/tauri-api.ts`

Typed `invoke()` wrapper. Single object `api` with all backend commands as methods.

## Data flows

### Sending a message (MLX mode)

```
ChatInput.onSend
  → ChatWindow.send()
    → api.addMessage(user)                    // persist
    → recall() → formatRecallBlock()          // memory inject
    → mlx-client.streamChat() (yields chunks) // backend
    → setStreaming(acc) on each chunk         // UI update
    → api.addMessage(assistant) on done       // persist final
    → extractFacts() → saveMemory() (queue/direct mode)
```

### Sending a message (agent mode)

```
ChatInput.onSend
  → ChatWindow.send()
    → api.addMessage(user)
    → recall() → formatRecallBlock()
    → runAgentLoop({...})
       LOOP:
       → POST /api/chat with tools
       → if tool_calls:
            for each: confirm? → invoke agent_* → push tool message
            continue
       → else: return final text
    → api.addMessage(assistant, finalText)
    → extractFacts() → saveMemory()
```

### Pulling a model

```
ModelBrowser.pull()
  → api.pullOllamaModel(name) or api.pullHfModel(repo)
    → tauri command spawns `ollama pull` or `huggingface-cli download`
       (1800 s timeout, kill_on_drop)
  → refreshInstalled() — re-fetches the installed list
  → onPulled() — bubbles up to ChatWindow to refresh the dropdown
```

## Security boundaries

| Threat | Mitigation |
|---|---|
| Path traversal (`../../etc/passwd`) | `resolve_path` rejects `..` explicitly + canonicalizes via `fs::canonicalize` |
| Symlink escape (`/tmp/link → /etc/passwd`) | Canonical path checked against protected list and workspace root |
| Reading credentials | `is_protected_for_read` blocks `.env*`, `credentials*`, `~/.ssh`, `~/.aws`, `~/.gnupg`, Keychains, Cookies, sudoers, TCC |
| Writing to system paths | `is_protected_for_write` adds `/System`, `/etc`, `/private/etc`, `/Applications/Froglips.app` |
| Destructive shell | `classify_shell_risk` flags `rm -rf /`, `mkfs`, `dd of=/dev/`, `:(){:|:&};:`, fork-bombs, `sudo`, `curl … | sh` — UI shows red banner |
| Prompt injection from file content | `<` HTML-escaped in `formatRecallBlock` so a `<memory>` tag in user data can't close ours |
| Tampered update binary | Minisign signature verified against embedded public key before install |
| Memory writes containing secrets | `SECRET_PATTERNS` regex blocklist on extraction (AWS/OpenAI/GitHub/Slack/JWT/labeled hex/bearer) |
| `tauri_plugin_opener` arbitrary URL | Allow-list: huggingface, civitai, ollama hosts only |
| Subprocess leaks | All children use `kill_on_drop(true)` + timeouts |

## Configuration

| Setting | Where | Default |
|---|---|---|
| Workspace root | `~/Library/Application Support/Froglips/settings.json` | None |
| Per-conversation model params | `conversations.params` column (SQLite, JSON) | None (backend default) |
| Conversation pin / tags | `conversations.pinned` / `conversations.tags` columns | Unpinned / no tags |
| Agent allowlist (per-conv override) | `localStorage["agent.allowlist"]` | All enabled |
| Active preset | `localStorage["agent.activePresetId"]` | `general` |
| Custom presets | `localStorage["agent.presets.custom"]` | None |
| Memory mode | `localStorage["memoryMode"]` | `off` |
| Crash log | `~/.local-llm-app/crash.log` | (created on first panic) |
| App log | rolling on-disk `app.log` | (created at startup) |
| Updater pubkey | `tauri.conf.json` | (embedded) |
| Updater endpoint | `tauri.conf.json` | GitHub Releases `latest.json` |
| Updater privkey | `~/.tauri/froglips.key` | (generated) |

Settings-file writes are atomic (write to a temp file, then rename) so a crash mid-write can't truncate `settings.json`.

## Build artifacts

```
src-tauri/target/release/bundle/
├── macos/
│   ├── Froglips.app/                       # Installable bundle
│   ├── Froglips.app.tar.gz                 # Updater asset
│   └── Froglips.app.tar.gz.sig             # Minisign signature
└── dmg/
    └── Froglips_<version>_aarch64.dmg      # Distributable DMG
```

GitHub Release includes all four plus a `latest.json` manifest the updater queries.
