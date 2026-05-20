# Agent Layer

Reference for the agent system — what tools exist, how they're sandboxed, how the loop runs, and how to add or modify presets.

## Lifecycle of a single agent turn

```
User: <prompt>
  ↓
ChatWindow.send()
  ↓
runAgentLoop({ model, messages, workspaceRoot, preset, ... })
  ↓
buildSystemPrompt() — preset.systemPromptOverride OR default, plus env block
  ↓
LOOP (max 20 iterations):
  ↓
  POST http://127.0.0.1:11434/api/chat
       { model, messages, tools, options: { temperature: 0.4 } }
       retry 2x on 5xx with exponential backoff
  ↓
  Receive { message: { content, tool_calls? }, prompt_eval_count, eval_count }
  ↓
  metrics += eval counts
  ↓
  IF no tool_calls → push assistant message, return final text. DONE.
  ↓
  IF all current tool_call signatures repeat recent (window=3):
     inject `duplicate_call` hint → continue loop
  ↓
  Push assistant message with tool_calls
  ↓
  FOR each tool_call:
    parse args (JSON or object)
    allowlist gate
    IF dangerous (run_shell, write_file, edit_file):
       compute risk (classify_shell_risk if shell)
       IF session-approved (all-shell-normal | all-writes | prefix-match) → skip confirm
       ELSE → await requestConfirmation(name, args, risk)
              modal shows in UI, returns { approve, remember }
              if remember + shell + normal-risk: add firstWord to approvedShellPrefixes
    IF approved:
       executeTool(name, args) → calls Tauri command
       result wrapped as JSON string
    IF denied:
       push tool message with { ok: false, kind: "user_denied" }
  ↓
  continue loop
```

## Tools

### `read_file(path, offset?, limit?)`

Read bytes from a file. Defaults: offset=0, limit=64 KiB.

Returns:
```json
{ "content": "...", "bytes_read": 1234, "total_bytes": 1234, "truncated": false }
```

Errors: `not_found`, `permission_denied`, `protected`, `outside_workspace`, `invalid_argument`.

### `list_dir(path)`

List a directory. Hard cap 500 entries.

Returns:
```json
{
  "entries": [{ "name": "foo.ts", "kind": "file", "size": 1234 }, ...],
  "truncated": false
}
```

### `search_files(path, pattern, glob?, regex?)`

