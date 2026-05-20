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

### `search_files(path, pattern, glob?)`

Recursive line-grep. Default glob `*`. Skips `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `.cache`, and any directory starting with `.`. Files >2 MiB are skipped. Hard caps: 200 hits, 2000 files scanned.

Returns:
```json
{
  "hits": [{ "path": "src/main.rs", "line": 42, "text": "..." }, ...],
  "files_scanned": 187,
  "truncated_hits": false,
  "truncated_scan": false
}
```

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
