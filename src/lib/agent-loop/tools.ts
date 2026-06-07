/* ── Tool definitions (OpenAI function format) ── */

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read text contents of a file. Default reads up to 65536 bytes — DO NOT pass a small limit (anything under 8192 is auto-raised). Only paginate with offset when total_bytes exceeds 65536. Returns content, bytes_read, total_bytes, truncated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path or ~/relative path." },
          offset: { type: "number", description: "Byte offset to start reading (default 0). Only use when continuing a previously-truncated read." },
          limit: { type: "number", description: "Max bytes to read (default 65536, minimum 8192). Omit unless you specifically need less than the whole file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List directory entries (max 500). Returns {entries: [{name, kind, size}], truncated}.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path or ~/relative path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search for text across files under a directory (line-grep, recursive). Set regex=true for regex pattern matching. Skips .git/node_modules/target/etc.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Root directory to search." },
          pattern: { type: "string", description: "Text or regex to find." },
          glob: {
            type: "string",
            description: "Optional filename glob, e.g. '*.ts' or '*.py'. Defaults to '*'.",
          },
          regex: { type: "boolean", description: "Treat pattern as a regex (Rust regex syntax)." },
        },
        required: ["path", "pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "multi_edit",
      description:
        "Apply multiple find-and-replace edits to a single file atomically — either all succeed or none do. Edits are applied sequentially. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean" },
              },
              required: ["old_string", "new_string"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Run `git status --short --branch` in the workspace (or given path). Returns stdout, stderr, exit_code.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Optional working directory; defaults to workspace root." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Run `git diff` in the workspace (or given path). Set staged=true for `--staged`.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          staged: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_exists",
      description: "Check whether a path exists; returns {exists, kind, size}.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Execute a shell command via sh -c. Optional cwd + per-call timeout. Default timeout 30s; pass timeout_secs (clamped 1-600) for slow builds, test suites, or downloads. ALWAYS requires user approval. Returns stdout, stderr, exit_code, duration_ms, timed_out.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string passed to sh -c." },
          cwd: { type: "string", description: "Optional working directory." },
          timeout_secs: {
            type: "integer",
            description:
              "Wall-clock budget in seconds. Defaults to 30. Clamped to [1, 600] server-side. Use a longer value for cargo build / npm install / test suites that legitimately exceed the default.",
            minimum: 1,
            maximum: 600,
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Run a snippet of code in a throwaway interpreter and capture its output. Supported languages: python, node (javascript), bash, sh, ruby. The code is written to a temp file and executed directly (no shell re-parsing). Default timeout 30s; pass timeout_secs (clamped 1-600). ALWAYS requires user approval — this is arbitrary code execution. Returns stdout, stderr, exit_code, duration_ms, timed_out. Prefer this over run_shell for multi-line logic, data processing, or math beyond `calculate`.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            description: "One of: python, node, javascript, bash, sh, ruby.",
            enum: ["python", "node", "javascript", "bash", "sh", "ruby"],
          },
          code: { type: "string", description: "The source code to execute." },
          timeout_secs: {
            type: "integer",
            description: "Wall-clock budget in seconds. Defaults to 30. Clamped to [1, 600] server-side.",
            minimum: 1,
            maximum: 600,
          },
        },
        required: ["language", "code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Evaluate an arithmetic expression exactly (no LLM guessing). Supports + - * / % ^, parentheses, unary minus, and functions sqrt/abs/sin/cos/tan/asin/acos/atan/ln/log/log2/exp/floor/ceil/round/sign plus constants pi/e/tau. Safe — never executes code. Use this for any non-trivial number crunching. Returns { ok, result } or { ok:false, error }.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "e.g. '2 + 3 * 4', 'sqrt(16) + log(1000)', '(1+2)^10'." },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save a durable fact to long-term memory so it can be recalled in future runs/conversations. Auto-embeds + de-duplicates. Scope: 'global' (default, everywhere), 'project' (this workspace only), or 'conversation' (this chat only). Use for stable preferences, decisions, or facts — NOT transient task state (use the workflow scratchpad for that).",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact to remember, as a self-contained sentence." },
          scope: { type: "string", enum: ["global", "project", "conversation"], description: "Visibility scope. Default global." },
          tags: { type: "string", description: "Optional comma-separated tags (no newlines)." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description:
        "Search long-term memory for facts relevant to a query (vector search with keyword fallback). Returns up to k matching memories with their content, tags, scope, and similarity score. Call this before answering when prior context might help.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up." },
          k: { type: "integer", description: "Max results (1-20). Default 5.", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write text content to a file, creating parents. ALWAYS requires user approval. Prefer edit_file for changes to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Find-and-replace edit on an existing file. old_string must appear exactly once unless replace_all=true. Returns {replacements, new_size}. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Run `git log --oneline --decorate -n <limit>` (default 20, max 200).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_show",
      description: "Run `git show <ref>` — view commit details + diff. Ref must be alphanumeric + ./_/-/slash.",
      parameters: {
        type: "object",
        properties: {
          reference: { type: "string" },
          path: { type: "string" },
        },
        required: ["reference"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_branches",
      description: "Run `git branch -a` — list local + remote branches.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Commit already-staged changes with a message. Requires user approval. Does NOT stage files — use run_shell `git add` first.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" }, path: { type: "string" } },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "GET a URL and return its text content (HTML auto-stripped). Blocks loopback/private/link-local hosts (SSRF defense). 15s timeout, 1 MiB response cap.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web via DuckDuckGo. Returns up to 20 hits with title/url/snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          n: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pdf",
      description: "Extract text from a PDF file at the given path. Optional byte-cap on output.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Capture the screen via macOS `screencapture -x`. Saves to /tmp if no out_path. Returns the file path.",
      parameters: {
        type: "object",
        properties: { out_path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clipboard_get",
      description: "Read the user's macOS clipboard. Returns text only; large content truncated.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "clipboard_set",
      description: "Write text to the user's macOS clipboard. Requires approval — clipboard may hold sensitive data.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_app",
      description: "Launch a macOS app by name via `open -a` (e.g. \"Safari\", \"Visual Studio Code\"). Requires approval.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_notification",
      description: "Display a native macOS notification.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applescript_run",
      description:
        "Execute an AppleScript via osascript. Powerful — can drive any scriptable app. ALWAYS requires user approval. 30s timeout.",
      parameters: {
        type: "object",
        properties: { script: { type: "string" } },
        required: ["script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Generic HTTP request (GET/POST/PUT/PATCH/DELETE/HEAD). SSRF-protected. Body capped at 1 MiB. Requires user approval — can exfil data or write to external services.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string" },
          url: { type: "string" },
          headers: { type: "object" },
          body: { type: "string" },
          timeout_secs: { type: "number" },
        },
        required: ["method", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_definition",
      description: "Locate the definition of a symbol (function/class/struct/etc.) via heuristic regex across the workspace. Symbol must be [A-Za-z0-9_]+.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          path: { type: "string" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_references",
      description: "Locate all references to a symbol via word-boundary regex across the workspace.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          path: { type: "string" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "format_code",
      description: "Format a code file via the right formatter for its extension (prettier for ts/js/json/css/md/yaml, rustfmt for .rs, black for .py, gofmt for .go, swift-format for .swift).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_create",
      description: "Start a long-running shell command in the background. Returns a task_id immediately. Use task_status to check progress and read output, task_list to see all tasks, and task_cancel to stop one.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_status",
      description: "Get the current status + result (if finished) of a background task.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_list",
      description: "List all background tasks the agent has started this session.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "task_cancel",
      description: "Cancel a running background task. Idempotent on terminal-state tasks.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Pause the agent and prompt the user for an answer. Use when you genuinely need info you can't get from tools (preference, missing parameter, ambiguity). Returns the user's typed text.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          hint: { type: "string", description: "Optional helper text shown under the question." },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "watch_path",
      description:
        "Start watching a file or directory for changes. Returns {watch_id: 'w_xxx', path, glob}. Use poll_watch repeatedly to drain events. Pair this with run_shell/task_create for build-watch or test-watch loops. Cross-platform (FSEvents/inotify/ReadDirectoryChangesW).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or ~/relative path. Directories are watched recursively." },
          glob: { type: "string", description: "Optional glob to filter events by path, e.g. '**/*.ts' or '**/*.rs'." },
          debounce_ms: { type: "number", description: "Optional debounce window in ms — collapses same-path same-kind bursts. Useful for editor-save patterns." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "poll_watch",
      description:
        "Drain filesystem events accumulated by a watcher since `since_ms` (or all if unset). Returns {events: [{kind, path, ts}], next_ts, dropped}. Pass next_ts back as since_ms on the next call. `dropped` reports events elided by the per-call max (ring-buffer overflow is in list_watches).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "watch_id returned by watch_path." },
          since_ms: { type: "number", description: "Unix-ms cursor — drain only events with ts > since_ms." },
          max_events: { type: "number", description: "Cap on events returned (default 100). Overflow stays buffered for the next poll." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_watch",
      description: "Stop a filesystem watcher and release its OS-level watch handle.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "watch_id to stop." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_watches",
      description: "List active filesystem watchers — id, path, glob, started_at, events_seen, buffered, dropped.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Open a URL in a controlled Chrome/Chromium instance and return the page title + URL + a base64 PNG screenshot. SSRF-protected (no loopback/private/link-local hosts; no file://, chrome://). One persistent browser session per app run — subsequent browser_* calls reuse the same tab. Requires a Chrome/Chromium binary installed on the user's machine. The browser_ prefix means actions are visible to the user — there are no silent navigations.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL to open. data: URLs are also allowed for offline payloads." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click an element in the current browser session. Selector is a CSS selector. Fails if no browser session is open or the selector matches nothing.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector to click." },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fill",
      description:
        "Focus an input via CSS selector and type a value into it. Fails if no browser session is open or the selector matches nothing.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the input/textarea." },
          value: { type: "string", description: "Text to type." },
        },
        required: ["selector", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Capture a PNG screenshot of the current browser tab. Returns {base64}. Fails if no browser session is open.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_get_text",
      description:
        "Return innerText for the matched element (defaults to body). Output capped at 64 KiB. Fails if no browser session is open.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector; defaults to 'body'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description:
        "Close the persistent browser session. Idempotent — safe to call when no session exists.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_project_knowledge",
      description:
        "Semantic search over an indexed local folder (RAG). Returns top-K matching chunks with file paths and snippets. Index folders first via the RAG panel in agent settings; this tool only reads.",
      parameters: {
        type: "object",
        properties: {
          corpus_name: { type: "string", description: "Name of the indexed corpus to search." },
          query: { type: "string", description: "Natural-language or keyword query." },
          top_k: { type: "number", description: "Max number of hits to return (default 5, max 50)." },
        },
        required: ["corpus_name", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description:
        "Run a fresh agent in an isolated context to handle a sub-task. Default mode 'sync' awaits the sub-agent and returns its final text. Pass mode='async' for parallel fan-out — returns {subagent_id, status:'running'} immediately; join with await_subagents. Max recursion depth 3.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          preset: { type: "string", description: "Optional: general / coder / researcher / shell." },
          mode: {
            type: "string",
            enum: ["sync", "async"],
            description: "'sync' (default) blocks until the subagent finishes. 'async' returns immediately with a subagent_id; use await_subagents to join.",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "await_subagents",
      description:
        "Block until all listed subagent_ids finish (or timeout). Returns per-id {id, status, result}. Finished subagents include their full answer; timed-out ones keep running in the background.",
      parameters: {
        type: "object",
        properties: {
          subagent_ids: {
            type: "array",
            items: { type: "string" },
            description: "IDs returned from spawn_subagent (mode='async').",
          },
          timeout_seconds: {
            type: "number",
            description: "Max seconds to wait for all subagents (default 600).",
          },
        },
        required: ["subagent_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_subagents",
      description:
        "List currently-tracked subagents (running, plus recently-completed within ~60s). Returns [{id, status, started_at, prompt_preview, depth}].",
      parameters: { type: "object", properties: {} },
    },
  },
  // ── Extras: file ops + hash + diff + processes + undo ────────────────────
  // These exist so the model isn't forced to ask for shell approval on
  // every basic mv/cp/rm/mkdir; the dedicated tools still gate destructive
  // ops with a confirmation but at least the prompt copy is honest about
  // what's about to happen ("Move A → B?" instead of "Run `mv A B`?").
  {
    type: "function",
    function: {
      name: "move_path",
      description:
        "Move or rename a file or directory within the workspace. Refuses to clobber an existing destination unless overwrite=true. ALWAYS requires user approval. Cheaper than run_shell mv.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source path." },
          to: { type: "string", description: "Destination path." },
          overwrite: {
            type: "boolean",
            description: "Replace an existing destination. Default false.",
          },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copy_path",
      description:
        "Copy a single file (not a directory) within the workspace. Source ≤ 256 MiB. Refuses to clobber existing destination unless overwrite=true. ALWAYS requires user approval.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source file path." },
          to: { type: "string", description: "Destination file path." },
          overwrite: {
            type: "boolean",
            description: "Replace an existing destination. Default false.",
          },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_path",
      description:
        "Delete a file or empty directory. Pass recursive=true for non-empty directories (capped at 1000 entries — bigger trees still need shell with approval). ALWAYS requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to delete." },
          recursive: {
            type: "boolean",
            description: "Allow non-empty directory deletion. Default false.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_dir",
      description:
        "Create a directory and any missing parents. Idempotent — returns created=false if it already existed. ALWAYS requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to create." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hash_file",
      description:
        "Compute a SHA-2 hash of a file's contents (sha256 default; sha512 also supported). Source ≤ 1 GiB. Read-only — no approval needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to hash." },
          algorithm: {
            type: "string",
            enum: ["sha256", "sha512"],
            description: "Hash algorithm. Default sha256.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diff_files",
      description:
        "Unified diff between two arbitrary files (works outside git repos via `git diff --no-index`). Each side ≤ 4 MiB. Returns {diff, identical}. Read-only — no approval needed.",
      parameters: {
        type: "object",
        properties: {
          left: { type: "string", description: "First file path." },
          right: { type: "string", description: "Second file path." },
        },
        required: ["left", "right"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_processes",
      description:
        "List running processes (top 200 by CPU). Optional case-insensitive filter on the command name. Returns rows of {pid, ppid, cpu_pct, mem_mib, command}. Read-only.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description: "Optional substring filter on the command name.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_process",
      description:
        "Send a POSIX signal to a process. Default signal TERM; KILL/HUP/INT/QUIT/USR1/USR2 also allowed (other values fall back to TERM). Refuses pid<=1. ALWAYS requires user approval.",
      parameters: {
        type: "object",
        properties: {
          pid: { type: "integer", description: "Target process id." },
          signal: {
            type: "string",
            description: "Signal name (without the leading SIG). Default TERM.",
          },
        },
        required: ["pid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_undo",
      description:
        "Revert the most recent write_file / edit_file / multi_edit by restoring the file's prior contents (or deleting it if the snapshot recorded the file as new). Up to 50 edits are tracked in memory; the stack drops on app restart. ALWAYS requires user approval.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_undo",
      description:
        "List the in-memory undo stack newest-first so you can see what agent_undo would revert. Returns rows of {path, kind, taken_at_ms, size_bytes, was_absent}. Read-only.",
      parameters: { type: "object", properties: {} },
    },
  },
  /* ── Workflow-only tools (Phase 1.1 + 1.2). Only meaningful inside a
       running workflow card — outside that scope they return
       {ok:false, kind:"not_in_workflow"}. Add to the card's `tools`
       allowlist to make them callable. ──────────────────────────── */
  {
    type: "function",
    function: {
      name: "workflow_set",
      description:
        "Write a value to the workflow scratchpad — a shared blob other cards in the same run can read. Use for structured state (counts, decisions, intermediate JSON) that doesn't belong in the user-facing prose handoff. Total scratchpad capped at 64 KiB across all keys. Value must be JSON-serializable.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Identifier within this run's scratchpad. Use snake_case names like 'research_summary' or 'urls_to_visit'.",
          },
          value: {
            description: "Anything JSON-serializable (string, number, boolean, null, object, array).",
          },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_get",
      description:
        "Read a value the current workflow run previously stored via workflow_set. Returns {ok:true, value} on hit, {ok:false, kind:'missing_key'} when no such key exists in this run.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_keys",
      description:
        "List the keys currently in the workflow scratchpad for THIS run. Use to discover what an upstream card wrote without trial-and-error workflow_get calls.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_get_prior_run",
      description:
        "Read the recorded output of a card from a PRIOR run of the same workflow (i.e. last week's run of this card). Returns the most recent matching run by default. Use to chain a daily workflow off the previous day's findings.",
      parameters: {
        type: "object",
        properties: {
          card_id: {
            type: "string",
            description: "Card id whose recorded output you want.",
          },
          run_id: {
            type: "number",
            description: "Optional specific workflow_runs.id. If omitted, returns the most recent successful run that contains this card.",
          },
        },
        required: ["card_id"],
      },
    },
  },
  /* ── Procedural memory: workflow_save_skill / workflow_list_skills /
       workflow_get_skill / workflow_invoke_skill / workflow_delete_skill.
       All five require an active workflow context — they return
       {ok:false, kind:"not_in_workflow"} when called from chat mode. ── */
  {
    type: "function",
    function: {
      name: "workflow_save_skill",
      description:
        "Save the just-completed sequence of tool calls as a reusable named skill scoped to this workflow. Steps are an array of {tool, args} entries replayed by workflow_invoke_skill on later runs.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Unique skill name within this workflow.",
          },
          description: {
            type: "string",
            description: "Short human-readable description of what the skill does.",
          },
          steps: {
            type: "array",
            description:
              "Ordered list of tool calls to replay. Each step is `{tool: \"<tool_name>\", args: {<tool args>}}`. Cannot contain workflow_invoke_skill / workflow_save_skill / workflow_delete_skill / spawn_subagent / await_subagents.",
            items: {
              type: "object",
              properties: {
                tool: { type: "string" },
                args: { type: "object" },
              },
              required: ["tool", "args"],
            },
          },
          overwrite: {
            type: "boolean",
            description: "When true, replace an existing skill with the same name. Default false (refuses to clobber).",
          },
        },
        required: ["name", "description", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_list_skills",
      description:
        "List skills saved for the current workflow. Returns summary rows (id, name, description, last_used_at, invocation_count) — use workflow_get_skill to fetch full step lists.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_get_skill",
      description:
        "Get a saved skill's full definition including its step list. Returns null when no skill with that name exists in the current workflow.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_invoke_skill",
      description:
        "Run a previously-saved skill. Each step is dispatched as a normal tool call honoring this card's allowlist + approval policy. Aborts on the first step that returns ok:false. Rate-limited to 10 invocations of the same skill per workflow run.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to invoke." },
          args_override: {
            type: "object",
            description:
              "Optional object shallow-merged into each step's args (call-site overrides take precedence over saved args).",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_delete_skill",
      description: "Delete a saved skill from the current workflow.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  /* ── Claude Skills (imported Anthropic SKILL.md packages). Read-only,
       no-approval tools the chat agent uses to enumerate or load
       user-imported skill instructions on demand. The actual skill body
       may reference Anthropic-style tool names (Read, Write, Bash, etc.)
       — see the translation glossary in the chat system prompt that the
       runner prepends when any skill is enabled. ─────────────────── */
  {
    type: "function",
    function: {
      name: "list_claude_skills",
      description:
        "List the user's imported Claude Skills (name + description only). Call this if you need to see what skills are available before deciding which to load.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "load_claude_skill",
      description:
        "Load a Claude Skill by name. Returns the full markdown instructions for the skill. The skill body may reference Anthropic-style tool names (Read, Write, Bash, etc.) — see the translation glossary in the chat system prompt.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The skill name as returned by list_claude_skills.",
          },
        },
        required: ["name"],
      },
    },
  },
] as const;
