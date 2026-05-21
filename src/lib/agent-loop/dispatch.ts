import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";
import type { AuditApproval, AuditOutcome, ToolCall } from "../../types";
import { dispatchMcpTool, isMcpToolName } from "./mcp-tools";

/* ── Dry-run mode ────────────────────────────────────────────────────────
 *
 * Frontend-only short-circuit for side-effectful tools. When the dispatcher
 * is invoked with `dryRun=true`, the targeted tools return a structured
 * `{ok:true, dry_run:true, would_*:...}` payload instead of invoking the
 * Tauri command. Read-only tools (read_file, list_dir, ...) are unaffected.
 *
 * Audit log still records the suppressed call with `outcome: "dry_run"` so
 * the user can review what the agent intended to do.
 *
 * NOTE: this is intentionally a frontend-only concept. The Rust commands
 * are unchanged — the shim lives entirely here in `dispatch.ts`.
 */
export const DRY_RUN_TOOLS = new Set([
  "write_file", "edit_file", "multi_edit",
  "run_shell", "applescript_run",
  "browser_navigate", "browser_click", "browser_fill",
]);

export const DANGEROUS_TOOLS = new Set([
  "run_shell", "write_file", "edit_file", "multi_edit",
  "git_commit", "clipboard_set", "open_app",
  "applescript_run", "http_request",
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
      return await api.agentClassifyApplescript(String(args.script ?? ""));
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message: "classifyToolRisk: applescript classifier failed — defaulting to normal",
        detail: err,
      });
    }
  } else if (fnName === "http_request") {
    try {
      const headers = (args.headers && typeof args.headers === "object")
        ? args.headers as Record<string, unknown>
        : {};
      const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
      return await api.agentClassifyHttp(String(args.method ?? "GET"), hasAuth);
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

/* ── Dry-run executors ── */

function truncForDryRun(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Best-effort SHA-256 → first 16 hex chars. Returns "" on environments
 * lacking SubtleCrypto (test runner, etc.). */
async function sha256First16(text: string): Promise<string> {
  try {
    const subtle: SubtleCrypto | undefined = (globalThis as { crypto?: { subtle?: SubtleCrypto } })
      .crypto?.subtle;
    if (!subtle) return "";
    const buf = new TextEncoder().encode(text);
    const digest = await subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, 16);
  } catch {
    return "";
  }
}

/**
 * Minimal unified-diff generator. Not as polished as `diff`'s LCS — produces
 * a serviceable replace-block diff (one `-`/`+` chunk per change). Enough
 * for the agent to see what the dry-run would have written.
 */
function makeUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return `--- a/${path}\n+++ b/${path}\n@@ (no changes) @@\n`;
  }
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) {
    tailA--; tailB--;
  }
  const context = 3;
  const ctxStart = Math.max(0, head - context);
  const removed = a.slice(head, tailA + 1);
  const added = b.slice(head, tailB + 1);
  const ctxBefore = a.slice(ctxStart, head);
  const ctxAfterEndA = Math.min(a.length, tailA + 1 + context);
  const ctxAfterEndB = Math.min(b.length, tailB + 1 + context);
  const ctxAfter = a.slice(tailA + 1, ctxAfterEndA);
  // sanity: tail context should match across files (they were equal there)
  void ctxAfterEndB;
  const aHunkLen = ctxBefore.length + removed.length + ctxAfter.length;
  const bHunkLen = ctxBefore.length + added.length + ctxAfter.length;
  const aStart = ctxStart + 1; // 1-indexed
  const bStart = ctxStart + 1;
  const lines: string[] = [];
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  lines.push(`@@ -${aStart},${aHunkLen} +${bStart},${bHunkLen} @@`);
  for (const l of ctxBefore) lines.push(` ${l}`);
  for (const l of removed) lines.push(`-${l}`);
  for (const l of added) lines.push(`+${l}`);
  for (const l of ctxAfter) lines.push(` ${l}`);
  return lines.join("\n");
}

/**
 * Lightweight client-side SSRF preflight that mirrors the Rust
 * `validate_navigate_url` string-level checks: scheme allowlist + obvious
 * private / loopback / link-local / .local hosts. We can't reach Rust's
 * DNS resolver from the dry-run shim (no exposed command), but rejecting
 * obvious bad URLs is enough for "would have been rejected" reporting.
 */
