# Agent Layer

Reference for the agent system — what tools exist, how they're sandboxed, how the loop runs, and how to add or modify presets.

## Backend support

Agent mode runs on **all three backends — Ollama, MLX, and Native**. The agent
runner dispatches its LLM call by backend via `agent-chat.ts`:

- **Ollama** — NDJSON `/api/chat` with `tools` (the original path).
- **MLX** — OpenAI-compatible `/v1/chat/completions` with `tools`; `tool_calls`
  are parsed out of the streaming deltas.
- **Native** — `mistralrs-core` 0.8.1 exposes a real `tools`/`tool_choice` API
  and returns `tool_calls` in its stream, so the native chat command accepts
  tool definitions and tool-role messages, and the agent loop routes the native
  backend through a native agent-chat path. Agent mode is no longer rejected on
  Native.

The three backends share **one resolved per-backend chat config** so agent
behaviour is consistent across them; per-conversation model parameters
(temperature / top-p / max-tokens / system-prompt) still override it.

## Lifecycle of a single agent turn

```
User: <prompt>
  ↓
ChatWindow.send()
  ↓
runAgentLoop({ model, backend, messages, workspaceRoot, preset, ... })
  ↓
buildSystemPrompt() — preset.systemPromptOverride OR default, plus env block
  ↓
LOOP (max 20 iterations):
  ↓
  context-manager budgets the message array against the model context
       (truncate oversized tool results, summarize oldest turns, keep system prompt)
  ↓
  agent-chat dispatch → Ollama /api/chat OR MLX /v1/chat/completions
       OR Native (in-process mistralrs tool-calling)
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

## Context-window management

`context-manager.ts` runs before every model call. The message array is
budgeted against the active model's context size:

- The **system prompt is always kept** in full — including the tool
  definitions, so the model never loses the schemas mid-run.
- **Oversized tool results are truncated** in the sent copy of the
  conversation (the stored transcript is untouched).
- The **oldest turns collapse into a synthetic summary message** once the
  budget is exceeded.

This stops long agent runs from silently overflowing small-context models and
evicting their own tool definitions.

## Consecutive-error budget

Beyond the iteration cap, the runner tracks a **consecutive-tool-error
budget**. If tool calls keep failing turn after turn, the loop stops with a
clear message instead of burning every remaining iteration retrying a hopeless
path. A successful tool call resets the counter.

## Tools

> **Untrusted-content scanning.** Tool output that originates from outside the
> model — `read_file`, `read_pdf`, `clipboard_get`, the browser get-text tool,
> and the git read tools — is routed through an injection-scan wrapper before
> it reaches the model, so file, clipboard, and repo content can't smuggle
> instructions in unwrapped.

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

**Cancel reaches every in-flight tool, not just shell.** The agent loop wraps each tool call in `abortableToolResult`, which races it against the run's `AbortSignal` — a user Stop returns control to the loop immediately instead of blocking on the tool's own timeout (`http_request`, `web_fetch`, `browser_*`). A tool that supports active backend cancellation can additionally terminate its op via `opts.signal` so the backend work actually stops rather than running to completion in the background. After an aborted tool the loop pairs an `aborted` tool result and ends, so the assistant `tool_calls` message is never left unpaired.

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

All share an SSRF guard that rejects hosts resolving to loopback, RFC1918 private, link-local (incl. `169.254.169.254` metadata), `.local`, and `.internal`. IPv4-mapped/compatible IPv6 literals and NAT64 ranges are also rejected. Redirects are followed manually with the connection **pinned to each hop's validated IP set**, closing the DNS-rebinding TOCTOU where a redirect host could resolve safe for the check and to loopback for the connection. The `Host:` header is also blocked from being overridden on `http_request` to prevent SNI-based bypasses.

#### `web_fetch(url)`
GET only. 15 s timeout, 1 MiB response cap. HTML detected by presence of `<html`/`<body`/`<!DOCTYPE` and run through `html2text` for the agent's benefit. Returns `{url, status, content, bytes, truncated}`.

#### `web_search(query, n?)`
DuckDuckGo HTML endpoint scrape — no API key. Default `n=5`, max 20. Returns `{query, hits: [{title, url, snippet}]}`.

#### `http_request(method, url, headers?, body?, timeout_secs?)`
Generic HTTP. Methods: `GET | POST | PUT | PATCH | DELETE | HEAD`. Body capped at 1 MiB. `timeout_secs` capped at 60. Same SSRF guard. **Requires user approval** (in `DANGEROUS_TOOLS` / `WRITE_TOOLS`). Any `http_request` carrying a body is treated as **elevated risk**, so it always needs explicit confirmation even when session approvals are active. Returns `{status, headers, body, bytes, truncated}`.

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
Recursive `runAgentLoop` in an isolated context. Caps at `MAX_SUBAGENT_DEPTH = 3` to prevent runaway recursion. **Classified as a confirmation-gated tool** (in `DANGEROUS_TOOLS`) — spawning a subagent itself needs explicit user approval.

Inherits parent's:
- `model` / `backend`
- `workspaceRoot`
- `requestConfirmation`
- `signal`

Does **not** inherit the parent's blanket approvals — `approveAllShell` / `approveAllWrite` / `approvedShellPrefixes` are deliberately not passed down, so a subagent's shell and write calls each require their own confirmation regardless of what the user approved for the parent run.

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

Three complementary layers:

### Protected paths (always blocked)

Read-blocked: `/Library/Keychains`, `/private/var/db/sudo`, `/var/db/sudo`, `/etc/sudoers`, `~/.ssh`, `~/.gnupg`, `~/Library/Keychains`, `~/Library/Cookies`, `~/Library/Application Support/com.apple.TCC`, files named `.env*` / `credentials` / `credentials.json`. The read-protected list also covers extra credential files and browser profile directories: `.netrc`, `.npmrc`, the `gh` and `gcloud` config dirs, Chrome / Firefox / Safari profiles, and Froglips' own `settings.json`.

Write-blocked: all of the above plus `/System`, `/private/etc`, `/etc`, `/private/var/db/sudo`, `/var/db/sudo`, `/Library/Keychains`, `/Library/Application Support/com.apple.TCC`, `/Applications/Froglips.app`, `~/.aws`, `~/.config/gh`, `~/Library/Mail`, `~/Library/Messages`.

### Workspace root (opt-in sandbox)

`agent_set_workspace(path)` canonicalizes the path and stores it in a `RwLock`. Persisted to settings.json. When set, every path passed to a tool must start with the canonical workspace root (after the path itself is canonicalized — symlink escape closed).

When unset, the agent has full filesystem access (still subject to protected list and OS perms).

### OS sandbox on shell/code (Seatbelt, default-on)

The protected-path list above is enforced by the *filesystem tools* — it does nothing for a `run_shell`/`run_code` command that `cat`s a credential file directly. So those two tools additionally run their child under a macOS Seatbelt profile via `/usr/bin/sandbox-exec` (`agent/shell.rs` `base_command`). The profile is `(allow default)` with a `(deny file-read* file-write* …)` over the credential set no build legitimately reads: `~/.ssh`, `~/.gnupg`, `~/Library/Keychains`, `~/Library/Cookies`, `~/Library/Mail`, `~/Library/Messages`, `~/.local-llm-app`, and `~/Library/Application Support/Froglips`. Network and ordinary build inputs (`~/.gitconfig`, `~/.npmrc`, `~/.aws`, project files) are deliberately **left allowed** so git/npm/aws builds don't break.

A one-time probe (`sandbox-exec -p <profile> /usr/bin/true`, cached in a `OnceLock`) gates the wrapper: if `sandbox-exec` is missing or the profile fails to load, the child runs unsandboxed rather than failing — a bad profile can never brick the shell tool. Set `FROGLIPS_NO_SHELL_SANDBOX=1` to disable. This composes with the other shell hardening in `capped_output(…, harden=true)`: a secret/loader-key env scrub, `setsid` + process-group kill on timeout/cancel, and `RLIMIT_FSIZE`/no-core. The per-call approval prompt is still the primary boundary; the sandbox is defense-in-depth for an approved-but-malicious command.

## Authorization model

Beyond the path sandbox, the agent's authorization layer enforces:

- **No blanket subagent inheritance.** Subagents do not inherit the parent's
  session-wide shell/write approvals (see `spawn_subagent` above).
- **Repo-supplied policy cannot auto-approve.** Auto-approve entries in a
  repo-local policy file are ignored, and `run_shell` / `applescript_run` can
  never be auto-approved from a project policy. When a repo-supplied policy is
  in effect the UI warns the user.
- **Body-bearing `http_request` is elevated risk** — always confirmation-gated.
- **MCP tool descriptions are sanitized** before they enter the system prompt,
  so a malicious MCP server can't inject instructions through its tool
  metadata. The tool audit log redacts secrets, and raw MCP protocol lines are
  no longer logged.
- **MCP tools are risk-classified and always require confirmation.** An MCP
  server's tools are treated as untrusted: every MCP tool call is
  confirmation-gated and can never be auto-approved, even under session
  approvals or a project policy. Identified via `isMcpToolName(...)` (names
  are minted at runtime as `mcp__<server>__<tool>`; static deny lists alone
  could never enumerate them).
- **Path-aware risk escalation for writes.** `classifyToolRisk` inspects
  the `path` / `from` / `to` arguments of `write_file` / `edit_file` /
  `multi_edit` / `make_dir` / `move_path` / `copy_path` and escalates the
  call to `destructive` when the target lands in a sensitive location —
  `/etc/`, `/Library/Launch{Agents,Daemons}/`, shell rc files (`.zshrc`,
  `.bashrc`, …), `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, or any `*.app` /
  `*.command` / `*.terminal` / `*.workflow` / `*.tool` bundle (root or
  internal writes). Lexical `..`-collapse runs before the prefix check so
  `~/foo/../../etc/hosts` doesn't slip through as "normal". The session
  blanket `approveAllWrite` cannot waive a `destructive` risk — the
  confirmation modal still fires.