Recursive line-grep. Default glob `*`. Skips `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `.cache`, and dotfiles. Files >2 MiB skipped. Hard caps: 200 hits, 2000 files scanned. Set `regex: true` for Rust regex syntax; default is literal substring.

```json
{ "hits": [{"path": "...", "line": 42, "text": "..."}], "files_scanned": 187, "truncated_hits": false, "truncated_scan": false }
```

### `multi_edit(path, edits[])`

Apply N find-and-replace edits to one file atomically. Edits accumulate in memory then a single `tokio::fs::write` lands the result. If any individual edit fails (old_string not found, ambiguous match without `replace_all`), the whole call errors out and the file is untouched. Cap: 100 edits per call. Requires user approval.

```json
[
  { "old_string": "foo", "new_string": "bar" },
  { "old_string": "spam", "new_string": "ham", "replace_all": true }
]
```

Returns `{ edits_applied, total_replacements, new_size }`.

### `git_status(path?)`

Runs `git status --short --branch` with `current_dir = path ?? workspace_root`. Returns `{stdout, stderr, exit_code, cwd}`. 10 s timeout. Read-only — does not require user approval.

### `git_diff(path?, staged?)`

Runs `git diff --no-color` (or `git diff --no-color --staged` when `staged: true`). Same return shape + timeout as `git_status`.

### `file_exists(path)`

```json
{ "exists": true, "kind": "file", "size": 1234 }
```

Does not require workspace containment — used as a probe.

### `edit_file(path, old_string, new_string, replace_all?)`

Find-and-replace. `old_string` must appear exactly once, unless `replace_all: true`. Whole file must be UTF-8. Max size 1 MiB.

Returns:
```json
{ "replacements": 1, "new_size": 2456 }
```

Errors include `not_found` when `old_string` doesn't match, and `invalid_argument` when it matches multiple times without `replace_all`.

### `write_file(path, content)`

Overwrite a file (creates parents). Max 1 MiB. Requires user approval. Returns `{ ok: true, path }`.

### `run_shell(command, opts?, op_id?)`

Execute via `sh -c`. `opts.cwd` is validated as readable. `opts.env` is a list of `[key, value]` tuples — keys can't contain `=` or `\0`. If no cwd is given and workspace root is set, runs from the workspace root. Timeout 30 s, output capped at 32 KiB stdout + 32 KiB stderr.

Returns:
```json
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "duration_ms": 245,
  "timed_out": false
}
```

If `op_id` is provided, the frontend can call `agent_cancel_shell(op_id)` to abort. `cancelActiveShell()` is wired into the chat abort button so a single user "stop" kills the in-flight shell too.

### `read_pdf(path, limit?)`

Text-extract a PDF via `pdf-extract` on a blocking thread. Default output cap = `MAX_READ_BYTES` (64 KiB). Returns `{content, bytes_read, total_bytes, truncated}`.

### Git extras (v0.8+)

#### `git_log(path?, limit?)`
`git log --oneline --decorate -n <limit>` (default 20, max 200). Read-only.

#### `git_show(reference, path?)`
`git show --no-color <ref>`. `reference` must match `[A-Za-z0-9._/-]+` (argv-injection guard). Read-only.

#### `git_branches(path?)`
`git branch -a --no-color` — local + remote branches.

#### `git_commit(message, path?)`
Commits already-staged changes. Does NOT stage files itself — use `run_shell "git add …"` first. Message length capped at 8 KiB. Requires user approval (in `DANGEROUS_TOOLS`).

### Web tools (v0.8+)

All share an SSRF guard that rejects hosts resolving to loopback, RFC1918 private, link-local (incl. `169.254.169.254` metadata), `.local`, and `.internal`. The `Host:` header is also blocked from being overridden on `http_request` to prevent SNI-based bypasses.

#### `web_fetch(url)`
GET only. 15 s timeout, 1 MiB response cap. HTML detected by presence of `<html`/`<body`/`<!DOCTYPE` and run through `html2text` for the agent's benefit. Returns `{url, status, content, bytes, truncated}`.

#### `web_search(query, n?)`
DuckDuckGo HTML endpoint scrape — no API key. Default `n=5`, max 20. Returns `{query, hits: [{title, url, snippet}]}`.

#### `http_request(method, url, headers?, body?, timeout_secs?)`
Generic HTTP. Methods: `GET | POST | PUT | PATCH | DELETE | HEAD`. Body capped at 1 MiB. `timeout_secs` capped at 60. Same SSRF guard. **Requires user approval** (in `DANGEROUS_TOOLS` / `WRITE_TOOLS`). Returns `{status, headers, body, bytes, truncated}`.

### macOS automation (v0.8+)

#### `screenshot(out_path?)`
`screencapture -x -t png`. Defaults to `$TMPDIR/froglips-screenshot-<ms>.png`. Returns `{path, bytes}`.

#### `clipboard_get()` / `clipboard_set(text)`
`pbpaste` / `pbcopy`. Get truncates at `MAX_READ_BYTES` (64 KiB). Set is dangerous (clipboard often holds secrets).

#### `open_app(name)`
`open -a <name>`. Name validated against `^[A-Za-z0-9 ._-]+$`. Dangerous — model could spawn arbitrary apps.

#### `show_notification(title, body)`
`osascript -e 'display notification …'`. Both fields strip embedded `"` before AppleScript interpolation. Combined length capped at 4 KiB. Not dangerous.

#### `applescript_run(script)` (v0.9+)
Generic AppleScript execution. Script size capped at 16 KiB, 30 s timeout. **High-power** — can drive any scriptable macOS app. Dangerous (in `DANGEROUS_TOOLS` / `WRITE_TOOLS`). Returns same shape as `run_shell`.

### Code intelligence (v0.9+)

#### `find_definition(symbol, path?)`
Heuristic regex across the workspace for common definition patterns: `fn|def|function|class|struct|enum|trait|interface|type|const|let|var|pub <kind>`. Symbol restricted to `[A-Za-z0-9_]+`. Defaults `path` to workspace root. Returns a `SearchResult`.

#### `find_references(symbol, path?)`
Word-boundary regex search for the symbol. Returns a `SearchResult`.

#### `format_code(path)`
Runs the right formatter for the file's extension: `prettier --write` (ts/tsx/js/jsx/json/css/html/md/yaml/yml), `rustfmt` (rs), `black` (py), `gofmt -w` (go), `swift-format -i` (swift). 30 s timeout. Returns `{formatter, stdout, stderr, exit_code, duration_ms}`.

