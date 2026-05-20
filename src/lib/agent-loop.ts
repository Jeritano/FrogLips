import { api } from "./tauri-api";
import type { Message, ToolCall } from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
   Agentic loop for locally-running tool-calling models via Ollama's /api/chat.

   Flow per iteration:
   1. POST messages + tool defs to Ollama (non-streaming)
   2. If response has tool_calls → confirm dangerous ones → execute → loop
   3. If no tool_calls → that's the final text answer → return it
   ──────────────────────────────────────────────────────────────────────────── */

const OLLAMA_BASE = "http://127.0.0.1:11434";
const MAX_ITERATIONS = 20;
const DEDUPE_WINDOW = 3;
const RETRY_MAX = 2;
const RETRY_BACKOFF_MS = 500;

export type AgentStatus = "idle" | "thinking" | "tool" | "done" | "error";

export interface AgentMetrics {
  iterations: number;
  toolCalls: number;
  totalToolMs: number;
  totalLlmMs: number;
  retries: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ConfirmDecision {
  approve: boolean;
  remember?: boolean;
}

export interface AgentRunOptions {
  model: string;
  messages: Message[];
  conversationId: number;
  workspaceRoot: string | null;
  /** Optional system-prompt override (from active preset). */
  systemPromptOverride?: string;
  /** Tools the user has allowed for this conversation. Empty = all allowed. */
  toolAllowlist?: string[];
  /** Session-scoped flags: dangerous tools auto-approved if true. */
  approveAllShell?: boolean;
  approveAllWrite?: boolean;
  /** Shell command prefixes auto-approved this session (e.g. "git", "ls"). */
  approvedShellPrefixes?: string[];
  /** Called when user opts into "remember this command pattern". */
  onApproveShellPrefix?: (prefix: string) => void;
  onUpdate: (msgs: Message[]) => void;
  onStatusChange: (status: AgentStatus) => void;
  onMetrics?: (m: AgentMetrics) => void;
  requestConfirmation: (
    toolName: string,
    args: Record<string, unknown>,
    risk: string,
  ) => Promise<ConfirmDecision>;
  signal: AbortSignal;
  /** Internal: depth counter for spawn_subagent recursion guard. */
  _subagentDepth?: number;
}

const MAX_SUBAGENT_DEPTH = 3;

/* ── Tool definitions (OpenAI function format) ── */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read text contents of a file. Supports pagination via offset/limit (bytes). Returns content, bytes_read, total_bytes, truncated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path or ~/relative path." },
          offset: { type: "number", description: "Byte offset to start reading (default 0)." },
          limit: { type: "number", description: "Max bytes to read (default 65536)." },
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
      name: "spawn_subagent",
      description: "Run a fresh agent in an isolated context to handle a sub-task. Useful for parallel research or scoped exploration. Returns the sub-agent's final text. Max recursion depth 3.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          preset: { type: "string", description: "Optional: general / coder / researcher / shell." },
        },
        required: ["prompt"],
      },
    },
  },
] as const;

const DANGEROUS_TOOLS = new Set([
  "run_shell", "write_file", "edit_file", "multi_edit",
  "git_commit", "clipboard_set", "open_app",
  "applescript_run", "http_request",
]);
const SHELL_TOOL = "run_shell";
const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "multi_edit",
  "git_commit", "clipboard_set", "applescript_run", "http_request",
]);

/* ── Tool execution ── */

function parseArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; err: string } {
  if (typeof raw === "string") {
    try {
      return { ok: true, args: JSON.parse(raw) };
    } catch (e) {
      return { ok: false, err: `Could not parse tool arguments as JSON: ${e}` };
    }
  }
  if (raw != null && typeof raw === "object") {
    return { ok: true, args: raw as Record<string, unknown> };
  }
  return { ok: true, args: {} };
}