- **Deny reason taxonomy.** `ConfirmDecision.reason` carries one of
  `"user_allow"` (human clicked Allow), `"user_deny"` (human clicked Deny),
  `"aborted"` (run-level abort fired while the modal was open), or
  `"unattended_denied"` (default deny-all gate). The taxonomy is preserved
  in the audit row's `errorKind`; the model-facing tool body collapses all
  deny paths to a single learnable `kind: "permission_denied"`.
- **Workflow approval — per-card `unattended` flag** is the only knob. The
  run-panel "Auto-approve file writes" checkbox + the workflow's approval
  modal have both been removed; per-call gating in workflows now collapses
  to: if `card.unattended === true` the card blanket-approves its own tool
  calls (relying on the Rust write-layer + shell-risk classifier as the
  authoritative gates), otherwise dangerous calls follow the same agent-loop
  confirm path as chat. Scheduled (unattended-trigger) runs additionally
  apply the curated never-auto deny list — `run_shell`, `applescript_run`,
  `delete_path`, `kill_process`, `agent_undo`, `http_request`,
  `spawn_subagent`, MCP-routed tools — refused with no UI prompt at all.
- **Replayed workflow skills are gated identically.** A saved workflow *skill*
  (`workflow_invoke_skill`) replays its steps by calling `executeTool`
  directly, which bypasses the loop's confirmation gate. To prevent unattended
  execution of dangerous steps, the replay path fails closed: any step whose
  tool is in `DANGEROUS_TOOLS`, is MCP-routed, or is a recursion/subagent tool
  is refused at replay (`kind: "forbidden_step_tool"`) rather than run. Only
  read-only / safe steps replay without a prompt.