### Background tasks (v0.9+)

Fire-and-forget shell tasks. State lives in a Mutex-guarded `HashMap<id, TaskEntry>` w/ max 32 concurrent.

#### `task_create(command, cwd?)`
Spawns a tokio task wrapping `run_shell` with `op_id = task_id`. Returns the `TaskInfo` immediately (status = `pending` or `running`). Internal cancellation oneshot is forwarded to `cancel_shell` so the child process is killed.

#### `task_status(id)`
Returns the current `TaskInfo` snapshot.

#### `task_list()`
All session tasks.

#### `task_cancel(id)`
Idempotent on terminal states (`done` / `failed` / `cancelled`).

#### `task_prune(older_than_secs?)` (Tauri command only — not exposed to the agent)
Drops finished tasks older than threshold. Default 1 h.

### Control flow (v0.9+)

#### `ask_user(question, hint?)`
Pauses the agent and pops a Tauri-event-driven modal in `ChatWindow` with a textarea. User submits via Cmd+Enter, cancels via Esc or backdrop click. 10 min hard timeout server-side. Returns `{ok: true, answer: "<user text>"}`.

Implementation: `ask_user::prepare()` registers a oneshot sender in a `Mutex<HashMap<id, Sender>>`, the command layer emits `ask-user` event, then awaits the receiver. Frontend modal calls `agent_ask_user_reply(id, answer)` to resolve.

#### `spawn_subagent(prompt, preset?)`
Recursive `runAgentLoop` in an isolated context. Caps at `MAX_SUBAGENT_DEPTH = 3` to prevent runaway recursion. Inherits parent's:
- `model`
- `workspaceRoot`
- `requestConfirmation`
- `signal`
- `approveAllShell` / `approveAllWrite` / `approvedShellPrefixes`