function formatToolError(raw: unknown): string {
  const s = String((raw as { message?: string })?.message ?? raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && parsed.kind && parsed.message) {
      return JSON.stringify({ ok: false, kind: parsed.kind, message: parsed.message });
    }
  } catch {/* fallthrough */}
  return JSON.stringify({ ok: false, kind: "unknown", message: s });
}

let currentShellOpId: string | null = null;

export function cancelActiveShell(): boolean {
  if (currentShellOpId) {
    const id = currentShellOpId;
    currentShellOpId = null;
    api.agentCancelShell(id).catch(() => {});
    return true;
  }
  return false;
}

async function runSubagent(
  args: Record<string, unknown>,
  parent: AgentRunOptions,
): Promise<string> {
  const depth = (parent._subagentDepth ?? 0) + 1;
  if (depth > MAX_SUBAGENT_DEPTH) {
    return JSON.stringify({
      ok: false,
      kind: "depth_exceeded",
      message: `spawn_subagent depth cap (${MAX_SUBAGENT_DEPTH}) reached`,
    });
  }
  const prompt = String(args.prompt ?? "");
  if (!prompt.trim()) {
    return JSON.stringify({ ok: false, kind: "invalid_argument", message: "prompt is empty" });
  }
  const presetId = args.preset ? String(args.preset) : null;

  // Lazy-load presets to avoid a static cycle.
  const { loadAllPresets } = await import("./agent-presets");
  const presets = loadAllPresets();
  const chosen = presetId ? presets.find((p) => p.id === presetId) : undefined;

  const subOpts: AgentRunOptions = {
    model: parent.model,
    messages: [
      { conversation_id: parent.conversationId, role: "user", content: prompt },
    ],
    conversationId: parent.conversationId,
    workspaceRoot: parent.workspaceRoot,
    systemPromptOverride: chosen?.systemPromptOverride ?? parent.systemPromptOverride,
    toolAllowlist: chosen?.allowedTools.length ? chosen.allowedTools : parent.toolAllowlist,
    approveAllShell: parent.approveAllShell,
    approveAllWrite: parent.approveAllWrite,
    approvedShellPrefixes: parent.approvedShellPrefixes,
    onApproveShellPrefix: parent.onApproveShellPrefix,
    // Suppress UI noise: subagent runs are background work; parent's
    // metrics + UI shouldn't see every intermediate step.
    onUpdate: () => {},
    onStatusChange: () => {},
    onMetrics: () => {},
    requestConfirmation: parent.requestConfirmation,
    signal: parent.signal,
    _subagentDepth: depth,
  };
  const final = await runAgentLoop(subOpts);
  return JSON.stringify({
    ok: true,
    depth,
    preset: presetId,
    answer: final ?? "(subagent returned nothing)",
  });
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file": {
      const r = await api.agentReadFile(
        String(args.path ?? ""),
        typeof args.offset === "number" ? args.offset : undefined,
        typeof args.limit === "number" ? args.limit : undefined,
      );
      return JSON.stringify(r);
    }
    case "list_dir": {
      const r = await api.agentListDir(String(args.path ?? ""));
      return JSON.stringify(r);
    }
    case "search_files": {
      const r = await api.agentSearchFiles(
        String(args.path ?? ""),
        String(args.pattern ?? ""),
        args.glob ? String(args.glob) : undefined,
        typeof args.regex === "boolean" ? args.regex : undefined,
      );
      return JSON.stringify(r);
    }
    case "multi_edit": {
      const edits = Array.isArray(args.edits) ? (args.edits as Array<{ old_string: string; new_string: string; replace_all?: boolean }>) : [];
      const r = await api.agentMultiEdit(String(args.path ?? ""), edits);
      return JSON.stringify(r);
    }
    case "git_status": {
      const r = await api.agentGitStatus(args.path ? String(args.path) : undefined);
      return JSON.stringify(r);
    }
    case "git_diff": {
      const r = await api.agentGitDiff(
        args.path ? String(args.path) : undefined,
        typeof args.staged === "boolean" ? args.staged : undefined,
      );
      return JSON.stringify(r);
    }
    case "git_log": {
      const r = await api.agentGitLog(
        args.path ? String(args.path) : undefined,
        typeof args.limit === "number" ? args.limit : undefined,
      );
      return JSON.stringify(r);
    }
    case "git_show": {
      const r = await api.agentGitShow(
        String(args.reference ?? ""),
        args.path ? String(args.path) : undefined,
      );
      return JSON.stringify(r);
    }
    case "git_branches": {
      const r = await api.agentGitBranches(args.path ? String(args.path) : undefined);
      return JSON.stringify(r);
    }
    case "git_commit": {
      const r = await api.agentGitCommit(
        String(args.message ?? ""),
        args.path ? String(args.path) : undefined,
      );
      return JSON.stringify(r);
    }
    case "web_fetch": {
      const r = await api.agentWebFetch(String(args.url ?? ""));
      return JSON.stringify(r);
    }
    case "web_search": {
      const r = await api.agentWebSearch(
        String(args.query ?? ""),
        typeof args.n === "number" ? args.n : undefined,
      );
      return JSON.stringify(r);
    }
    case "read_pdf": {
      const r = await api.agentReadPdf(
        String(args.path ?? ""),
        typeof args.limit === "number" ? args.limit : undefined,
      );
      return JSON.stringify(r);
    }
    case "screenshot": {
      const r = await api.agentScreenshot(args.out_path ? String(args.out_path) : undefined);
      return JSON.stringify(r);
    }
    case "clipboard_get": {
      const text = await api.agentClipboardGet();
      return JSON.stringify({ ok: true, text });
    }
    case "clipboard_set": {
      await api.agentClipboardSet(String(args.text ?? ""));
      return JSON.stringify({ ok: true });
    }
    case "open_app": {
      await api.agentOpenApp(String(args.name ?? ""));
      return JSON.stringify({ ok: true, app: args.name });
    }
    case "show_notification": {
      await api.agentShowNotification(String(args.title ?? ""), String(args.body ?? ""));
      return JSON.stringify({ ok: true });
    }
    case "applescript_run": {
      const r = await api.agentApplescriptRun(String(args.script ?? ""));
      return JSON.stringify(r);
    }
    case "http_request": {
      const method = String(args.method ?? "GET").toUpperCase() as
        | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
      const headers = args.headers && typeof args.headers === "object"
        ? (args.headers as Record<string, string>)
        : undefined;
      const r = await api.agentHttpRequest({
        method,
        url: String(args.url ?? ""),
        headers,
        body: args.body != null ? String(args.body) : undefined,
        timeout_secs: typeof args.timeout_secs === "number" ? args.timeout_secs : undefined,
      });
      return JSON.stringify(r);
    }
    case "find_definition": {
      const r = await api.agentFindDefinition(
        String(args.symbol ?? ""),
        args.path ? String(args.path) : undefined,
      );
      return JSON.stringify(r);
    }
    case "find_references": {
      const r = await api.agentFindReferences(
        String(args.symbol ?? ""),
        args.path ? String(args.path) : undefined,
      );
      return JSON.stringify(r);
    }
    case "format_code": {
      const r = await api.agentFormatCode(String(args.path ?? ""));
      return JSON.stringify(r);
    }
    case "task_create": {
      const r = await api.taskCreate(
        String(args.command ?? ""),
        args.cwd ? String(args.cwd) : undefined,
      );
      return JSON.stringify(r);
    }
    case "task_status": {
      const r = await api.taskStatus(String(args.id ?? ""));
      return JSON.stringify(r);
    }
    case "task_list": {
      const r = await api.taskList();
      return JSON.stringify(r);
    }
    case "task_cancel": {
      await api.taskCancel(String(args.id ?? ""));
      return JSON.stringify({ ok: true });
    }
    case "ask_user": {
      const answer = await api.agentAskUser(
        String(args.question ?? ""),
        args.hint ? String(args.hint) : undefined,
      );
      return JSON.stringify({ ok: true, answer });
    }
    // spawn_subagent handled specially in the loop — needs access to opts.
    case "file_exists": {
      const r = await api.agentFileExists(String(args.path ?? ""));
      return JSON.stringify(r);
    }
    case "run_shell": {
      const cwd = args.cwd ? String(args.cwd) : undefined;
      const opId = `shell-${crypto.randomUUID()}`;
      currentShellOpId = opId;
      try {
        const r = await api.agentRunShell(
          String(args.command ?? ""),
          cwd ? { cwd } : undefined,
          opId,
        );
        return JSON.stringify(r);
      } finally {
        if (currentShellOpId === opId) currentShellOpId = null;
      }
    }
    case "write_file":
      await api.agentWriteFile(String(args.path ?? ""), String(args.content ?? ""));
      return JSON.stringify({ ok: true, path: args.path });
    case "edit_file": {
      const r = await api.agentEditFile(
        String(args.path ?? ""),
        String(args.old_string ?? ""),
        String(args.new_string ?? ""),
        typeof args.replace_all === "boolean" ? args.replace_all : undefined,
      );
      return JSON.stringify(r);
    }
    default:
      return JSON.stringify({ ok: false, kind: "unknown_tool", message: `Unknown tool: ${name}` });
  }
}

