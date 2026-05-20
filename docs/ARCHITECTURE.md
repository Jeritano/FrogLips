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
│  │  ChatWindow           │    │  lib.rs   (entry + cmds)    │  │
│  │  ModelBrowser         │    │  agent.rs (tools + sandbox) │  │
│  │  ModelPicker          │    │  history.rs (SQLite pool)   │  │
│  │  MemoryPanel          │    │  memory.rs (embeddings)     │  │
│  │  MessageList          │    │  models.rs (list + delete)  │  │
│  │  ChatInput            │    │  mlx_server.rs (subprocess) │  │
│  │                       │    │  settings.rs (persistence)  │  │
│  │  lib/agent-loop.ts    │    │                             │  │
│  │  lib/memory-client.ts │    │  + tauri-plugin-updater     │  │
│  │  lib/mlx-client.ts    │    │  + tauri-plugin-process     │  │
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

- **One model server at a time** — either `mlx_lm.server` or none (Ollama runs on its own as a system service). When the user clicks *Start*, `mlx_server.rs` either spawns `mlx_lm.server` and polls TCP readiness, or in Ollama mode just probes that Ollama is listening on `127.0.0.1:11434`.
- **Shell subprocesses on demand** via the agent's `run_shell` tool — short-lived, killed on drop, 30 s timeout.

The main process is `tokio` based throughout the Rust side. React state lives in components; no global state manager (no Redux, no Zustand).

## Rust modules

### `lib.rs`

Entry point. Defines Tauri commands (`#[tauri::command]` functions exposed to JS via `invoke`). Wires plugins (opener, updater, process). Manages the `ServerHandle` (shared `Arc<ServerState>`). Initializes PATH for GUI launches and restores the persisted workspace root before showing the window.

### `agent.rs`

Pure logic — no Tauri dependency aside from being called by Tauri commands. Defines:

- `validate_path` / `resolve_path` — canonicalize, reject `..`, then check against `is_protected_for_read` / `is_protected_for_write` and `within_workspace`.
- `ToolError` enum, JSON-serialized — `not_found`, `permission_denied`, `protected`, `outside_workspace`, `invalid_argument`, `too_large`, `timeout`, `cancelled`, `io`.
- 7 tool functions: `read_file`, `list_dir`, `search_files`, `file_exists`, `edit_file`, `write_file`, `run_shell`.
- `WORKSPACE_ROOT: RwLock<Option<PathBuf>>` — global optional sandbox.
- `SHELL_HANDLES: Mutex<HashMap<String, AbortHandle>>` — per-op cancellation tokens for `run_shell`.
- `classify_shell_risk` — heuristic for visibly destructive patterns. Drives UI badging only, not a security boundary.

### `history.rs`

SQLite via `rusqlite` + `r2d2` connection pool (max 4 connections, `PRAGMA busy_timeout=5000`, `journal_mode=WAL`). Two tables: `conversations` and `messages`. Schema migration tolerates `QueryReturnedNoRows` so first-run is clean.

### `memory.rs`

Embedding cache (`RwLock<Option<HashMap<i64, Vec<f32>>>>` with double-checked lock). Cosine similarity search. `find_duplicate` checks both the active cache and a pending-DB scan. Dimension consistency guard rejects mixed-dim embeddings (otherwise dot products would silently underflow).

### `models.rs`

Lists MLX (scans HF hub directory, decodes `models--org--name` → `org/name`) and Ollama (parses `ollama list` stdout with 5 s timeout and child-kill on timeout). `delete_mlx_model` canonicalizes the path and verifies containment within the hub root to defeat any symlink escape. `delete_ollama_model` shells `ollama rm`.

### `native_inference.rs` (feature-gated `native-inference`)

Wraps `mistralrs-core` 0.8.1 + candle + Metal. Holds `Arc<MistralRs>` per loaded model. `NativeRuntime::load(model_id)` spawns the heavy HF download + model load on a blocking thread; `chat_stream(messages, opts, on_chunk)` builds a `Request::Normal` with `is_streaming: true`, sends it to mistralrs via `get_sender()`, and forwards `Response::Chunk` deltas through a callback so the Tauri layer can re-emit them as `native-chunk:<op_id>` events. Five Tauri commands (`native_supported`, `native_load_model`, `native_unload_model`, `native_current_model`, `native_chat_stream`) gate access. Falls back to CPU if Metal init fails. Requires full Xcode + Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`) at build time.

### `mlx_server.rs`

Owns the spawned `mlx_lm.server` child. Captures stderr to a 64-line ring buffer (`VecDeque`). TCP readiness probe with a 90 s timeout. An `AtomicU64` generation counter prevents stale-probe emissions emitting `ready` for a process that has since been killed.

### `settings.rs`

JSON file at `~/Library/Application Support/Froglips/settings.json`. Currently stores `workspace_root`. Load on startup, save on change.

## Frontend modules

### `ChatWindow.tsx`

Owner of conversation state. Coordinates streaming (MLX) vs agent loop (Ollama). Holds:

- `convRef` — race-safe conversation reference
- `streamConvId` + `isStreamConvActive()` — guards on every post-async state update so a fast convo switch doesn't pollute the new convo's state
- `abortRef: AbortController` — for stopping inflight work
- Agent preset, allowlist, approval flags, shell-prefix approvals

### `lib/agent-loop.ts`

The Ollama tool-calling loop. Per iteration:

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
| Agent allowlist (per-conv override) | `localStorage["agent.allowlist"]` | All enabled |
| Active preset | `localStorage["agent.activePresetId"]` | `general` |
| Custom presets | `localStorage["agent.presets.custom"]` | None |
| Memory mode | `localStorage["memoryMode"]` | `off` |
| Updater pubkey | `tauri.conf.json` | (embedded) |
| Updater endpoint | `tauri.conf.json` | GitHub Releases `latest.json` |
| Updater privkey | `~/.tauri/froglips.key` | (generated) |

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
