import { api } from "../tauri-api";
import type { AuditApproval, AuditOutcome, ToolCall } from "../../types";
import { dispatchMcpTool, isMcpToolName } from "./mcp-tools";

export const DANGEROUS_TOOLS = new Set([
  "run_shell", "write_file", "edit_file", "multi_edit",
  "git_commit", "clipboard_set", "open_app",
  "applescript_run", "http_request",
]);
export const SHELL_TOOL = "run_shell";
export const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "multi_edit",
  "git_commit", "clipboard_set", "applescript_run", "http_request",
]);

/* ── Tool execution helpers ── */

export function parseArgs(
  raw: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; err: string } {
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

export function formatToolError(raw: unknown): string {
  const s = String((raw as { message?: string })?.message ?? raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && parsed.kind && parsed.message) {
      return JSON.stringify({ ok: false, kind: parsed.kind, message: parsed.message });
    }
  } catch {/* fallthrough */}
  return JSON.stringify({ ok: false, kind: "unknown", message: s });
}

export function toolCallSig(tc: ToolCall): string {
  const name = tc.function?.name ?? "";
  const args = tc.function?.arguments;
  const argStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return `${name}::${argStr}`;
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

/* ── Audit helpers ── */

/**
 * Bound on the args payload we persist for the audit log. Bulky write fields
 * (`content`, `old_string`, `new_string`) are truncated client-side so the
 * DB never holds whole-file write blobs.
 */
const ARG_TRUNCATE_FIELDS: Record<string, string[]> = {
  write_file: ["content"],
  edit_file: ["old_string", "new_string"],
  multi_edit: [], // each edit's old_string/new_string handled below
};

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

export function redactArgsForAudit(name: string, args: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...args };
  const fields = ARG_TRUNCATE_FIELDS[name] ?? [];
  for (const f of fields) {
    const v = copy[f];
    if (typeof v === "string") copy[f] = truncateString(v, 256);
  }
  // multi_edit has an `edits` array with old_string/new_string in each.
  if (name === "multi_edit" && Array.isArray(copy.edits)) {
    copy.edits = (copy.edits as Array<Record<string, unknown>>).map((e) => {
      const out: Record<string, unknown> = { ...e };
      if (typeof out.old_string === "string") out.old_string = truncateString(out.old_string, 256);
      if (typeof out.new_string === "string") out.new_string = truncateString(out.new_string, 256);
      return out;
    });
  }
  try {
    return JSON.stringify(copy);
  } catch {
    return "{}";
  }
}

export interface AuditInput {
  toolName: string;
  args: Record<string, unknown>;
  resultBody: string;
  durationMs: number;
  approval: AuditApproval;
  outcome: AuditOutcome;
  errorKind?: string | null;
  conversationId?: number | string | null;
}

/**
 * Best-effort audit write — never throws. Errors are logged to console so the
 * agent loop is unaffected by an audit failure (db locked, disk full, etc.).
 */
export function recordAuditSafe(input: AuditInput): void {
  try {
    void api
      .agentAuditRecord({
        tool_name: input.toolName,
        args_json: redactArgsForAudit(input.toolName, input.args),
        result_body: input.resultBody,
        duration_ms: Math.max(0, Math.round(input.durationMs)),
        approval: input.approval,
        outcome: input.outcome,
        error_kind: input.errorKind ?? null,
        conversation_id:
          input.conversationId == null ? null : String(input.conversationId),
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[audit] record failed:", e);
      });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[audit] record sync error:", e);
  }
}

/* ── Risk classifier hookups for dangerous tools ── */

export async function classifyToolRisk(
  fnName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (fnName === SHELL_TOOL) {
    try {
      return await api.agentClassifyShell(String(args.command ?? ""));
    } catch {/* keep normal */}
  } else if (fnName === "applescript_run") {
    try {
      return await api.agentClassifyApplescript(String(args.script ?? ""));
    } catch {/* keep normal */}
  } else if (fnName === "http_request") {
    try {
      const headers = (args.headers && typeof args.headers === "object")
        ? args.headers as Record<string, unknown>
        : {};
      const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
      return await api.agentClassifyHttp(String(args.method ?? "GET"), hasAuth);
    } catch {/* keep normal */}
  }
  return "normal";
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  // MCP-routed tools: names prefixed `mcp__server__tool`.
  if (isMcpToolName(name)) {
    return dispatchMcpTool(name, args);
  }
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