/* ── Dynamic system prompt ── */

function buildSystemPrompt(
  workspaceRoot: string | null,
  allowlist: string[],
  override?: string,
): string {
  const tools = allowlist.length
    ? TOOLS.filter((t) => allowlist.includes(t.function.name)).map((t) => t.function.name)
    : TOOLS.map((t) => t.function.name);
  const ws = workspaceRoot
    ? `Workspace root: ${workspaceRoot} — all file access is confined to this directory.`
    : "No workspace root set — you have full filesystem access (within OS permissions).";
  const env = `${ws}\nHost OS: macOS (Darwin). Use macOS commands (e.g. \`open -a Safari https://example.com\`).\nAvailable tools: ${tools.join(", ")}`;
  if (override && override.trim()) {
    return `${override.trim()}\n\n${env}`;
  }
  return `You are an autonomous agent running on the user's local machine.

${env}

Rules:
1. When the user asks you to do something actionable (open an app, read files, run a command, modify files), CALL THE TOOLS. Don't describe what you would do.
2. You have full tool access — never claim you "can't".
3. Prefer edit_file over write_file for existing files (smaller, safer).
4. After each tool result (returned as JSON), inspect it before deciding the next step.
5. If a tool returns {"ok": false, "kind": "...", "message": "..."}, read the kind and adapt — e.g. on "not_found" try a different path, on "outside_workspace" stay in scope.
6. Only respond with prose when (a) you've completed the task and are reporting results, or (b) you genuinely need clarification.
7. Don't loop: if you've called the same tool with the same arguments twice, try a different approach.`;
}

