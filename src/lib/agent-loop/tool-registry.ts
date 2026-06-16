/* ── Declarative agent-tool registry ────────────────────────────────────────
 *
 * ONE descriptor per built-in agent tool — the single source of truth that
 * drives:
 *   • the wire-format `TOOLS` array (tools.ts derives from `schema`),
 *   • the security classifier Sets in dispatch.ts (DANGEROUS_TOOLS,
 *     WRITE_TOOLS, IRREVERSIBLE_TOOLS, READ_ONLY_TOOLS) and dry-run.ts
 *     (DRY_RUN_TOOLS, DRY_RUN_READ_ONLY),
 *   • the executeTool dispatch (handler.run holds the verbatim arm body),
 *
 * SECURITY: the membership of the classifier Sets IS the danger gate. A wrong
 * `dangerous`/`sideEffect`/`dryRun`/`cacheableRead` value is a security
 * regression. Each field below is set EXPLICITLY per the audited literals in
 * dispatch.ts / dry-run.ts; `cacheableRead` in particular is authored by hand
 * (it does NOT follow from `sideEffect` — e.g. list_processes/list_undo/
 * recall_memory/search_project_knowledge are reads but are deliberately
 * NON-cacheable). The registry-consistency test pins every Set against frozen
 * literals copied from the original files.
 *
 * MCP tools (mcp__server__tool) are dynamic and bypass this registry entirely —
 * they are routed in executeTool BEFORE the registry lookup and classified as
 * `destructive` by classifyToolRisk.
 */

import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";
import { serializeWorkflowGraph } from "../../types";
import {
  assertFlowSafe,
  assertFlowSafeAdvanced,
  buildAdvancedFlow,
  buildLinearFlow,
} from "../workflow/create-flow";
import { isMcpToolName } from "./mcp-tools";
import { recall, saveMemory } from "../memory-client";
import {
  DANGEROUS_TOOLS,
  agentRagSearch,
  clearActiveShell,
  executeTool,
  looksLikeShellFileWrite,
  recordAuditSafe,
  redactDiagDetailForRegistry,
  safeCalculate,
  setActiveShell,
} from "./dispatch";
import type { ExecuteToolOptions } from "./dispatch";

/** Per-tool function-call schema (OpenAI function format payload). */
export interface ToolSchema {
  description: string;
  parameters: unknown;
}

/** Side-effect class — informational; the security Sets are derived from the
 *  explicit flags below, not inferred from this. */
export type SideEffect = "read" | "write" | "irreversible";

/** Dry-run disposition: "preview" → DRY_RUN_TOOLS (rich preview);
 *  "run" → DRY_RUN_READ_ONLY (safe to actually run under dry-run);
 *  "suppress" → neither (default-deny: suppressed under dry-run). */
export type DryRunMode = "preview" | "run" | "suppress";

/** How executeTool invokes the tool. "api"/"client" both run via handler.run;
 *  "runner-special" tools (spawn_subagent/await_subagents/list_subagents) are
 *  handled in runner.ts and fall through executeTool's unknown_tool path. */
export type HandlerKind = "api" | "client" | "runner-special";

/** Payload field-source map for the Rust approval token binding (mirrors the
 *  `mintApproval(rustCommand, payload)` call site in tauri-api.ts). Keys are
 *  the ApprovalPayload field names; values are the arg key (or a literal) the
 *  payload field is sourced from. Documentation-only — the authoritative
 *  binding lives in commands/agent.rs::binding_for. */
export type ApprovalPayloadSources = Record<string, string>;

export interface ApprovalBinding {
  /** Rust command name whose `binding_for` arm enforces the bound token. */
  rustCommand: string;
  /** Which ApprovalPayload fields the binding consumes + where they come from. */
  payload: ApprovalPayloadSources;
}

export type ToolScope = "chat" | "workflow-only" | "subagent-special";

export interface ToolHandler {
  kind: HandlerKind;
  /** Verbatim executeTool arm body. Absent for runner-special tools. */
  run?: (
    args: Record<string, unknown>,
    options: ExecuteToolOptions,
  ) => Promise<string>;
}

/** Human-facing grouping bucket for the Skills & Tools hub. Purely
 *  presentational — it does NOT influence dispatch, security, or the preset
 *  allowlist. Distinct from `flow.presetCategory` (which curates the Flow
 *  picker); this is the hub's "what does this tool DO" grouping. */
export type ToolCategory =
  | "Filesystem"
  | "Git"
  | "Shell"
  | "Web"
  | "Code"
  | "macOS"
  | "Browser"
  | "Tasks"
  | "Watchers"
  | "Memory/RAG"
  | "Agent"
  | "Workflow"
  | "Skills";

export interface ToolDescriptor {
  name: string;
  schema: ToolSchema;
  /** Human-facing grouping bucket for the Skills & Tools hub (purely
   *  presentational; never affects dispatch, security, or the allowlist). */
  category: ToolCategory;
  sideEffect: SideEffect;
  /** Membership in DANGEROUS_TOOLS — the confirmation-modal gate. */
  dangerous: boolean;
  dryRun: DryRunMode;
  /** Membership in READ_ONLY_TOOLS — drives per-run caching + parallel
   *  prefetch. EXPLICIT, NOT inferred from sideEffect. */
  cacheableRead: boolean;
  /** Rust `agent_*` / `task_*` command this tool invokes (the IPC the api
   *  wrapper calls), or null for pure-TS / multi-command tools. */
  rustCommand: string | null;
  /** Payload-bound approval token binding, or null when none is minted. */
  approval: ApprovalBinding | null;
  handler: ToolHandler;
  /** Membership in WRITE_TOOLS — eligible for the session blanket-write
   *  approval. (delete/kill/undo are dangerous but NOT in WRITE_TOOLS —
   *  see IRREVERSIBLE_TOOLS.) */
  writeTool: boolean;
  /** Membership in IRREVERSIBLE_TOOLS — never eligible for blanket approval. */
  irreversible: boolean;
  /** Flow / picker curation flags (mirror create-flow.ts + tool-categories.ts;
   *  asserted, not regenerated). */
  flow: {
    /** Roles whose CURATED_TOOLS_FOR_ROLE include this tool. */
    flowSafeRoles?: string[];
    /** In ADVANCED_ALLOWED_TOOLS. */
    advancedAllowed?: boolean;
    /** In ADVANCED_FORBIDDEN_TOOLS. */
    advancedForbidden?: boolean;
    /** Appears in a TOOL_CATEGORIES bucket (picker-exposed). */
    pickerExposed?: boolean;
    /** TOOL_CATEGORIES bucket id this tool belongs to. */
    presetCategory?: string;
  };
  scope: ToolScope;
}

// ── Handler-body shared helper aliases ──────────────────────────────────────
// redactDiagDetail is module-private in dispatch.ts; the registry re-imports it
// under an exported alias so the (verbatim) handler bodies that log diagnostics
// keep the same redaction behaviour.
const redactDiagDetail = redactDiagDetailForRegistry;

/**
 * TOOL_REGISTRY — authored in the EXACT order of the original `TOOLS` literal
 * in tools.ts (read_file first … load_claude_skill last). `tools.ts` derives
 * the wire array from this order; the registry-consistency test pins it.
 */