- **Research-budget nudge.** After 10 successful external research calls
  (`web_search` / `web_fetch` / `read_pdf` only — local fs reads excluded
  so codebase exploration isn't punished) without any write, the agent loop
  injects a one-time system reminder telling the model to stop researching
  and produce the deliverable via `write_file` / `edit_file` / `multi_edit`.
  Fires only when the card has a write tool in scope; mutex'd with the
  consecutive-tool-error stop hint to avoid contradictory messages.

## Adding a tool

For tools outside the path-sandbox model (web, OS-native, code intel, etc.) put them in the relevant `agent/` module (e.g. `agent/web.rs`, `agent/code.rs`) w/o `validate_for_*` calls — but still gate dangerous behavior at `DANGEROUS_TOOLS`. For task-queue–like long-running infrastructure, use a separate module (`task_queue.rs`, `ask_user.rs`) and expose Tauri commands.

1. Implement the logic in the appropriate `src-tauri/src/agent/*.rs` module. Use `validate_for_read` / `validate_for_write` to get a resolved + sandboxed `PathBuf`. Return `Result<MyResult, String>` where the error string is `err_string(ToolError::…)`.
2. Add a Tauri command wrapper in `src-tauri/src/commands/agent.rs`:
   ```rust
   #[tauri::command]
   async fn agent_my_tool(arg: String) -> Result<agent::MyResult, String> {
       agent::my_tool(arg).await
   }
   ```
   And register it in the `generate_handler!` list in `src-tauri/src/lib.rs::run()`.
3. Add to `src/lib/tauri-api.ts`:
   ```ts
   agentMyTool: (arg: string) => invoke<MyResult>("agent_my_tool", { arg }),
   ```
4. Add to the `TOOLS` array in `src/lib/agent-loop/tools.ts` with a JSON Schema describing the parameters. Add a `case "my_tool":` to the dispatcher in `src/lib/agent-loop/dispatch.ts`.
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

`src/lib/agent-loop/` (`ollama-client.ts`, `runner.ts`, `subagent.ts`):

| Constant | Default | What |
|---|---|---|
| `OLLAMA_BASE` | `http://127.0.0.1:11434` | Ollama URL |
| `MAX_ITERATIONS` | 40 | Loop budget |
| `MAX_CONSECUTIVE_TOOL_ERRORS` | 5 | Trip "stop retrying, report" hint |
| `RESEARCH_NUDGE_THRESHOLD` | 10 | External research calls without writes → one-time nudge |
| `DEDUPE_WINDOW` | 3 | How many recent calls to track for repeat detection |
| `STALL_SAME_PATH_LIMIT` | 6 | `read_file` repeat-cap before stall hint |
| `RETRY_MAX` | 2 | Ollama retry count |
| `RETRY_BACKOFF_MS` | 500 | Initial backoff (multiplied by attempt+1) |
| `OLLAMA_REQUEST_TIMEOUT_MS` | 120 000 | Per-request timeout combined with caller's signal |
| `MAX_SUBAGENT_DEPTH` | 3 | Recursion cap for `spawn_subagent` |
| `HANDOFF_OUTPUT_CAP` | 65 536 | Workflow card→card output cap (surrogate-safe) |
| `RECORD_OUTPUT_CAP` | 6 144 | Workflow run-record per-card output cap |

`src-tauri/src/agent/`:

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
