import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";
import type { AuditApproval, AuditOutcome, ToolCall } from "../../types";
import type { Risk } from "./types";
import { dispatchMcpTool, isMcpToolName } from "./mcp-tools";
import { looksLikeSecret } from "../memory-client";
import { DRY_RUN_TOOLS, dryRunExecute } from "./dry-run";

// Re-exported so existing import sites (`./dispatch`) keep working unchanged.
export { DRY_RUN_TOOLS } from "./dry-run";
export { dryRunValidateUrl, normalizeIntegerHost } from "./url-safety";
export { makeUnifiedDiff } from "./diff";

export const DANGEROUS_TOOLS = new Set([
  "run_shell", "write_file", "edit_file", "multi_edit",
  "git_commit", "clipboard_set", "open_app",
  "applescript_run", "http_request",
  // Spawning a subagent runs a fresh agent loop whose prompt can be
  // attacker-influenced (injected content) — require explicit confirmation.
  "spawn_subagent",
  // Browser automation — every call can navigate to or interact with arbitrary
  // public sites. SSRF-blocked at the Rust layer, but still gated behind a
  // confirm dialog so the user sees each action.
  "browser_navigate", "browser_click", "browser_fill",
  "browser_screenshot", "browser_get_text", "browser_close",
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

/**
 * Dispatch helper for the `search_project_knowledge` agent tool. Exposed so
 * tests can stub it independently of `api.ragSearch`.
 */
export async function agentRagSearch(
  corpus: string,
  query: string,
  topK?: number,
): Promise<unknown[]> {
  const hits = await api.ragSearch(corpus, query, topK);
  return hits;
}

let currentShellOpId: string | null = null;

export function cancelActiveShell(): boolean {
  if (currentShellOpId) {
    const id = currentShellOpId;
    currentShellOpId = null;
    api.agentCancelShell(id).catch((err) =>
      logDiag({
        level: "warn",
        source: "agent-loop",
        message: `cancelActiveShell: agent_cancel_shell failed for opId ${id}`,
        detail: err,
      }),
    );
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

/**
 * Replace secret-looking substrings in a string before it is persisted. The
 * audit DB must never hold raw credentials (a `run_shell` command may carry
 * `export AWS_SECRET_ACCESS_KEY=...`, an http_request header a bearer token).
 * Scans each whitespace-delimited token; any token matching a secret pattern
 * is swapped for `[REDACTED]`. Falls back to redacting the whole value when
 * a labeled-credential pattern spans tokens.
 */
function redactSecrets(s: string): string {
  if (!s || !looksLikeSecret(s)) return s;
  const scrubbed = s
    .split(/(\s+)/)
    .map((tok) => (tok.trim() && looksLikeSecret(tok) ? "[REDACTED]" : tok))
    .join("");
  // Per-token scrubbing misses patterns like `password = hunter2hunter2...`
  // where the secret spans the `=` boundary — redact the whole value then.
  return looksLikeSecret(scrubbed) ? "[REDACTED]" : scrubbed;
}

/** Recursively redact secret-looking string values within an args value. */
function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(vv);
    }
    return out;
  }
  return v;
}

export function redactArgsForAudit(name: string, args: Record<string, unknown>): string {
  // Secret redaction first — covers command, env, headers, body, and any
  // nested string arg — then bulky-field truncation on top.
  const copy = redactValue({ ...args }) as Record<string, unknown>;
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
): Promise<Risk> {
  if (fnName === SHELL_TOOL) {
    try {
      return (await api.agentClassifyShell(String(args.command ?? ""))) as Risk;
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message: "classifyToolRisk: shell classifier failed — defaulting to normal",
        detail: err,
      });
    }
  } else if (fnName === "applescript_run") {
    try {
      return (await api.agentClassifyApplescript(String(args.script ?? ""))) as Risk;
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message: "classifyToolRisk: applescript classifier failed — defaulting to normal",
        detail: err,
      });
    }
  } else if (fnName === "http_request") {
    // A request carrying a body can exfiltrate data regardless of method —
    // elevate it so it always needs confirmation and is never swept up by a
    // blanket write-approval (which only covers `normal`-risk writes).
    const hasBody = args.body != null && String(args.body).length > 0;
    if (hasBody) return "privileged";
    try {
      const headers = (args.headers && typeof args.headers === "object")
        ? args.headers as Record<string, unknown>
        : {};
      const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
      return (await api.agentClassifyHttp(String(args.method ?? "GET"), hasAuth)) as Risk;
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message: "classifyToolRisk: http classifier failed — defaulting to normal",
        detail: err,
      });
    }
  }
  return "normal";
}

export interface ExecuteToolOptions {
  /** When true, side-effectful tools short-circuit and return a dry-run payload. */
  dryRun?: boolean;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  options: ExecuteToolOptions = {},
): Promise<string> {
  // Dry-run shim: short-circuit side-effectful tools before they reach Tauri.
  // Read-only tools fall through to the normal switch below.
  if (options.dryRun && DRY_RUN_TOOLS.has(name)) {
    return dryRunExecute(name, args);
  }
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
    case "browser_navigate": {
      const r = await api.agentBrowserNavigate(String(args.url ?? ""));
      return JSON.stringify(r);
    }
    case "browser_click": {
      const r = await api.agentBrowserClick(String(args.selector ?? ""));
      return JSON.stringify(r);
    }
    case "browser_fill": {
      const r = await api.agentBrowserFill(
        String(args.selector ?? ""),
        String(args.value ?? ""),
      );
      return JSON.stringify(r);
    }
    case "browser_screenshot": {
      const r = await api.agentBrowserScreenshot();
      return JSON.stringify(r);
    }
    case "browser_get_text": {
      const r = await api.agentBrowserGetText(
        args.selector ? String(args.selector) : undefined,
      );
      return JSON.stringify(r);
    }
    case "browser_close": {
      const r = await api.agentBrowserClose();
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
    case "watch_path": {
      const r = await api.agentWatchPath(
        String(args.path ?? ""),
        args.glob ? String(args.glob) : undefined,
        typeof args.debounce_ms === "number" ? args.debounce_ms : undefined,
      );
      return JSON.stringify(r);
    }
    case "poll_watch": {
      const r = await api.agentPollWatch(
        String(args.id ?? ""),
        typeof args.since_ms === "number" ? args.since_ms : undefined,
        typeof args.max_events === "number" ? args.max_events : undefined,
      );
      return JSON.stringify(r);
    }
    case "stop_watch": {
      await api.agentStopWatch(String(args.id ?? ""));
      return JSON.stringify({ ok: true });
    }
    case "list_watches": {
      const r = await api.agentListWatches();
      return JSON.stringify(r);
    }
    case "search_project_knowledge": {
      const hits = await agentRagSearch(
        String(args.corpus_name ?? ""),
        String(args.query ?? ""),
        typeof args.top_k === "number" ? args.top_k : undefined,
      );
      return JSON.stringify({ ok: true, hits });
    }
    default:
      return JSON.stringify({ ok: false, kind: "unknown_tool", message: `Unknown tool: ${name}` });
  }
}