Replaces parent's:
- `messages` → `[{role: "user", content: prompt}]`
- `systemPromptOverride` ← chosen preset's prompt (if `preset` matches)
- `toolAllowlist` ← chosen preset's `allowedTools` (if non-empty)
- `onUpdate` / `onStatusChange` / `onMetrics` → no-op (sub steps don't pollute parent UI)

Returns `{ok, depth, preset, answer}` JSON.

## Error envelope

Every tool that can fail returns a stringified JSON via the Tauri error channel:

```json
{ "kind": "not_found", "message": "path not accessible: ..." }
```

The agent loop forwards this verbatim to the model. The system prompt instructs the model to read `kind` and adapt — e.g. on `not_found` try a different path, on `outside_workspace` stay in scope.

| `kind` | When |
|---|---|
| `not_found` | Path doesn't exist (read) or `old_string` not found (edit) |
| `permission_denied` | OS-level denied |
| `protected` | Path matches a hardcoded protected pattern |
| `outside_workspace` | Workspace root is set and path falls outside |
| `invalid_argument` | Args malformed (empty path, null bytes, `..`, too long) |
| `too_large` | File or write exceeds 1 MiB |
| `timeout` | Reserved (run_shell uses `timed_out` field instead) |
| `cancelled` | User aborted |
| `io` | Catch-all I/O |
| `user_denied` | User clicked Deny on the confirm dialog |
| `bad_arguments` | Tool args were not valid JSON |
| `duplicate_call` | Dedupe triggered |
| `tool_not_allowed` | Allowlist gate rejected |

## Sandbox

Two complementary layers:

### Protected paths (always blocked)

Read-blocked: `/Library/Keychains`, `/private/var/db/sudo`, `/var/db/sudo`, `/etc/sudoers`, `~/.ssh`, `~/.gnupg`, `~/Library/Keychains`, `~/Library/Cookies`, `~/Library/Application Support/com.apple.TCC`, files named `.env*` / `credentials` / `credentials.json`.

Write-blocked: all of the above plus `/System`, `/private/etc`, `/etc`, `/private/var/db/sudo`, `/var/db/sudo`, `/Library/Keychains`, `/Library/Application Support/com.apple.TCC`, `/Applications/Froglips.app`, `~/.aws`, `~/.config/gh`, `~/Library/Mail`, `~/Library/Messages`.

### Workspace root (opt-in sandbox)

`agent_set_workspace(path)` canonicalizes the path and stores it in a `RwLock`. Persisted to settings.json. When set, every path passed to a tool must start with the canonical workspace root (after the path itself is canonicalized — symlink escape closed).

When unset, the agent has full filesystem access (still subject to protected list and OS perms).

## Adding a tool

For tools outside the path-sandbox model (web, OS-native, code intel, etc.) put them in `agent.rs` w/o `validate_for_*` calls — but still gate dangerous behavior at `DANGEROUS_TOOLS`. For task-queue–like long-running infrastructure, use a separate module (`task_queue.rs`, `ask_user.rs`) and expose Tauri commands.

1. Implement the logic in `src-tauri/src/agent.rs`. Use `validate_for_read` / `validate_for_write` to get a resolved + sandboxed `PathBuf`. Return `Result<MyResult, String>` where the error string is `err_string(ToolError::…)`.
2. Add a Tauri command in `src-tauri/src/lib.rs`:
   ```rust
   #[tauri::command]
   async fn agent_my_tool(arg: String) -> Result<agent::MyResult, String> {
       agent::my_tool(arg).await
   }
   ```
   And register in `invoke_handler!`.
3. Add to `src/lib/tauri-api.ts`:
   ```ts
   agentMyTool: (arg: string) => invoke<MyResult>("agent_my_tool", { arg }),
   ```
4. Add to the `TOOLS` array in `src/lib/agent-loop.ts` with a JSON Schema describing the parameters. Add a `case "my_tool":` to `executeTool()`.
5. Optionally add to `DANGEROUS_TOOLS` if it needs confirmation.
6. Add to `ALL_TOOL_NAMES` in `src/components/ChatWindow.tsx` so the allowlist panel shows it.
7. Optionally add to one or more presets in `src/lib/agent-presets.ts`.

## Adding a preset

Edit `src/lib/agent-presets.ts`. Built-in presets have `builtIn: true`. Custom presets persist to `localStorage["agent.presets.custom"]`.

```ts
{
  id: "myapp",
  name: "MyApp",
  description: "Focused on X",
  systemPromptOverride: "You are an agent that...",
  allowedTools: ["read_file", "list_dir", "run_shell"],
}
```

Empty `allowedTools` means "all enabled". The preset's `systemPromptOverride` replaces the default rules section but env info (workspace, OS, tool list) is always appended.

## Tunables

`src/lib/agent-loop.ts`:

| Constant | Default | What |
|---|---|---|
| `OLLAMA_BASE` | `http://127.0.0.1:11434` | Ollama URL |
| `MAX_ITERATIONS` | 20 | Loop budget |
| `DEDUPE_WINDOW` | 3 | How many recent calls to track for repeat detection |
| `RETRY_MAX` | 2 | Ollama retry count |
| `RETRY_BACKOFF_MS` | 500 | Initial backoff (multiplied by attempt+1) |
| `OLLAMA_REQUEST_TIMEOUT_MS` | 120 000 | Per-request timeout combined with caller's signal |
| `MAX_SUBAGENT_DEPTH` | 3 | Recursion cap for `spawn_subagent` |

`src-tauri/src/agent.rs`:

| Constant | Default | What |
|---|---|---|
| `MAX_READ_BYTES` | 65 536 | Per-`read_file` cap |
| `MAX_SHELL_OUTPUT` | 32 768 | stdout/stderr cap each |
| `SHELL_TIMEOUT_SECS` | 30 | Per-shell timeout |
| `MAX_PATH_LEN` | 4096 | Path length cap |
| `MAX_WRITE_BYTES` | 1 048 576 | `write_file` + `edit_file` cap |
| `MAX_LIST_ENTRIES` | 500 | `list_dir` cap |
| `MAX_SEARCH_HITS` | 200 | `search_files` hit cap |
| `MAX_SEARCH_FILES_SCANNED` | 2000 | `search_files` walk cap |
| `WEB_FETCH_MAX_BYTES` | 1 048 576 | Response body cap for `web_fetch` + `http_request` |
| `WEB_FETCH_TIMEOUT_SECS` | 15 | Default timeout for web tools |
| `APPLESCRIPT_TIMEOUT_SECS` | 30 | Per-script timeout |
| `APPLESCRIPT_MAX_SCRIPT_BYTES` | 16 384 | Script-source cap |
| `MAX_CONCURRENT_TASKS` | 32 | task_queue size cap |
| `ASK_TIMEOUT_SECS` | 600 | `ask_user` wait timeout (10 min) |