/* ── Message serialisation ── */

function toOllamaMessages(msgs: Message[]) {
  return msgs.map((m) => {
    if (m.role === "tool") {
      return { role: "tool" as const, content: m.content };
    }
    if (m.tool_calls?.length) {
      return { role: "assistant" as const, content: m.content ?? "", tool_calls: m.tool_calls };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });
}

function makeTmpKey() {
  return `tmp:${crypto.randomUUID()}`;
}

function toolCallSig(tc: ToolCall): string {
  const name = tc.function?.name ?? "";
  const args = tc.function?.arguments;
  const argStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return `${name}::${argStr}`;
}

const OLLAMA_REQUEST_TIMEOUT_MS = 120_000;

function combinedSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(parent.reason);
  if (parent.aborted) ctrl.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(new DOMException("Ollama request timed out", "TimeoutError")), timeoutMs);
  ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return ctrl.signal;
}

async function callOllamaWithRetry(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onRetry: () => void,
): Promise<Record<string, unknown>> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (signal.aborted) throw new Error("aborted");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: combinedSignal(signal, OLLAMA_REQUEST_TIMEOUT_MS),
      });
      if (res.status >= 500 && attempt < RETRY_MAX) {
        onRetry();
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      lastErr = e;
      if (signal.aborted) throw e;
      // network / fetch errors retry up to RETRY_MAX
      if (attempt < RETRY_MAX) {
        onRetry();
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("Ollama call failed");
}

/* ── Main loop ── */

export async function runAgentLoop(opts: AgentRunOptions): Promise<string | null> {
  const {
    model, onUpdate, onStatusChange, onMetrics, requestConfirmation, signal,
    workspaceRoot, systemPromptOverride,
    toolAllowlist = [], approveAllShell, approveAllWrite,
    approvedShellPrefixes = [], onApproveShellPrefix,
  } = opts;
  const msgs: Message[] = [...opts.messages];

  const sysMsg: Message = {
    conversation_id: opts.conversationId,
    role: "system",
    content: buildSystemPrompt(workspaceRoot, toolAllowlist, systemPromptOverride),
  };
  msgs.unshift(sysMsg);

  const metrics: AgentMetrics = {
    iterations: 0,
    toolCalls: 0,
    totalToolMs: 0,
    totalLlmMs: 0,
    retries: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
  const recentSigs: string[] = [];

  onStatusChange("thinking");

  // Filter tool defs by allowlist
  const tools = toolAllowlist.length
    ? TOOLS.filter((t) => toolAllowlist.includes(t.function.name))
    : TOOLS;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) return null;
    metrics.iterations = i + 1;

    const llmStart = performance.now();
    let data: Record<string, unknown>;
    try {
      data = await callOllamaWithRetry(
        `${OLLAMA_BASE}/api/chat`,
        {
          model,
          stream: false,
          options: { temperature: 0.4 },
          messages: toOllamaMessages(msgs),
          tools,
        },
        signal,
        () => { metrics.retries++; },
      );
    } catch (e) {
      if (signal.aborted) return null;
      throw e;
    }
    metrics.totalLlmMs += performance.now() - llmStart;
    const promptTok = data?.prompt_eval_count as number | undefined;
    const evalTok = data?.eval_count as number | undefined;
    if (typeof promptTok === "number") metrics.promptTokens += promptTok;
    if (typeof evalTok === "number") metrics.completionTokens += evalTok;
    onMetrics?.({ ...metrics });

    const message = data?.message as Record<string, unknown> | undefined;
    if (!message) throw new Error("No message in Ollama response");

    const toolCalls = (message.tool_calls as ToolCall[] | undefined) ?? [];
    const preludeText = String(message.content ?? "");

    if (toolCalls.length === 0) {
      // Final text response
      const finalMsg: Message = {
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "assistant",
        content: preludeText,
      };
      msgs.push(finalMsg);
      onUpdate([...msgs]);
      onStatusChange("done");
      return preludeText;
    }

    // Dedupe: if every tool call this turn was already seen in the recent
    // window, inject a hint as the tool response instead of executing.
    // Every tool_call needs a matching tool message (per OpenAI tool-call
    // protocol) or the backend will reject the next request — so push one
    // duplicate_call response per call, not just the first.
    const sigs = toolCalls.map(toolCallSig);
    const allRepeated = sigs.every((s) => recentSigs.includes(s));
    if (allRepeated && recentSigs.length > 0) {
      msgs.push({
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "assistant",
        content: preludeText,
        tool_calls: toolCalls,
      });
      const dupBody = JSON.stringify({
        ok: false,
        kind: "duplicate_call",
        message:
          "You just called this exact tool with these exact arguments. Try a different approach or report what you've learned to the user.",
      });
      for (const tc of toolCalls) {
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: dupBody,
          tool_call_id: tc.id,
          tool_name: tc.function?.name ?? "",
        });
      }
      onUpdate([...msgs]);
      continue;
    }
    for (const s of sigs) {
      recentSigs.push(s);
      while (recentSigs.length > DEDUPE_WINDOW * 2) recentSigs.shift();
    }

    // Assistant turn with tool calls
    const asstMsg: Message = {
      _tmpKey: makeTmpKey(),
      conversation_id: opts.conversationId,
      role: "assistant",
      content: preludeText,
      tool_calls: toolCalls,
    };
    msgs.push(asstMsg);
    onUpdate([...msgs]);
    onStatusChange("tool");

    for (const tc of toolCalls) {
      if (signal.aborted) return null;

      const fnName = tc.function?.name ?? "";

      // Allowlist gate
      if (toolAllowlist.length && !toolAllowlist.includes(fnName)) {
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: JSON.stringify({
            ok: false,
            kind: "tool_not_allowed",
            message: `Tool '${fnName}' is not enabled for this conversation.`,
          }),
          tool_call_id: tc.id,
          tool_name: fnName,
        });
        onUpdate([...msgs]);
        continue;
      }

      const parsed = parseArgs(tc.function?.arguments);
      if (!parsed.ok) {
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: JSON.stringify({ ok: false, kind: "bad_arguments", message: parsed.err }),
          tool_call_id: tc.id,
          tool_name: fnName,
        });
        onUpdate([...msgs]);
        continue;
      }
      const args = parsed.args;

      // Confirmation gate for dangerous tools
      if (DANGEROUS_TOOLS.has(fnName)) {
        let risk = "normal";
        if (fnName === SHELL_TOOL) {
          try {
            risk = await api.agentClassifyShell(String(args.command ?? ""));
          } catch {/* keep normal */}
        }
        const cmd = String(args.command ?? "");
        const firstWord = cmd.trim().split(/\s+/)[0] ?? "";
        const prefixApproved =
          fnName === SHELL_TOOL &&
          risk === "normal" &&
          firstWord !== "" &&
          approvedShellPrefixes.includes(firstWord);
        const sessionApproved =
          prefixApproved ||
          (fnName === SHELL_TOOL && approveAllShell && risk === "normal") ||
          (WRITE_TOOLS.has(fnName) && approveAllWrite);
        if (!sessionApproved) {
          const decision = await requestConfirmation(fnName, args, risk);
          if (!decision.approve) {
            msgs.push({
              _tmpKey: makeTmpKey(),
              conversation_id: opts.conversationId,
              role: "tool",
              content: JSON.stringify({
                ok: false,
                kind: "user_denied",
                message: "User denied this tool call.",
              }),
              tool_call_id: tc.id,
              tool_name: fnName,
            });
            onUpdate([...msgs]);
            continue;
          }
          if (
            decision.remember &&
            fnName === SHELL_TOOL &&
            risk === "normal" &&
            firstWord !== ""
          ) {
            onApproveShellPrefix?.(firstWord);
          }
        }
      }

      const toolStart = performance.now();
      let result: string;
      try {
        if (fnName === "spawn_subagent") {
          result = await runSubagent(args, opts);
        } else {
          result = await executeTool(fnName, args);
        }
      } catch (e) {
        result = formatToolError(e);
      }
      metrics.totalToolMs += performance.now() - toolStart;
      metrics.toolCalls++;
      onMetrics?.({ ...metrics });

      msgs.push({
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "tool",
        content: result,
        tool_call_id: tc.id,
        tool_name: fnName,
      });
      onUpdate([...msgs]);
    }

    onStatusChange("thinking");
  }

  const limitMsg: Message = {
    _tmpKey: makeTmpKey(),
    conversation_id: opts.conversationId,
    role: "assistant",
    content: "[Agent reached the maximum iteration limit without completing the task.]",
  };
  msgs.push(limitMsg);
  onUpdate([...msgs]);
  onStatusChange("done");
  return null;
}
