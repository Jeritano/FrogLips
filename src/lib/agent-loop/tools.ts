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
        "Execute a shell command via sh -c. Optional cwd + env. 30s timeout. ALWAYS requires user approval. Returns stdout, stderr, exit_code, duration_ms, timed_out.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string passed to sh -c." },
          cwd: { type: "string", description: "Optional working directory." },
        },
        required: ["command"],
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
      description: "Start a long-running shell command in the background. Returns a task_id immediately. Use task_status/task_result/task_cancel to inspect.",
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
] as const;