export function dryRunValidateUrl(urlStr: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return { ok: false, reason: `bad url: ${(e as Error).message}` };
  }
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https" && scheme !== "data") {
    return { ok: false, reason: `scheme '${scheme}' not allowed (use http/https/data:)` };
  }
  if (scheme === "data") return { ok: true, url: u };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "missing host" };
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return {
      ok: false,
      reason: `host '${host}' is private/loopback/link-local — blocked to prevent SSRF`,
    };
  }
  // IPv4 literal check
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const oct = [v4[1], v4[2], v4[3], v4[4]].map((n) => parseInt(n, 10));
    if (oct.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return { ok: false, reason: `invalid ipv4 host '${host}'` };
    }
    const [a, b, c] = oct;
    const isLoopback = a === 127;
    const isPrivate10 = a === 10;
    const isPrivate172 = a === 172 && b >= 16 && b <= 31;
    const isPrivate192 = a === 192 && b === 168;
    const isLinkLocal = a === 169 && b === 254;
    const isUnspecified = a === 0;
    const isMulticast = a >= 224 && a <= 239;
    const isBroadcast = a === 255 && b === 255 && c === 255 && oct[3] === 255;
    if (
      isLoopback || isPrivate10 || isPrivate172 || isPrivate192 ||
      isLinkLocal || isUnspecified || isMulticast || isBroadcast
    ) {
      return {
        ok: false,
        reason: `host '${host}' is private/loopback/link-local — blocked to prevent SSRF`,
      };
    }
  }
  // IPv6 literal check (bracketed in hostname per URL spec → already stripped)
  if (host.includes(":")) {
    if (host === "::" || host === "::1" || host.startsWith("fe80:") ||
        host.startsWith("fc") || host.startsWith("fd") || host.startsWith("ff")) {
      return {
        ok: false,
        reason: `host '${host}' is private/loopback/link-local — blocked to prevent SSRF`,
      };
    }
  }
  return { ok: true, url: u };
}

async function dryRunExecute(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "write_file": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const sha = await sha256First16(content);
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_write: {
          path,
          size_bytes: new TextEncoder().encode(content).length,
          sha256_first16: sha,
        },
      });
    }
    case "edit_file": {
      const path = String(args.path ?? "");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const replaceAll = args.replace_all === true;
      let before = "";
      try {
        const r = await api.agentReadFile(path);
        if (r && typeof r === "object" && "content" in r) {
          before = String((r as { content?: unknown }).content ?? "");
        }
      } catch (e) {
        return JSON.stringify({
          ok: false,
          dry_run: true,
          kind: "read_failed",
          message: `dry-run: could not read '${path}' for diff: ${(e as Error).message ?? e}`,
        });
      }
      const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
      const diff = makeUnifiedDiff(path, before, after);
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_change: truncForDryRun(diff, 4096),
      });
    }
    case "multi_edit": {
      const path = String(args.path ?? "");
      const edits = Array.isArray(args.edits)
        ? (args.edits as Array<{ old_string?: unknown; new_string?: unknown; replace_all?: unknown }>)
        : [];
      let before = "";
      try {
        const r = await api.agentReadFile(path);
        if (r && typeof r === "object" && "content" in r) {
          before = String((r as { content?: unknown }).content ?? "");
        }
      } catch (e) {
        return JSON.stringify({
          ok: false,
          dry_run: true,
          kind: "read_failed",
          message: `dry-run: could not read '${path}' for diff: ${(e as Error).message ?? e}`,
        });
      }
      let after = before;
      for (const ed of edits) {
        const oldStr = String(ed.old_string ?? "");
        const newStr = String(ed.new_string ?? "");
        if (ed.replace_all === true) {
          after = after.split(oldStr).join(newStr);
        } else {
          after = after.replace(oldStr, newStr);
        }
      }
      const diff = makeUnifiedDiff(path, before, after);
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_change: truncForDryRun(diff, 4096),
      });
    }
    case "run_shell": {
      const command = String(args.command ?? "");
      const cwd = args.cwd ? String(args.cwd) : null;
      const env = args.env && typeof args.env === "object" ? args.env : null;
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_run: command,
        cwd,
        env,
      });
    }
    case "applescript_run": {
      const script = String(args.script ?? "");
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_run_applescript: truncForDryRun(script, 2048),
      });
    }
    case "browser_navigate": {
      const urlStr = String(args.url ?? "");
      const v = dryRunValidateUrl(urlStr);
      if (!v.ok) {
        return JSON.stringify({
          ok: false,
          dry_run: true,
          blocked_by_safety: v.reason,
        });
      }
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_navigate: urlStr,
      });
    }
    case "browser_click": {
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_click: String(args.selector ?? ""),
      });
    }
    case "browser_fill": {
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_fill: {
          selector: String(args.selector ?? ""),
          value: String(args.value ?? ""),
        },
      });
    }
    default:
      // Should never hit — DRY_RUN_TOOLS is the gate.
      return JSON.stringify({ ok: false, kind: "unknown_dry_run_tool", message: name });
  }
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