export const TOOL_REGISTRY: ToolDescriptor[] = [
  {
    name: "read_file",
    category: "Filesystem",
    schema: {
      description:
        "Read text contents of a file. Default reads up to 65536 bytes — DO NOT pass a small limit (anything under 8192 is auto-raised). Only paginate when total_bytes exceeds 65536: pass the returned `next_offset` as the next call's `offset`. To read SEVERAL files at once, prefer read_files (one call). Returns content, bytes_read, total_bytes, truncated, next_offset.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path or ~/relative path.",
          },
          offset: {
            type: "number",
            description:
              "Byte offset to start reading (default 0). Only use when continuing a previously-truncated read.",
          },
          limit: {
            type: "number",
            description:
              "Max bytes to read (default 65536, minimum 8192). Omit unless you specifically need less than the whole file.",
          },
        },
        required: ["path"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_read_file",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "shell", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-read",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentReadFile(
          String(args.path ?? ""),
          typeof args.offset === "number" ? args.offset : undefined,
          typeof args.limit === "number" ? args.limit : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "read_files",
    category: "Filesystem",
    schema: {
      description:
        "Read MULTIPLE files in ONE call (read-only, no approval). Strongly preferred over many read_file calls when you need to inspect several files — saves turns. Returns {files: [{path, ok, content, total_bytes, truncated, next_offset} | {path, ok:false, error}]}. Max 32 files; each file capped at 65536 bytes (paginate large ones individually with read_file).",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Absolute or ~/relative file paths (max 32).",
          },
        },
        required: ["paths"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_read_files",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const paths = Array.isArray(args.paths)
          ? (args.paths as unknown[]).map((p) => String(p)).filter((p) => p)
          : [];
        if (paths.length === 0) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message: "read_files requires a non-empty paths array of strings.",
          });
        }
        const r = await api.agentReadFiles(paths);
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "list_dir",
    category: "Filesystem",
    schema: {
      description:
        "List directory entries (max 500). Returns {entries: [{name, kind, size}], truncated}.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path or ~/relative path.",
          },
        },
        required: ["path"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_list_dir",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "shell", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-read",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentListDir(String(args.path ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "search_files",
    category: "Filesystem",
    schema: {
      description:
        "Search for text across files under a directory (line-grep, recursive). Set regex=true for regex pattern matching. Pass context=N (1-5) to get N surrounding lines per hit (before/after) — avoids a follow-up read_file just to see around a match. Skips .git/node_modules/target/etc.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Root directory to search." },
          pattern: { type: "string", description: "Text or regex to find." },
          glob: {
            type: "string",
            description:
              "Optional filename glob, e.g. '*.ts' or '*.py'. Defaults to '*'.",
          },
          regex: {
            type: "boolean",
            description: "Treat pattern as a regex (Rust regex syntax).",
          },
          context: {
            type: "number",
            description:
              "Lines of surrounding context per hit (0-5, default 0). Each hit gains `before` and `after` arrays.",
          },
        },
        required: ["path", "pattern"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_search_files",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-read",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentSearchFiles(
          String(args.path ?? ""),
          String(args.pattern ?? ""),
          args.glob ? String(args.glob) : undefined,
          typeof args.regex === "boolean" ? args.regex : undefined,
          typeof args.context === "number" ? args.context : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "multi_edit",
    category: "Filesystem",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_multi_edit",
    approval: { rustCommand: "agent_multi_edit", payload: { path: "path" } },
    writeTool: true,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-write",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const edits = Array.isArray(args.edits)
          ? (args.edits as Array<{
              old_string: string;
              new_string: string;
              replace_all?: boolean;
            }>)
          : [];
        const r = await api.agentMultiEdit(String(args.path ?? ""), edits);
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "git_status",
    category: "Git",
    schema: {
      description:
        "Run `git status --short --branch` in the workspace (or given path). Returns stdout, stderr, exit_code.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional working directory; defaults to workspace root.",
          },
        },
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_git_status",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "git",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentGitStatus(
          args.path ? String(args.path) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "git_diff",
    category: "Git",
    schema: {
      description:
        "Run `git diff` in the workspace (or given path). Set staged=true for `--staged`.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          staged: { type: "boolean" },
        },
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_git_diff",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "git",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentGitDiff(
          args.path ? String(args.path) : undefined,
          typeof args.staged === "boolean" ? args.staged : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "file_exists",
    category: "Filesystem",
    schema: {
      description: "Check whether a path exists; returns {exists, kind, size}.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_file_exists",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "shell", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-read",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentFileExists(String(args.path ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "run_shell",
    category: "Shell",
    schema: {
      description:
        "Execute a shell command via sh -c. Optional cwd + per-call timeout. Default timeout 30s; pass timeout_secs (clamped 1-600) for slow builds, test suites, or downloads. ALWAYS requires user approval. Returns stdout, stderr, exit_code, duration_ms, timed_out. Do NOT use run_shell to write or create files — use write_file / write_files / edit_file. run_shell is for builds, tests, git, and other CLI tasks only.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command string passed to sh -c.",
          },
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_run_shell",
    approval: {
      rustCommand: "agent_run_shell",
      payload: { command: "command" },
    },
    writeTool: false,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "shell-system",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args, options) => {
        const cwd = args.cwd ? String(args.cwd) : undefined;
        // Per-call timeout — optional. The Rust side clamps to [1, 600] and
        // falls back to its default (30s) on undefined / NaN. We only forward a
        // value when it's a positive finite number so a model passing
        // `timeout_secs: "30"` (string) or `null` doesn't poison the opts.
        const rawTimeout = args.timeout_secs;
        const timeoutSecs =
          typeof rawTimeout === "number" &&
          Number.isFinite(rawTimeout) &&
          rawTimeout > 0
            ? Math.floor(rawTimeout)
            : undefined;
        const shellOpts =
          cwd || timeoutSecs !== undefined
            ? { cwd, timeout_secs: timeoutSecs }
            : undefined;
        const opId = `shell-${crypto.randomUUID()}`;
        const key = options.shellTrackKey ?? null;
        setActiveShell(key, opId);
        const command = String(args.command ?? "");
        try {
          const r = await api.agentRunShell(command, shellOpts, opId);
          // Steering nudge (no block): if the command looks like it's writing a
          // file via the shell (heredoc-to-redirect, `>`/`>>` to a file, or
          // `tee`), append a one-line hint so the model prefers write_file /
          // write_files next time — those have no length cap and stay confined
          // to the workspace. Cheap regex; tolerant of the false-positive traps
          // `2>&1` and `>/dev/null` (and friends).
          if (looksLikeShellFileWrite(command)) {
            return JSON.stringify({
              ...(r as unknown as Record<string, unknown>),
              steering:
                "Note: this looks like a file write via shell. Prefer write_file/write_files — no length limit, stays in the workspace.",
            });
          }
          return JSON.stringify(r);
        } finally {
          clearActiveShell(key, opId);
        }
      },
    },
  },
  {
    name: "run_code",
    category: "Shell",
    schema: {
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
            description:
              "Wall-clock budget in seconds. Defaults to 30. Clamped to [1, 600] server-side.",
            minimum: 1,
            maximum: 600,
          },
        },
        required: ["language", "code"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_run_code",
    approval: {
      rustCommand: "agent_run_code",
      payload: { language: "language", code: "code" },
    },
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "shell-system",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args, options) => {
        const language = String(args.language ?? "");
        const code = String(args.code ?? "");
        const rawTimeout = args.timeout_secs;
        const timeoutSecs =
          typeof rawTimeout === "number" &&
          Number.isFinite(rawTimeout) &&
          rawTimeout > 0
            ? Math.floor(rawTimeout)
            : undefined;
        const opId = `code-${crypto.randomUUID()}`;
        const key = options.shellTrackKey ?? null;
        setActiveShell(key, opId);
        try {
          const r = await api.agentRunCode(language, code, timeoutSecs, opId);
          return JSON.stringify(r);
        } finally {
          clearActiveShell(key, opId);
        }
      },
    },
  },
  {
    name: "calculate",
    category: "Code",
    schema: {
      description:
        "Evaluate an arithmetic expression exactly (no LLM guessing). Supports + - * / % ^, parentheses, unary minus, and functions sqrt/abs/sin/cos/tan/asin/acos/atan/ln/log/log2/exp/floor/ceil/round/sign plus constants pi/e/tau. Safe — never executes code. Use this for any non-trivial number crunching. Returns { ok, result } or { ok:false, error }.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              "e.g. '2 + 3 * 4', 'sqrt(16) + log(1000)', '(1+2)^10'.",
          },
        },
        required: ["expression"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "code-intel",
    },
    scope: "chat",
    handler: {
      kind: "client",
      run: async (args) =>
        JSON.stringify(safeCalculate(String(args.expression ?? ""))),
    },
  },
  {
    name: "remember",
    category: "Memory/RAG",
    schema: {
      description:
        "Save a durable fact to long-term memory so it can be recalled in future runs/conversations. Auto-embeds + de-duplicates. Scope: 'global' (default, everywhere), 'project' (this workspace only), or 'conversation' (this chat only). Use for stable preferences, decisions, or facts — NOT transient task state (use the workflow scratchpad for that).",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact to remember, as a self-contained sentence.",
          },
          scope: {
            type: "string",
            enum: ["global", "project", "conversation"],
            description: "Visibility scope. Default global.",
          },
          tags: {
            type: "string",
            description: "Optional comma-separated tags (no newlines).",
          },
        },
        required: ["content"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args, options) => {
        const content = String(args.content ?? "").trim();
        if (!content)
          return JSON.stringify({
            ok: false,
            kind: "empty",
            message: "content required",
          });
        const scope =
          args.scope === "project" || args.scope === "conversation"
            ? args.scope
            : "global";
        const r = await saveMemory({
          content,
          tags: typeof args.tags === "string" ? args.tags : undefined,
          scope,
          conversationId:
            scope === "conversation" ? (options.conversationId ?? null) : null,
          projectRoot:
            scope === "project" ? (options.workspaceRoot ?? null) : null,
        });
        return JSON.stringify({ ok: true, id: r.id, deduped: r.deduped, scope });
      },
    },
  },
  {
    name: "recall_memory",
    category: "Memory/RAG",
    schema: {
      description:
        "Search long-term memory for facts relevant to a query (vector search with keyword fallback). Returns up to k matching memories with their content, tags, scope, and similarity score. Call this before answering when prior context might help.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up." },
          k: {
            type: "integer",
            description: "Max results (1-20). Default 5.",
            minimum: 1,
            maximum: 20,
          },
        },
        required: ["query"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args, options) => {
        const query = String(args.query ?? "").trim();
        if (!query)
          return JSON.stringify({
            ok: false,
            kind: "empty",
            message: "query required",
          });
        const k =
          typeof args.k === "number" && args.k > 0
            ? Math.min(20, Math.floor(args.k))
            : 5;
        const hits = await recall(
          query,
          k,
          {
            cwd: options.workspaceRoot ?? undefined,
            convId: options.conversationId ?? undefined,
          },
          options.signal ?? undefined,
        );
        return JSON.stringify({
          ok: true,
          memories: hits.map((m) => ({
            id: m.id,
            content: m.content,
            tags: m.tags,
            scope: m.scope,
            score: m.score ?? null,
          })),
        });
      },
    },
  },
  {
    name: "write_file",
    category: "Filesystem",
    schema: {
      description:
        "PREFERRED tool for creating or overwriting a file. Pass the full content directly. Do NOT write files with run_shell (no `cat`/heredocs/`echo >`/`tee`/redirection, no generated scripts) — that hits the shell command-length limit, scatters files OUTSIDE the workspace (shell isn't confined), and forces a separate approval per file. Write text content to a file, creating parents. ALWAYS requires user approval. Prefer edit_file for changes to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_write_file",
    approval: { rustCommand: "agent_write_file", payload: { path: "path" } },
    writeTool: true,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-write",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        await api.agentWriteFile(
          String(args.path ?? ""),
          String(args.content ?? ""),
        );
        return JSON.stringify({ ok: true, path: args.path });
      },
    },
  },
  {
    name: "write_files",
    category: "Filesystem",
    schema: {
      description:
        "Create or overwrite MULTIPLE files in ONE call (one approval). Strongly preferred over many write_file calls when scaffolding several files — saves approvals and iterations.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["files"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_write_files",
    approval: {
      rustCommand: "agent_write_files",
      payload: { path: "joined-paths" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        // Coerce the model's `files` array into a clean {path, content}[] —
        // drop entries missing a path so a malformed item can't write to "".
        const rawFiles = Array.isArray(args.files) ? args.files : [];
        const files = rawFiles
          .map((f) => {
            if (!f || typeof f !== "object" || Array.isArray(f)) return null;
            const rec = f as Record<string, unknown>;
            const path = String(rec.path ?? "");
            if (!path) return null;
            return { path, content: String(rec.content ?? "") };
          })
          .filter((f): f is { path: string; content: string } => f !== null);
        if (files.length === 0) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message:
              "write_files requires a non-empty files array of {path, content}.",
          });
        }
        await api.agentWriteFiles(files);
        return JSON.stringify({ ok: true, paths: files.map((f) => f.path) });
      },
    },
  },
  {
    name: "apply_patch",
    category: "Filesystem",
    schema: {
      description:
        "Apply a unified diff across ONE OR MORE files in a single approval — the best tool for a coordinated change (e.g. a rename touching several call sites). Atomic: if any hunk fails to match, NOTHING is written. Use standard unified-diff format with `--- a/path`, `+++ b/path`, `@@` hunks; create a new file with `--- /dev/null`. Context + removed lines must match the file EXACTLY (no fuzz). Does not delete files (use delete_path). Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description:
              "The full unified diff. May contain multiple file sections.",
          },
        },
        required: ["patch"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_apply_patch",
    approval: { rustCommand: "agent_apply_patch", payload: { text: "patch" } },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const patch = String(args.patch ?? "");
        if (!patch.trim()) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message:
              "apply_patch requires a non-empty unified-diff `patch` string.",
          });
        }
        const r = await api.agentApplyPatch(patch);
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "update_plan",
    category: "Code",
    schema: {
      description:
        "Maintain a short, pinned task checklist for a multi-step job. Call it once early with your plan, then again to flip a step's status as you progress — instead of re-typing the whole plan in prose each turn. Keeps you on track and saves tokens. Statuses: pending | in_progress | done. Keep it to the few real milestones (max 30 steps), not every tool call.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step: { type: "string", description: "Short step description." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "done"],
                },
              },
              required: ["step", "status"],
            },
          },
        },
        required: ["plan"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "client",
      run: async (args) => {
        // Pure book-keeping tool (exp #1): the model maintains a compact,
        // pinned checklist instead of re-narrating its whole plan every turn.
        // No side effects — normalize + echo so the result the model sees (and
        // the chat UI renders) is the canonical plan. Stateless by design: the
        // plan lives in the tool-result message, not in runner state.
        const VALID = new Set(["pending", "in_progress", "done"]);
        const rawSteps = Array.isArray(args.plan) ? args.plan : [];
        const plan = rawSteps
          .map((s) => {
            if (!s || typeof s !== "object" || Array.isArray(s)) return null;
            const rec = s as Record<string, unknown>;
            const step = String(rec.step ?? "").trim();
            if (!step) return null;
            const status = VALID.has(String(rec.status))
              ? String(rec.status)
              : "pending";
            return { step, status };
          })
          .filter((s): s is { step: string; status: string } => s !== null)
          .slice(0, 30);
        if (plan.length === 0) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message:
              "update_plan requires a non-empty `plan` array of {step, status}.",
          });
        }
        return JSON.stringify({ ok: true, plan });
      },
    },
  },
  {
    name: "edit_file",
    category: "Filesystem",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_edit_file",
    approval: { rustCommand: "agent_edit_file", payload: { path: "path" } },
    writeTool: true,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-write",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentEditFile(
          String(args.path ?? ""),
          String(args.old_string ?? ""),
          String(args.new_string ?? ""),
          typeof args.replace_all === "boolean" ? args.replace_all : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "git_log",
    category: "Git",
    schema: {
      description:
        "Run `git log --oneline --decorate -n <limit>` (default 20, max 200).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_git_log",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "git",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentGitLog(
          args.path ? String(args.path) : undefined,
          typeof args.limit === "number" ? args.limit : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "git_show",
    category: "Git",
    schema: {
      description:
        "Run `git show <ref>` — view commit details + diff. Ref must be alphanumeric + ./_/-/slash.",
      parameters: {
        type: "object",
        properties: {
          reference: { type: "string" },
          path: { type: "string" },
        },
        required: ["reference"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_git_show",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "git",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentGitShow(
          String(args.reference ?? ""),
          args.path ? String(args.path) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "git_branches",
    category: "Git",
    schema: {
      description: "Run `git branch -a` — list local + remote branches.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_git_branches",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "git",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentGitBranches(
          args.path ? String(args.path) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "git_commit",
    category: "Git",
    schema: {
      description:
        "Commit already-staged changes with a message. Requires user approval. Does NOT stage files — use run_shell `git add` first.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" }, path: { type: "string" } },
        required: ["message"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_git_commit",
    approval: {
      rustCommand: "agent_git_commit",
      payload: { message: "message", path: "path" },
    },
    writeTool: true,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "git",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentGitCommit(
          String(args.message ?? ""),
          args.path ? String(args.path) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "web_fetch",
    category: "Web",
    schema: {
      description:
        "GET a URL and return its text content (HTML auto-stripped). Blocks loopback/private/link-local hosts (SSRF defense). 15s timeout, 1 MiB response cap.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_web_fetch",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "web",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentWebFetch(String(args.url ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "web_search",
    category: "Web",
    schema: {
      description:
        "Search the web via DuckDuckGo. Returns up to 20 hits with title/url/snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          n: { type: "number" },
        },
        required: ["query"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_web_search",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "web",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentWebSearch(
          String(args.query ?? ""),
          typeof args.n === "number" ? args.n : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "read_pdf",
    category: "Filesystem",
    schema: {
      description:
        "Extract text from a PDF file at the given path. Optional byte-cap on output.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_read_pdf",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["coder", "critic", "editor", "summarizer"],
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "fs-read",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentReadPdf(
          String(args.path ?? ""),
          typeof args.limit === "number" ? args.limit : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "screenshot",
    category: "macOS",
    schema: {
      description:
        "Capture the screen via macOS `screencapture -x`. Saves to /tmp if no out_path. Returns the file path.",
      parameters: {
        type: "object",
        properties: { out_path: { type: "string" } },
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_screenshot",
    approval: { rustCommand: "agent_screenshot", payload: { path: "out_path" } },
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "media",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentScreenshot(
          args.out_path ? String(args.out_path) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "clipboard_get",
    category: "macOS",
    schema: {
      description:
        "Read the user's macOS clipboard. Returns text only; large content truncated.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_clipboard_get",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      advancedForbidden: true,
      pickerExposed: true,
      presetCategory: "media",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        const text = await api.agentClipboardGet();
        return JSON.stringify({ ok: true, text });
      },
    },
  },
  {
    name: "clipboard_set",
    category: "macOS",
    schema: {
      description:
        "Write text to the user's macOS clipboard. Requires approval — clipboard may hold sensitive data.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_clipboard_set",
    approval: {
      rustCommand: "agent_clipboard_set",
      payload: { text: "text" },
    },
    writeTool: true,
    irreversible: false,
    flow: {
      advancedForbidden: true,
      pickerExposed: true,
      presetCategory: "media",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        await api.agentClipboardSet(String(args.text ?? ""));
        return JSON.stringify({ ok: true });
      },
    },
  },
  {
    name: "open_app",
    category: "macOS",
    schema: {
      description:
        'Launch a macOS app by name via `open -a` (e.g. "Safari", "Visual Studio Code"). Requires approval.',
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_open_app",
    approval: { rustCommand: "agent_open_app", payload: { bundle_id: "name" } },
    writeTool: false,
    irreversible: false,
    flow: {
      advancedForbidden: true,
      pickerExposed: true,
      presetCategory: "shell-system",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        await api.agentOpenApp(String(args.name ?? ""));
        return JSON.stringify({ ok: true, app: args.name });
      },
    },
  },
  {
    name: "show_notification",
    category: "macOS",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_show_notification",
    approval: {
      rustCommand: "agent_show_notification",
      payload: { title: "title", body: "body" },
    },
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "shell-system",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        await api.agentShowNotification(
          String(args.title ?? ""),
          String(args.body ?? ""),
        );
        return JSON.stringify({ ok: true });
      },
    },
  },
  {
    name: "applescript_run",
    category: "macOS",
    schema: {
      description:
        "Execute an AppleScript via osascript. Powerful — can drive any scriptable app. ALWAYS requires user approval. 30s timeout.",
      parameters: {
        type: "object",
        properties: { script: { type: "string" } },
        required: ["script"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_applescript_run",
    approval: {
      rustCommand: "agent_applescript_run",
      payload: { script: "script" },
    },
    writeTool: true,
    irreversible: false,
    flow: {
      advancedForbidden: true,
      pickerExposed: true,
      presetCategory: "shell-system",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentApplescriptRun(String(args.script ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "http_request",
    category: "Web",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_http_request",
    approval: { rustCommand: "agent_http_request", payload: { url: "url" } },
    writeTool: true,
    irreversible: false,
    flow: {
      advancedAllowed: true,
      pickerExposed: true,
      presetCategory: "web",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const method = String(args.method ?? "GET").toUpperCase() as
          | "GET"
          | "POST"
          | "PUT"
          | "PATCH"
          | "DELETE"
          | "HEAD";
        const headers =
          args.headers && typeof args.headers === "object"
            ? (args.headers as Record<string, string>)
            : undefined;
        const r = await api.agentHttpRequest({
          method,
          url: String(args.url ?? ""),
          headers,
          body: args.body != null ? String(args.body) : undefined,
          timeout_secs:
            typeof args.timeout_secs === "number"
              ? args.timeout_secs
              : undefined,
        });
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "call_api",
    category: "Web",
    schema: {
      description:
        "Call one of the user's REGISTERED APIs by name. The auth key is injected automatically server-side — never include it. `path` is relative to the API's base URL (e.g. \"/repos/owner/name\"). Registered API names are listed in the system prompt; pass one as `api`. SSRF-protected, approval-gated. Prefer this over http_request whenever the user has a saved API for the service.",
      parameters: {
        type: "object",
        properties: {
          api: { type: "string", description: "Registered API name." },
          method: {
            type: "string",
            description: "GET/POST/PUT/PATCH/DELETE/HEAD.",
          },
          path: {
            type: "string",
            description: "Path relative to the API base URL.",
          },
          query: { type: "object", description: "Optional query params." },
          headers: {
            type: "object",
            description: "Optional extra headers (NOT auth).",
          },
          body: { type: "string" },
          timeout_secs: { type: "number" },
        },
        required: ["api", "method", "path"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_call_api",
    approval: {
      rustCommand: "agent_call_api",
      payload: { url: "api|method|path" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const headers =
          args.headers && typeof args.headers === "object"
            ? (args.headers as Record<string, string>)
            : undefined;
        const query =
          args.query && typeof args.query === "object"
            ? (args.query as Record<string, string>)
            : undefined;
        const r = await api.agentCallApi({
          api: String(args.api ?? ""),
          method: String(args.method ?? "GET").toUpperCase(),
          path: String(args.path ?? ""),
          query,
          headers,
          body: args.body != null ? String(args.body) : undefined,
          timeout_secs:
            typeof args.timeout_secs === "number"
              ? args.timeout_secs
              : undefined,
        });
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "find_definition",
    category: "Code",
    schema: {
      description:
        "Locate the definition of a symbol (function/class/struct/etc.) via heuristic regex across the workspace. Symbol must be [A-Za-z0-9_]+.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          path: { type: "string" },
        },
        required: ["symbol"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_find_definition",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      advancedAllowed: false,
      pickerExposed: true,
      presetCategory: "code-intel",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentFindDefinition(
          String(args.symbol ?? ""),
          args.path ? String(args.path) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "find_references",
    category: "Code",
    schema: {
      description:
        "Locate all references to a symbol via word-boundary regex across the workspace.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          path: { type: "string" },
        },
        required: ["symbol"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_find_references",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      advancedAllowed: false,
      pickerExposed: true,
      presetCategory: "code-intel",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentFindReferences(
          String(args.symbol ?? ""),
          args.path ? String(args.path) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "format_code",
    category: "Code",
    schema: {
      description:
        "Format a code file via the right formatter for its extension (prettier for ts/js/json/css/md/yaml, rustfmt for .rs, black for .py, gofmt for .go, swift-format for .swift).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_format_code",
    approval: { rustCommand: "agent_format_code", payload: { path: "path" } },
    writeTool: true,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "code-intel",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentFormatCode(String(args.path ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "task_create",
    category: "Tasks",
    schema: {
      description:
        "Start a long-running shell command in the background. Returns a task_id immediately. Use task_status to check progress and read output, task_list to see all tasks, and task_cancel to stop one.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "task_create",
    approval: { rustCommand: "task_create", payload: { command: "command" } },
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "background-tasks",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.taskCreate(
          String(args.command ?? ""),
          args.cwd ? String(args.cwd) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "task_status",
    category: "Tasks",
    schema: {
      description:
        "Get the current status + result (if finished) of a background task.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "task_status",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "background-tasks",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.taskStatus(String(args.id ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "task_list",
    category: "Tasks",
    schema: {
      description:
        "List all background tasks the agent has started this session.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "task_list",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "background-tasks",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        const r = await api.taskList();
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "task_cancel",
    category: "Tasks",
    schema: {
      description:
        "Cancel a running background task. Idempotent on terminal-state tasks.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "task_cancel",
    approval: { rustCommand: "task_cancel", payload: { text: "id" } },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        await api.taskCancel(String(args.id ?? ""));
        return JSON.stringify({ ok: true });
      },
    },
  },
  {
    name: "ask_user",
    category: "Agent",
    schema: {
      description:
        "Pause the agent and prompt the user for an answer. Use when you genuinely need info you can't get from tools (preference, missing parameter, ambiguity). Returns the user's typed text.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          hint: {
            type: "string",
            description: "Optional helper text shown under the question.",
          },
        },
        required: ["question"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_ask_user",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "interactive",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const answer = await api.agentAskUser(
          String(args.question ?? ""),
          args.hint ? String(args.hint) : undefined,
        );
        return JSON.stringify({ ok: true, answer });
      },
    },
  },
  {
    name: "watch_path",
    category: "Watchers",
    schema: {
      description:
        "Start watching a file or directory for changes. Returns {watch_id: 'w_xxx', path, glob}. Use poll_watch repeatedly to drain events. Pair this with run_shell/task_create for build-watch or test-watch loops. Cross-platform (FSEvents/inotify/ReadDirectoryChangesW).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute or ~/relative path. Directories are watched recursively.",
          },
          glob: {
            type: "string",
            description:
              "Optional glob to filter events by path, e.g. '**/*.ts' or '**/*.rs'.",
          },
          debounce_ms: {
            type: "number",
            description:
              "Optional debounce window in ms — collapses same-path same-kind bursts. Useful for editor-save patterns.",
          },
        },
        required: ["path"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_watch_path",
    approval: { rustCommand: "agent_watch_path", payload: { path: "path" } },
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "watchers",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentWatchPath(
          String(args.path ?? ""),
          args.glob ? String(args.glob) : undefined,
          typeof args.debounce_ms === "number" ? args.debounce_ms : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "poll_watch",
    category: "Watchers",
    schema: {
      description:
        "Drain filesystem events accumulated by a watcher since `since_ms` (or all if unset). Returns {events: [{kind, path, ts}], next_ts, dropped}. Pass next_ts back as since_ms on the next call. `dropped` reports events elided by the per-call max (ring-buffer overflow is in list_watches).",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "watch_id returned by watch_path.",
          },
          since_ms: {
            type: "number",
            description:
              "Unix-ms cursor — drain only events with ts > since_ms.",
          },
          max_events: {
            type: "number",
            description:
              "Cap on events returned (default 100). Overflow stays buffered for the next poll.",
          },
        },
        required: ["id"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_poll_watch",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "watchers",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentPollWatch(
          String(args.id ?? ""),
          typeof args.since_ms === "number" ? args.since_ms : undefined,
          typeof args.max_events === "number" ? args.max_events : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "stop_watch",
    category: "Watchers",
    schema: {
      description:
        "Stop a filesystem watcher and release its OS-level watch handle.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "watch_id to stop." },
        },
        required: ["id"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_stop_watch",
    approval: { rustCommand: "agent_stop_watch", payload: { text: "id" } },
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "watchers",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        await api.agentStopWatch(String(args.id ?? ""));
        return JSON.stringify({ ok: true });
      },
    },
  },
  {
    name: "list_watches",
    category: "Watchers",
    schema: {
      description:
        "List active filesystem watchers — id, path, glob, started_at, events_seen, buffered, dropped.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_list_watches",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "watchers",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        const r = await api.agentListWatches();
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "browser_navigate",
    category: "Browser",
    schema: {
      description:
        "Open a URL in a controlled Chrome/Chromium instance and return the page title + URL + a base64 PNG screenshot. SSRF-protected (no loopback/private/link-local hosts; no file://, chrome://). One persistent browser session per app run — subsequent browser_* calls reuse the same tab. Requires a Chrome/Chromium binary installed on the user's machine. The browser_ prefix means actions are visible to the user — there are no silent navigations.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "http(s) URL to open. data: URLs are also allowed for offline payloads.",
          },
        },
        required: ["url"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_browser_navigate",
    approval: {
      rustCommand: "agent_browser_navigate",
      payload: { url: "url" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentBrowserNavigate(String(args.url ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "browser_click",
    category: "Browser",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_browser_click",
    approval: {
      rustCommand: "agent_browser_click",
      payload: { text: "selector" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentBrowserClick(String(args.selector ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "browser_fill",
    category: "Browser",
    schema: {
      description:
        "Focus an input via CSS selector and type a value into it. Fails if no browser session is open or the selector matches nothing.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of the input/textarea.",
          },
          value: { type: "string", description: "Text to type." },
        },
        required: ["selector", "value"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "preview",
    cacheableRead: false,
    rustCommand: "agent_browser_fill",
    approval: {
      rustCommand: "agent_browser_fill",
      payload: { text: "selector", body: "value" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentBrowserFill(
          String(args.selector ?? ""),
          String(args.value ?? ""),
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "browser_screenshot",
    category: "Browser",
    schema: {
      description:
        "Capture a PNG screenshot of the current browser tab. Returns {base64}. Fails if no browser session is open.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_browser_screenshot",
    approval: {
      rustCommand: "agent_browser_screenshot",
      payload: { op: "screenshot" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        const r = await api.agentBrowserScreenshot();
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "browser_get_text",
    category: "Browser",
    schema: {
      description:
        "Return innerText for the matched element (defaults to body). Output capped at 64 KiB. Fails if no browser session is open.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector; defaults to 'body'.",
          },
        },
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_browser_get_text",
    approval: {
      rustCommand: "agent_browser_get_text",
      payload: { text: "selector" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentBrowserGetText(
          args.selector ? String(args.selector) : undefined,
        );
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "browser_close",
    category: "Browser",
    schema: {
      description:
        "Close the persistent browser session. Idempotent — safe to call when no session exists.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_browser_close",
    approval: {
      rustCommand: "agent_browser_close",
      payload: { op: "close" },
    },
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        const r = await api.agentBrowserClose();
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "search_project_knowledge",
    category: "Memory/RAG",
    schema: {
      description:
        "Semantic search over an indexed local folder (RAG). Returns top-K matching chunks with file paths and snippets. Index folders first via the RAG panel in agent settings; this tool only reads.",
      parameters: {
        type: "object",
        properties: {
          corpus_name: {
            type: "string",
            description: "Name of the indexed corpus to search.",
          },
          query: {
            type: "string",
            description: "Natural-language or keyword query.",
          },
          top_k: {
            type: "number",
            description: "Max number of hits to return (default 5, max 50).",
          },
        },
        required: ["corpus_name", "query"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "rag_search",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "code-intel",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const hits = await agentRagSearch(
          String(args.corpus_name ?? ""),
          String(args.query ?? ""),
          typeof args.top_k === "number" ? args.top_k : undefined,
        );
        return JSON.stringify({ ok: true, hits });
      },
    },
  },
  {
    name: "spawn_subagent",
    category: "Agent",
    schema: {
      description:
        "Run a fresh agent in an isolated context to handle a sub-task. Default mode 'sync' awaits the sub-agent and returns its final text. Pass mode='async' for parallel fan-out — returns {subagent_id, status:'running'} immediately; join with await_subagents. Max recursion depth 3.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          preset: {
            type: "string",
            description: "Optional: general / coder / researcher / shell.",
          },
          mode: {
            type: "string",
            enum: ["sync", "async"],
            description:
              "'sync' (default) blocks until the subagent finishes. 'async' returns immediately with a subagent_id; use await_subagents to join.",
          },
        },
        required: ["prompt"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "subagent-special",
    handler: { kind: "runner-special" },
  },
  {
    name: "await_subagents",
    category: "Agent",
    schema: {
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
    sideEffect: "read",
    dangerous: false,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "subagent-special",
    handler: { kind: "runner-special" },
  },
  {
    name: "list_subagents",
    category: "Agent",
    schema: {
      description:
        "List currently-tracked subagents (running, plus recently-completed within ~60s). Returns [{id, status, started_at, prompt_preview, depth}].",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "subagent-special",
    handler: { kind: "runner-special" },
  },
  {
    name: "move_path",
    category: "Filesystem",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_move_path",
    approval: {
      rustCommand: "agent_move_path",
      payload: { from: "from", to: "to" },
    },
    writeTool: true,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "fs-write",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentMovePath(
          String(args.from ?? ""),
          String(args.to ?? ""),
          typeof args.overwrite === "boolean" ? args.overwrite : undefined,
        );
        return JSON.stringify({ ok: true, ...r });
      },
    },
  },
  {
    name: "copy_path",
    category: "Filesystem",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_copy_path",
    approval: {
      rustCommand: "agent_copy_path",
      payload: { from: "from", to: "to" },
    },
    writeTool: true,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "fs-write",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentCopyPath(
          String(args.from ?? ""),
          String(args.to ?? ""),
          typeof args.overwrite === "boolean" ? args.overwrite : undefined,
        );
        return JSON.stringify({ ok: true, ...r });
      },
    },
  },
  {
    name: "delete_path",
    category: "Filesystem",
    schema: {
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
    sideEffect: "irreversible",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_delete_path",
    approval: { rustCommand: "agent_delete_path", payload: { path: "path" } },
    writeTool: false,
    irreversible: true,
    flow: {
      advancedForbidden: true,
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentDeletePath(
          String(args.path ?? ""),
          typeof args.recursive === "boolean" ? args.recursive : undefined,
        );
        return JSON.stringify({ ok: true, ...r });
      },
    },
  },
  {
    name: "make_dir",
    category: "Filesystem",
    schema: {
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
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_make_dir",
    approval: { rustCommand: "agent_make_dir", payload: { path: "path" } },
    writeTool: true,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "fs-write",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentMakeDir(String(args.path ?? ""));
        return JSON.stringify({ ok: true, ...r });
      },
    },
  },
  {
    name: "hash_file",
    category: "Filesystem",
    schema: {
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
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_hash_file",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "fs-read",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const algo = args.algorithm === "sha512" ? "sha512" : "sha256";
        const r = await api.agentHashFile(String(args.path ?? ""), algo);
        return JSON.stringify({ ok: true, ...r });
      },
    },
  },
  {
    name: "diff_files",
    category: "Filesystem",
    schema: {
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
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "agent_diff_files",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "fs-read",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentDiffFiles(
          String(args.left ?? ""),
          String(args.right ?? ""),
        );
        return JSON.stringify({ ok: true, ...r });
      },
    },
  },
  {
    name: "list_processes",
    category: "Shell",
    schema: {
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
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_list_processes",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "shell-system",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const r = await api.agentListProcesses(
          typeof args.filter === "string" ? args.filter : undefined,
        );
        return JSON.stringify({ ok: true, rows: r });
      },
    },
  },
  {
    name: "kill_process",
    category: "Shell",
    schema: {
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
    sideEffect: "irreversible",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_kill_process",
    approval: {
      rustCommand: "agent_kill_process",
      payload: { pid: "pid", signal: "signal" },
    },
    writeTool: false,
    irreversible: true,
    flow: {
      advancedForbidden: true,
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const pid = typeof args.pid === "number" ? Math.floor(args.pid) : -1;
        if (pid < 2) {
          return JSON.stringify({
            ok: false,
            kind: "invalid_argument",
            message: "pid must be >= 2",
          });
        }
        const r = await api.agentKillProcess(
          pid,
          typeof args.signal === "string" ? args.signal : undefined,
        );
        return JSON.stringify({ ok: true, ...r });
      },
    },
  },
  {
    name: "agent_undo",
    category: "Agent",
    schema: {
      description:
        "Revert the most recent write_file / edit_file / multi_edit by restoring the file's prior contents (or deleting it if the snapshot recorded the file as new). Up to 50 edits are tracked in memory; the stack drops on app restart. ALWAYS requires user approval.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "irreversible",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "agent_undo_last",
    approval: { rustCommand: "agent_undo_last", payload: { op: "undo_last" } },
    writeTool: false,
    irreversible: true,
    flow: {
      advancedForbidden: true,
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        try {
          const r = await api.agentUndoLast();
          return JSON.stringify({ ok: true, ...r });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return JSON.stringify({ ok: false, kind: "undo_failed", message });
        }
      },
    },
  },
  {
    name: "list_undo",
    category: "Agent",
    schema: {
      description:
        "List the in-memory undo stack newest-first so you can see what agent_undo would revert. Returns rows of {path, kind, taken_at_ms, size_bytes, was_absent}. Read-only.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "agent_list_undo",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        const r = await api.agentListUndo();
        return JSON.stringify({ ok: true, rows: r });
      },
    },
  },
  {
    name: "create_flow",
    category: "Workflow",
    schema: {
      description:
        "Create a saved Flow — a linear multi-agent workflow — from a description. " +
        "The Flow is SAVED to the Flows view but NEVER run automatically; the user reviews and runs it. " +
        "Steps execute strictly top-to-bottom, each step's output handed to the next. " +
        "Use this when the user asks you to build/set up/save a workflow or pipeline.\n" +
        "Two modes:\n" +
        "• mode='safe' (default): every step is an attended agent restricted to read-only, " +
        "non-network tools, so the saved Flow cannot exfiltrate or modify the system on its own. " +
        "Pick a `role` per step; the app assigns a curated, exfil-safe tool set.\n" +
        "• mode='advanced': you may additionally set per-step nodeType (critic/cascade/moa/consistency loops), " +
        "a verifyCmd (critic/cascade only), and a wider tools[] (web/edit/shell). Advanced Flows are SAVED DISABLED " +
        "pending review — every elevated card is flagged for human review, and neither the runner nor the scheduler " +
        "will run it until the USER opens the Flow editor and ARMS each elevated card. Use advanced only when the " +
        "user explicitly wants a powerful Flow and accepts arming it before it can run.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short Flow name shown in the Flows list (max 80 chars).",
          },
          mode: {
            type: "string",
            enum: ["safe", "advanced"],
            description:
              "'safe' (default) = read-only, non-network, attended agents only. 'advanced' = allow per-step nodeType/verifyCmd/tools, but the Flow is saved DISABLED and the user must arm each elevated card in the editor before it can run.",
          },
          steps: {
            type: "array",
            description:
              "Ordered steps; each becomes one card chained linearly. 1–12 steps.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Short step label (max 60 chars).",
                },
                role: {
                  type: "string",
                  enum: [
                    "coder",
                    "critic",
                    "editor",
                    "summarizer",
                    "shell",
                    "researcher",
                    "general",
                  ],
                  description:
                    "Built-in role for this step. In safe mode only coder/critic/editor/summarizer/shell are allowed and the app assigns a curated read-only, non-network tool set. researcher/general are advanced-only (they unlock web/edit tools) and require the card to be armed before it runs.",
                },
                instructions: {
                  type: "string",
                  description:
                    "What this step should do — becomes the card's prompt (max 4000 chars).",
                },
                nodeType: {
                  type: "string",
                  enum: ["agent", "moa", "consistency", "critic", "cascade"],
                  description:
                    "ADVANCED ONLY. Orchestration kind: agent (one pass, default), moa (N proposers → synthesis), consistency (N samples → vote), critic (generate→critique→revise loop), cascade (cheap then escalate). router/blackboard/budget are NOT available here. Ignored in safe mode.",
                },
                verifyCmd: {
                  type: "string",
                  description:
                    "ADVANCED + critic/cascade ONLY. A shell command run before each critique pass so the score is grounded in real execution (e.g. 'npm test'). Ignored otherwise.",
                },
                tools: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "ADVANCED ONLY. Explicit tool allowlist for this card, intersected with the safe-but-wider advanced set (read-only local + scratchpad + web_fetch/web_search/http_request + edit_file/multi_edit/write_file/run_shell/git_commit + calculate). Forbidden tools (delete_path/kill_process/agent_undo/clipboard/applescript/open_app) are always stripped. Omit to inherit the role's default set. Ignored in safe mode.",
                },
              },
              required: ["title", "role", "instructions"],
            },
          },
        },
        required: ["name", "steps"],
      },
    },
    sideEffect: "write",
    dangerous: true,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "workflow_save",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {},
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        // Build a validated, inert Flow from the model's {name, steps}. Either way
        // the builder hardcodes every security field (unattended:false, no
        // schedule) from a fresh literal — the model controls only titles/roles/
        // instructions (+ nodeType/verifyCmd/tools in advanced). create_flow
        // SAVES — it never runs the Flow.
        //
        // mode='advanced' lets the model author powerful cards (non-agent
        // nodeTypes, verifyCmd, wider tools) but EVERY elevated card lands
        // needsReview:true; the runner + scheduler refuse it until the user arms
        // it in the editor. Safe mode keeps the read-only/non-network gate.
        const advanced = args.mode === "advanced";
        const build = advanced
          ? buildAdvancedFlow(args.name, args.steps)
          : buildLinearFlow(args.name, args.steps);
        if (!build.ok) {
          return JSON.stringify({
            ok: false,
            kind: build.kind,
            message: build.message,
          });
        }
        // Independent defense-in-depth re-check, mode-matched: safe mode requires
        // plain read-only agents; advanced mode allows elevated cards ONLY when
        // they carry the needsReview gate.
        const violation = advanced
          ? assertFlowSafeAdvanced(build.graph)
          : assertFlowSafe(build.graph);
        if (violation) {
          return JSON.stringify({
            ok: false,
            kind: "invariant_violation",
            message: violation,
          });
        }
        const json = serializeWorkflowGraph(build.graph);
        if (new TextEncoder().encode(json).length >= 1_048_576) {
          return JSON.stringify({
            ok: false,
            kind: "too_large",
            message: "Flow exceeds the 1 MiB limit.",
          });
        }
        const flow_id = await api.workflowSave(null, build.name, json);
        return JSON.stringify({
          ok: true,
          flow_id,
          name: build.name,
          steps: build.graph.cards.length,
          needs_review: advanced,
          note: advanced
            ? "Saved to the Flows view DISABLED. Each elevated card is flagged for review — open Flows and Arm each card before it can run."
            : "Saved to the Flows view (not run). Open Flows to review, edit, and run it.",
        });
      },
    },
  },
  {
    name: "workflow_set",
    category: "Workflow",
    schema: {
      description:
        "Write a value to the workflow scratchpad — a shared blob other cards in the same run can read. Use for structured state (counts, decisions, intermediate JSON) that doesn't belong in the user-facing prose handoff. Total scratchpad capped at 64 KiB across all keys. Value must be JSON-serializable.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Identifier within this run's scratchpad. Use snake_case names like 'research_summary' or 'urls_to_visit'.",
          },
          value: {
            description:
              "Anything JSON-serializable (string, number, boolean, null, object, array).",
          },
        },
        required: ["key", "value"],
      },
    },
    sideEffect: "write",
    dangerous: false,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["critic", "editor", "summarizer"],
      advancedAllowed: true,
    },
    scope: "workflow-only",
    handler: {
      kind: "client",
      run: async (args) => {
        const { setEntry } = await import("../workflow/scratchpad");
        const r = setEntry(String(args.key ?? ""), args.value as never);
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "workflow_get",
    category: "Workflow",
    schema: {
      description:
        "Read a value the current workflow run previously stored via workflow_set. Returns {ok:true, value} on hit, {ok:false, kind:'missing_key'} when no such key exists in this run.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["critic", "editor", "summarizer"],
      advancedAllowed: true,
    },
    scope: "workflow-only",
    handler: {
      kind: "client",
      run: async (args) => {
        const { getEntry } = await import("../workflow/scratchpad");
        const r = getEntry(String(args.key ?? ""));
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "workflow_keys",
    category: "Workflow",
    schema: {
      description:
        "List the keys currently in the workflow scratchpad for THIS run. Use to discover what an upstream card wrote without trial-and-error workflow_get calls.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["critic", "editor", "summarizer"],
      advancedAllowed: true,
    },
    scope: "workflow-only",
    handler: {
      kind: "client",
      run: async () => {
        const { listKeys } = await import("../workflow/scratchpad");
        const r = listKeys();
        return JSON.stringify(r);
      },
    },
  },
  {
    name: "workflow_get_prior_run",
    category: "Workflow",
    schema: {
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
            description:
              "Optional specific workflow_runs.id. If omitted, returns the most recent successful run that contains this card.",
          },
        },
        required: ["card_id"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      flowSafeRoles: ["critic", "editor", "summarizer"],
      advancedAllowed: true,
    },
    scope: "workflow-only",
    handler: {
      kind: "client",
      run: async (args) => {
        // Defers to the Tauri-side workflow_runs query. Returns the most
        // recent run unless an explicit run_id is provided. Searches the
        // run's recorded card list for the requested card_id and returns
        // its output blob.
        try {
          const cardId = String(args.card_id ?? "");
          if (!cardId) {
            return JSON.stringify({
              ok: false,
              kind: "bad_args",
              message: "card_id required",
            });
          }
          // Walk back through workflow_runs to find one containing this card.
          // The workflow_id must be the *current* run's workflow_id — we
          // read it from the active scratchpad so a card can't accidentally
          // peek into a different workflow's history.
          const { snapshot } = await import("../workflow/scratchpad");
          const snap = snapshot();
          if (!snap) {
            return JSON.stringify({ ok: false, kind: "not_in_workflow" });
          }
          const runs = await api.workflowRunsList(snap.workflowId);
          const explicit = args.run_id != null ? Number(args.run_id) : null;
          const candidates =
            explicit != null
              ? runs.filter((r) => r.id === explicit)
              : runs.filter((r) => r.status === "ok");
          for (const r of candidates) {
            try {
              const parsed = JSON.parse(r.results_json) as {
                cards?: Array<{
                  cardId: string;
                  output?: string;
                  status?: string;
                }>;
              };
              const hit = parsed.cards?.find(
                (c) => c.cardId === cardId && c.status === "ok",
              );
              if (hit) {
                return JSON.stringify({
                  ok: true,
                  run_id: r.id,
                  created_at: r.created_at,
                  output: hit.output ?? "",
                });
              }
            } catch {
              /* skip malformed row */
            }
          }
          return JSON.stringify({
            ok: false,
            kind: "no_prior_output",
            message: `No prior run found containing card "${cardId}".`,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return JSON.stringify({ ok: false, kind: "io_error", message });
        }
      },
    },
  },
  {
    name: "workflow_save_skill",
    category: "Workflow",
    schema: {
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
            description:
              "Short human-readable description of what the skill does.",
          },
          steps: {
            type: "array",
            description:
              'Ordered list of tool calls to replay. Each step is `{tool: "<tool_name>", args: {<tool args>}}`. Cannot contain workflow_invoke_skill / workflow_save_skill / workflow_delete_skill / spawn_subagent / await_subagents.',
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
            description:
              "When true, replace an existing skill with the same name. Default false (refuses to clobber).",
          },
        },
        required: ["name", "description", "steps"],
      },
    },
    sideEffect: "write",
    dangerous: false,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "workflow_skill_save",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "workflow-only",
    handler: {
      kind: "api",
      run: async (args) => {
        const { snapshot } = await import("../workflow/scratchpad");
        const snap = snapshot();
        if (!snap) {
          return JSON.stringify({ ok: false, kind: "not_in_workflow" });
        }
        const skillName = String(args.name ?? "");
        const description = String(args.description ?? "");
        const stepsRaw = args.steps;
        if (!skillName) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message: "name is required",
          });
        }
        if (!Array.isArray(stepsRaw)) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message: "steps must be an array",
          });
        }
        // Client-side filter for tools that would invite recursion or escape
        // the workflow-scoped intent. The Rust side enforces the same list at
        // save time — this is a short-circuit so a friendly error lands
        // without a round-trip. Keep in sync with FORBIDDEN_SKILL_TOOLS in
        // src-tauri/src/workflow_skills.rs.
        const FORBIDDEN_STEP_TOOLS = new Set([
          "workflow_invoke_skill",
          "workflow_save_skill",
          "workflow_delete_skill",
          "spawn_subagent",
          "await_subagents",
        ]);
        for (let i = 0; i < stepsRaw.length; i++) {
          const step = stepsRaw[i] as { tool?: unknown };
          if (
            !step ||
            typeof step !== "object" ||
            typeof step.tool !== "string"
          ) {
            return JSON.stringify({
              ok: false,
              kind: "bad_step",
              message: `step ${i} is missing a string \`tool\` field`,
            });
          }
          if (FORBIDDEN_STEP_TOOLS.has(step.tool)) {
            return JSON.stringify({
              ok: false,
              kind: "forbidden_step_tool",
              message: `step ${i} uses forbidden tool "${step.tool}"`,
            });
          }
        }
        const overwrite = args.overwrite === true;
        try {
          const id = await api.workflowSkillSave(
            snap.workflowId,
            skillName,
            description,
            JSON.stringify(stepsRaw),
            overwrite,
          );
          return JSON.stringify({ ok: true, id, name: skillName });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return JSON.stringify({ ok: false, kind: "save_failed", message });
        }
      },
    },
  },
  {
    name: "workflow_list_skills",
    category: "Workflow",
    schema: {
      description:
        "List skills saved for the current workflow. Returns summary rows (id, name, description, last_used_at, invocation_count) — use workflow_get_skill to fetch full step lists.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "workflow_skill_list",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "workflow-only",
    handler: {
      kind: "api",
      run: async () => {
        const { snapshot } = await import("../workflow/scratchpad");
        const snap = snapshot();
        if (!snap) {
          return JSON.stringify({ ok: false, kind: "not_in_workflow" });
        }
        try {
          const skills = await api.workflowSkillList(snap.workflowId);
          return JSON.stringify({ ok: true, skills });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return JSON.stringify({ ok: false, kind: "list_failed", message });
        }
      },
    },
  },
  {
    name: "workflow_get_skill",
    category: "Workflow",
    schema: {
      description:
        "Get a saved skill's full definition including its step list. Returns null when no skill with that name exists in the current workflow.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: false,
    rustCommand: "workflow_skill_get",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "workflow-only",
    handler: {
      kind: "api",
      run: async (args) => {
        const { snapshot } = await import("../workflow/scratchpad");
        const snap = snapshot();
        if (!snap) {
          return JSON.stringify({ ok: false, kind: "not_in_workflow" });
        }
        const skillName = String(args.name ?? "");
        if (!skillName) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message: "name is required",
          });
        }
        try {
          const skill = await api.workflowSkillGet(snap.workflowId, skillName);
          if (!skill) {
            return JSON.stringify({
              ok: false,
              kind: "not_found",
              name: skillName,
            });
          }
          return JSON.stringify({ ok: true, skill });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return JSON.stringify({ ok: false, kind: "get_failed", message });
        }
      },
    },
  },
  {
    name: "workflow_invoke_skill",
    category: "Workflow",
    schema: {
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
    sideEffect: "write",
    dangerous: false,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: null,
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "workflow-only",
    handler: {
      kind: "client",
      run: async (args, options) => {
        const { snapshot } = await import("../workflow/scratchpad");
        const snap = snapshot();
        if (!snap) {
          return JSON.stringify({ ok: false, kind: "not_in_workflow" });
        }
        const skillName = String(args.name ?? "");
        if (!skillName) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message: "name is required",
          });
        }
        const { recordSkillInvocation } = await import(
          "../workflow/skill-invocations"
        );
        const limit = recordSkillInvocation(skillName);
        if (!limit.ok) {
          return JSON.stringify({
            ok: false,
            kind: "rate_limit_hit",
            message: `skill "${skillName}" has been invoked ${limit.count} times this run (cap ${limit.cap}).`,
            count: limit.count,
            cap: limit.cap,
          });
        }
        let skill;
        try {
          skill = await api.workflowSkillGet(snap.workflowId, skillName);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return JSON.stringify({ ok: false, kind: "get_failed", message });
        }
        if (!skill) {
          return JSON.stringify({
            ok: false,
            kind: "not_found",
            name: skillName,
          });
        }
        let steps: Array<{ tool: string; args: Record<string, unknown> }>;
        try {
          const parsed = JSON.parse(skill.steps_json);
          if (!Array.isArray(parsed)) {
            return JSON.stringify({
              ok: false,
              kind: "corrupt_steps",
              message: "steps_json is not an array",
            });
          }
          steps = parsed as Array<{
            tool: string;
            args: Record<string, unknown>;
          }>;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return JSON.stringify({ ok: false, kind: "corrupt_steps", message });
        }
        const argsOverride =
          args.args_override &&
          typeof args.args_override === "object" &&
          !Array.isArray(args.args_override)
            ? (args.args_override as Record<string, unknown>)
            : {};

        // Audit boundary markers — synthesised audit rows that bracket the
        // replay so a reviewer can see "skill X started here, finished
        // here, ran N inner steps". The inner tool calls audit themselves
        // normally via the runner.
        recordAuditSafe({
          toolName: "skill_invocation_start",
          args: { skill_name: skillName },
          resultBody: "",
          durationMs: 0,
          approval: "auto",
          outcome: "ok",
          // Audit L-A2 (2026-05-28): thread the parent workflow run id so the
          // bracket pair is correlated to its workflow row in the audit view.
          // Previously hardcoded null — skill replays inside a workflow were
          // orphaned from their parent run.
          workflowRunId: options.workflowRunId ?? null,
        });

        const stepResults: Array<Record<string, unknown>> = [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (
            !step ||
            typeof step !== "object" ||
            typeof step.tool !== "string" ||
            step.tool.length === 0 ||
            typeof step.args !== "object" ||
            step.args === null ||
            Array.isArray(step.args)
          ) {
            stepResults.push({ step_index: i, ok: false, kind: "bad_step" });
            break;
          }
          // SECURITY (skill-replay approval gate): this loop calls executeTool
          // DIRECTLY, which means the runner's confirmation gate
          // (DANGEROUS_TOOLS → requestConfirmation in runner.ts) is NOT applied
          // to these inner steps. A replayed skill therefore must never auto-run
          // a tool that would otherwise force a prompt — doing so is an
          // unattended-execution bypass for run_shell / delete_path / http_request
          // / MCP tools, etc. The save-time FORBIDDEN_STEP_TOOLS filter only
          // blocks recursion/subagent escape and only at save time, so a row
          // written before that list changed (or written directly to the DB)
          // can still carry a dangerous step. Re-validate EVERY step here and
          // fail closed. (Richer follow-up: thread the runner's real gate through
          // ExecuteToolOptions so dangerous steps can prompt instead of refuse.)
          const REPLAY_RECURSION_TOOLS = new Set([
            "workflow_invoke_skill",
            "workflow_save_skill",
            "workflow_delete_skill",
            "spawn_subagent",
            "await_subagents",
          ]);
          if (
            REPLAY_RECURSION_TOOLS.has(step.tool) ||
            DANGEROUS_TOOLS.has(step.tool) ||
            isMcpToolName(step.tool)
          ) {
            stepResults.push({
              step_index: i,
              tool: step.tool,
              ok: false,
              kind: "forbidden_step_tool",
              message: `skill step "${step.tool}" requires explicit confirmation and cannot run unattended inside a replayed skill`,
            });
            break;
          }
          const mergedArgs: Record<string, unknown> = {
            ...step.args,
            ...argsOverride,
          };
          let parsed: Record<string, unknown>;
          try {
            // Dispatch the (now confirmed-safe, non-dangerous) step through the
            // same executeTool surface. Dangerous/recursive tools were already
            // refused above — the runner's confirmation gate does NOT reach here.
            const result = await executeTool(step.tool, mergedArgs, options);
            try {
              const decoded = JSON.parse(result);
              parsed =
                decoded && typeof decoded === "object" && !Array.isArray(decoded)
                  ? (decoded as Record<string, unknown>)
                  : { ok: false, raw: result };
            } catch {
              parsed = { ok: false, raw: result };
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            parsed = { ok: false, kind: "step_threw", message };
          }
          stepResults.push({ step_index: i, tool: step.tool, ...parsed });
          if (parsed && parsed.ok === false) break;
        }

        recordAuditSafe({
          toolName: "skill_invocation_end",
          args: { skill_name: skillName, steps_run: stepResults.length },
          resultBody: "",
          durationMs: 0,
          approval: "auto",
          outcome: "ok",
          // See L-A2 note on the matching start marker above.
          workflowRunId: options.workflowRunId ?? null,
        });

        // Best-effort: bump server-side last_used_at + invocation_count.
        // A failure to record must not mask the actual replay result.
        try {
          await api.workflowSkillRecordInvocation(snap.workflowId, skillName);
        } catch (e) {
          logDiag({
            level: "warn",
            source: "workflow-skills",
            message: `workflow_skill_record_invocation failed for "${skillName}"`,
            detail: redactDiagDetail(e),
          });
        }

        const lastStep = stepResults[stepResults.length - 1];
        const overall_ok = !!(lastStep && lastStep.ok !== false);
        return JSON.stringify({
          ok: overall_ok,
          skill: skillName,
          steps: stepResults,
        });
      },
    },
  },
  {
    name: "workflow_delete_skill",
    category: "Workflow",
    schema: {
      description: "Delete a saved skill from the current workflow.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    sideEffect: "write",
    dangerous: false,
    dryRun: "suppress",
    cacheableRead: false,
    rustCommand: "workflow_skill_delete",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "workflow-only",
    handler: {
      kind: "api",
      run: async (args) => {
        const { snapshot } = await import("../workflow/scratchpad");
        const snap = snapshot();
        if (!snap) {
          return JSON.stringify({ ok: false, kind: "not_in_workflow" });
        }
        const skillName = String(args.name ?? "");
        if (!skillName) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message: "name is required",
          });
        }
        try {
          await api.workflowSkillDelete(snap.workflowId, skillName);
          return JSON.stringify({ ok: true, name: skillName });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return JSON.stringify({ ok: false, kind: "delete_failed", message });
        }
      },
    },
  },
  {
    name: "list_claude_skills",
    category: "Skills",
    schema: {
      description:
        "List the user's imported Claude Skills (name + description only). Call this if you need to see what skills are available before deciding which to load.",
      parameters: { type: "object", properties: {} },
    },
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "claude_skill_list",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async () => {
        const rows = await api.claudeSkillList(true);
        return JSON.stringify({
          ok: true,
          skills: rows.map((r) => ({
            name: r.name,
            description: r.description,
          })),
        });
      },
    },
  },
  {
    name: "load_claude_skill",
    category: "Skills",
    schema: {
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
    sideEffect: "read",
    dangerous: false,
    dryRun: "run",
    cacheableRead: true,
    rustCommand: "claude_skill_get",
    approval: null,
    writeTool: false,
    irreversible: false,
    flow: {
      pickerExposed: true,
      presetCategory: "memory",
    },
    scope: "chat",
    handler: {
      kind: "api",
      run: async (args) => {
        const skillName = String(args.name ?? "");
        if (!skillName) {
          return JSON.stringify({
            ok: false,
            kind: "bad_args",
            message: "name is required",
          });
        }
        const row = await api.claudeSkillGet(skillName);
        if (!row) {
          return JSON.stringify({
            ok: false,
            kind: "not_found",
            message: `Skill '${skillName}' not found.`,
          });
        }
        if (!row.enabled) {
          return JSON.stringify({
            ok: false,
            kind: "disabled",
            message: `Skill '${skillName}' is disabled.`,
          });
        }
        // The skill's frontmatter `allowed_tools` is stored as a JSON string.
        // Surface it as a parsed array to the model when it parses cleanly;
        // a null column or unparseable value leaves the field undefined so
        // the caller can omit it from its planning.
        let allowedTools: string[] | undefined;
        if (row.allowed_tools_json) {
          try {
            const parsed = JSON.parse(row.allowed_tools_json);
            if (
              Array.isArray(parsed) &&
              parsed.every((x) => typeof x === "string")
            ) {
              allowedTools = parsed as string[];
            }
          } catch {
            /* leave undefined — malformed frontmatter is silently dropped */
          }
        }
        return JSON.stringify({
          ok: true,
          name: row.name,
          description: row.description,
          body: row.body_md,
          allowed_tools: allowedTools,
          source_path: row.source_path,
        });
      },
    },
  },
];

/** name → descriptor lookup. */
export const REGISTRY_BY_NAME: ReadonlyMap<string, ToolDescriptor> = new Map(
  TOOL_REGISTRY.map((d) => [d.name, d]),
);
