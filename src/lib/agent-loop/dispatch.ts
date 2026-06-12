import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";
import type { AuditApproval, AuditOutcome, ToolCall } from "../../types";
import { serializeWorkflowGraph } from "../../types";
import {
  assertFlowSafe,
  assertFlowSafeAdvanced,
  buildAdvancedFlow,
  buildLinearFlow,
} from "../workflow/create-flow";
import type { Risk } from "./types";
import { dispatchMcpTool, isMcpToolName } from "./mcp-tools";
import { looksLikeSecret, recall, saveMemory } from "../memory-client";
import { DRY_RUN_READ_ONLY, DRY_RUN_TOOLS, dryRunExecute } from "./dry-run";

// Re-exported for tests that import it from `./dispatch`.
export { dryRunValidateUrl } from "./url-safety";

export const DANGEROUS_TOOLS = new Set([
  // task_create backgrounds a `sh -c` command — same RCE surface as run_shell,
  // so it MUST prompt + carry a command-bound approval token (SEC-HIGH).
  "run_shell",
  "task_create",
  "write_file",
  "write_files",
  // apply_patch writes (creates/edits) one or more files from a unified diff —
  // same filesystem-mutation surface as write_files, so it prompts + carries a
  // patch-bound approval token.
  "apply_patch",
  "edit_file",
  "multi_edit",
  "git_commit",
  "clipboard_set",
  "open_app",
  "applescript_run",
  "http_request",
  // call_api hits a user-registered external API WITH the user's stored
  // credentials injected — can read or mutate real accounts, and can exfil.
  // Always confirm (the modal shows api|method|path).
  "call_api",
  // Code sandbox runs arbitrary code in a throwaway interpreter — identical
  // RCE surface to run_shell, so it prompts + carries a code-bound token.
  "run_code",
  // Spawning a subagent runs a fresh agent loop whose prompt can be
  // attacker-influenced (injected content) — require explicit confirmation.
  "spawn_subagent",
  // Browser automation — every call can navigate to or interact with arbitrary
  // public sites. SSRF-blocked at the Rust layer, but still gated behind a
  // confirm dialog so the user sees each action.
  "browser_navigate",
  "browser_click",
  "browser_fill",
  "browser_screenshot",
  "browser_get_text",
  "browser_close",
  // Image generation — disk + GPU spend, and the model can be told arbitrary
  // prompts (which then become user-visible PNGs in the gallery).
  // Extras: file ops + process control + undo. Each touches the filesystem
  // or sends a signal to a foreign process — gate behind confirmation.
  "move_path",
  "copy_path",
  "delete_path",
  "make_dir",
  "kill_process",
  "agent_undo",
  // Sec audit round 4: these were MISSING from the gate, so a prompt-injected
  // agent ran them with NO confirmation (the Rust side binds a token, but
  // tauri-api mints it inline, so DANGEROUS_TOOLS membership is the only thing
  // that shows the user a modal). Each mutates host state:
  //   • format_code  — rewrites the target file IN PLACE (no undo snapshot)
  //   • screenshot   — captures the screen (bank/password mgr) to a PNG that
  //                    read_file can then exfiltrate
  //   • show_notification — silent phishing toast
  "format_code",
  "screenshot",
  "show_notification",
  // create_flow persists a Flow to the user's library — confirm it (the user
  // sees what's being created). The Flow itself is built inert (non-unattended,
  // read-only curated tools) by the builder.
  "create_flow",
  // Sec audit round 5: also un-gated and side-effectful from plain chat.
  //   • remember — persistent write to the long-term memory store. MEMORY
  //     POISONING: an injected agent plants durable global-scope "facts" that
  //     resurface via recall and steer ALL future chats/runs. (recall_memory
  //     stays ungated — it's read-only.)
  //   • watch_path — spawns a persistent OS filesystem watcher on any path.
  //   • stop_watch / task_cancel — destroy OTHER runtime state by id (kill the
  //     user's in-flight background task, disable a watcher they set up).
  "remember",
  "watch_path",
  "stop_watch",
  "task_cancel",
]);
export const SHELL_TOOL = "run_shell";
export const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "git_commit",
  "clipboard_set",
  "applescript_run",
  "http_request",
  // UX-CRIT-1 (2026-05-24 re-review): the safe additions only — anything
  // truly destructive lives in IRREVERSIBLE_TOOLS below and is EXCLUDED
  // from the session-blanket-approve branch in runner.ts. `agent_undo` is
  // ALSO excluded because undo-of-undo is an unrecoverable redo.
  "move_path",
  "copy_path",
  "make_dir",
  // format_code rewrites a file's content in place (prettier/rustfmt/black/…),
  // so it's a filesystem write: policy path-rules must apply to its `path`.
  "format_code",
]);

/**
 * Tools that are NEVER eligible for blanket session approval — every call
 * always requires an explicit user confirmation, even when "Approve all
 * writes this session" or "Approve all shell this session" is on. The
 * common theme: the operation is either irreversible (delete, kill,
 * undo-of-undo) or its blast radius is too easy to misestimate from a
 * single JSON-blob preview.
 */
export const IRREVERSIBLE_TOOLS = new Set([
  "delete_path",
  "kill_process",
  "agent_undo",
]);

/* ── Tool execution helpers ── */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseArgs(
  raw: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; err: string } {
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, err: `Could not parse tool arguments as JSON: ${e}` };
    }
    // Reject arrays/null/numbers/strings/booleans — only a JSON object is a
    // valid tool-call argument record. An array slipping through as
    // `Record<string, unknown>` would let `args.path` be e.g. element "0",
    // which is meaningless and unsafe.
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        err: "Tool arguments must be a JSON object, not array/null/scalar.",
      };
    }
    return { ok: true, args: parsed };
  }
  if (isPlainObject(raw)) {
    return { ok: true, args: raw };
  }
  if (raw == null) {
    return { ok: true, args: {} };
  }
  return {
    ok: false,
    err: "Tool arguments must be a JSON object, not array/null/scalar.",
  };
}

export function formatToolError(raw: unknown): string {
  const s = String((raw as { message?: string })?.message ?? raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") {
      // Native Froglips shape: top-level {ok:false, kind, message}.
      if (
        typeof parsed.kind === "string" &&
        typeof parsed.message === "string"
      ) {
        return JSON.stringify({
          ok: false,
          kind: parsed.kind,
          message: parsed.message,
        });
      }
      // Audit M13 (2026-05-27): also recognise the common upstream shapes
      // so MCP servers / Ollama / MLX errors carry context instead of
      // collapsing to kind:"unknown". Priority order:
      //   1. {error: {message}}      — Ollama, OpenAI-ish
      //   2. {error: "..."}          — older Ollama
      //   3. {detail: "..."}         — FastAPI / MLX
      //   4. {status: "..."}         — generic
      const err = parsed.error;
      if (err && typeof err === "object" && typeof err.message === "string") {
        return JSON.stringify({
          ok: false,
          kind: typeof err.code === "string" ? err.code : "upstream_error",
          message: err.message,
        });
      }
      if (typeof err === "string" && err.length > 0) {
        return JSON.stringify({
          ok: false,
          kind: "upstream_error",
          message: err,
        });
      }
      if (typeof parsed.detail === "string" && parsed.detail.length > 0) {
        return JSON.stringify({
          ok: false,
          kind: "upstream_detail",
          message: parsed.detail,
        });
      }
      if (typeof parsed.status === "string" && parsed.status.length > 0) {
        return JSON.stringify({
          ok: false,
          kind: "upstream_status",
          message: parsed.status,
        });
      }
    }
  } catch {
    /* fallthrough */
  }
  return JSON.stringify({ ok: false, kind: "unknown", message: s });
}

export function toolCallSig(tc: ToolCall): string {
  const name = tc.function?.name ?? "";
  const args = tc.function?.arguments;
  const argStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return `${name}::${argStr}`;
}

/**
 * Cheap heuristic: does a shell command look like it's writing a file via the
 * shell rather than using write_file/write_files/edit_file? Matches three
 * shapes:
 *   • a heredoc whose body is redirected to a file  (`cat > f << EOF`)
 *   • plain output redirection to a path            (`echo x > f`, `… >> f`)
 *   • `tee` writing to a file                       (`… | tee f`)
 *
 * Deliberately tolerant of the common NON-write redirections so we don't nag:
 *   • fd-dup like `2>&1`, `1>&2`, `&>`              (no real file target)
 *   • discards to `/dev/null` / `/dev/stdout` / etc.
 * Used only to APPEND a steering note — never to block the command.
 */
export function looksLikeShellFileWrite(command: string): boolean {
  const cmd = String(command ?? "");
  if (!cmd.trim()) return false;
  // `tee` (with or without -a) writing somewhere.
  if (/(^|[|;&]|\s)tee\b/.test(cmd)) return true;
  // Heredoc feeding a redirect: `<<EOF` / `<<-'EOF'` / `<< "EOF"` paired with
  // a `>`/`>>` somewhere on the command. The heredoc body itself is what blows
  // past the shell length cap, so this is the canonical pattern to catch.
  if (/<<-?\s*['"]?\w+/.test(cmd) && />>?/.test(cmd)) return true;
  // Strip the redirections we explicitly DON'T care about, then see whether a
  // real `>`/`>>` to a path survives. Removing `2>&1`, `&>`, `1>&2`, and any
  // `>`/`>>` aimed at /dev/null|stdout|stderr|fd avoids the false positives.
  const cleaned = cmd
    .replace(/\d*>&\d*/g, " ") // fd-dup: 2>&1, 1>&2, >&2
    .replace(/&>>?/g, " ") // bash &> / &>>
    .replace(/\d*>>?\s*\/dev\/\S+/g, " ") // > /dev/null, 2>> /dev/stderr
    .replace(/\d*>>?\s*&\d+/g, " "); // > &1 style
  // A surviving `>` or `>>` (optionally fd-prefixed) followed by a token that
  // isn't another redirection means an actual file target.
  return /\d*>>?\s*[^|;&<>\s]/.test(cleaned);
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

/**
 * Safe arithmetic evaluator for the `calculate` tool. A hand-written
 * shunting-yard parser — NEVER `eval()`/`Function()` — so a model can't smuggle
 * code execution through an "expression". Supports + - * / % ^, unary minus,
 * parentheses, and a small set of named functions/constants. Returns a result
 * object the tool serializes directly.
 */
export function safeCalculate(
  expr: string,
):
  | { ok: true; expression: string; result: number }
  | { ok: false; error: string } {
  const src = expr.trim();
  if (!src) return { ok: false, error: "empty expression" };
  if (src.length > 1024) return { ok: false, error: "expression too long" };

  const FUNCS: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    ln: Math.log,
    log: Math.log10,
    log2: Math.log2,
    exp: Math.exp,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    sign: Math.sign,
  };
  const CONSTS: Record<string, number> = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
  };

  // Tokenize.
  type Tok =
    | { t: "num"; v: number }
    | { t: "op"; v: string }
    | { t: "lp" }
    | { t: "rp" }
    | { t: "fn"; v: string };
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) {
        // Allow exponent sign only right after e/E.
        if ((src[j] === "+" || src[j] === "-") && !/[eE]/.test(src[j - 1]))
          break;
        j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num))
        return { ok: false, error: `bad number near "${src.slice(i, j)}"` };
      toks.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const name = src.slice(i, j).toLowerCase();
      if (name in CONSTS) toks.push({ t: "num", v: CONSTS[name] });
      else if (name in FUNCS) toks.push({ t: "fn", v: name });
      else return { ok: false, error: `unknown name "${name}"` };
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rp" });
      i++;
      continue;
    }
    return { ok: false, error: `unexpected character "${c}"` };
  }

  // Shunting-yard → RPN, tracking unary minus.
  const out: Tok[] = [];
  const ops: Tok[] = [];
  const prec: Record<string, number> = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
    "%": 2,
    "u-": 3,
    "^": 4,
  };
  const rightAssoc = (o: string) => o === "^" || o === "u-";
  let prev: Tok | null = null;
  for (const tk of toks) {
    if (tk.t === "num") out.push(tk);
    else if (tk.t === "fn") ops.push(tk);
    else if (tk.t === "op") {
      // Unary minus: a "-" at the start or after another op / "(".
      const unary =
        tk.v === "-" && (prev === null || prev.t === "op" || prev.t === "lp");
      const o: Tok = unary ? { t: "op", v: "u-" } : tk;
      while (
        ops.length &&
        ops[ops.length - 1].t === "op" &&
        (prec[(ops[ops.length - 1] as { v: string }).v] > prec[o.v] ||
          (prec[(ops[ops.length - 1] as { v: string }).v] === prec[o.v] &&
            !rightAssoc(o.v)))
      ) {
        out.push(ops.pop() as Tok);
      }
      ops.push(o);
    } else if (tk.t === "lp") ops.push(tk);
    else if (tk.t === "rp") {
      while (ops.length && ops[ops.length - 1].t !== "lp")
        out.push(ops.pop() as Tok);
      if (!ops.length) return { ok: false, error: "mismatched parentheses" };
      ops.pop(); // discard lp
      if (ops.length && ops[ops.length - 1].t === "fn")
        out.push(ops.pop() as Tok);
    }
    prev = tk;
  }
  while (ops.length) {
    const o = ops.pop() as Tok;
    if (o.t === "lp") return { ok: false, error: "mismatched parentheses" };
    out.push(o);
  }

  // Evaluate RPN.
  const st: number[] = [];
  for (const tk of out) {
    if (tk.t === "num") st.push(tk.v);
    else if (tk.t === "fn") {
      const a = st.pop();
      if (a === undefined) return { ok: false, error: "malformed expression" };
      st.push(FUNCS[tk.v](a));
    } else if (tk.t === "op") {
      if (tk.v === "u-") {
        const a = st.pop();
        if (a === undefined)
          return { ok: false, error: "malformed expression" };
        st.push(-a);
        continue;
      }
      const b = st.pop();
      const a = st.pop();
      if (a === undefined || b === undefined)
        return { ok: false, error: "malformed expression" };
      switch (tk.v) {
        case "+":
          st.push(a + b);
          break;
        case "-":
          st.push(a - b);
          break;
        case "*":
          st.push(a * b);
          break;
        case "/":
          st.push(a / b);
          break;
        case "%":
          st.push(a % b);
          break;
        case "^":
          st.push(Math.pow(a, b));
          break;
        default:
          return { ok: false, error: `bad operator "${tk.v}"` };
      }
    }
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) {
    return { ok: false, error: "could not evaluate expression" };
  }
  return { ok: true, expression: src, result: st[0] };
}

/**
 * Active-shell tracking. The previous design used a module-level singleton,
 * which races when a parent loop and a subagent loop both have a `run_shell`
 * in flight: the second call overwrites the singleton, the first's `finally`
 * sees a non-matching id and skips clearing, and `cancelActiveShell()` then
 * cancels whichever happened to be current rather than the caller's own
 * shell. We key by a stable per-loop identifier instead — the caller's
 * `AbortSignal`. Each agent loop owns its own `signal`, so two concurrent
 * shells from different loops land in different map entries. A WeakMap
 * means we don't leak entries for completed loops whose signals were GC'd.
 */
const activeShellByKey = new WeakMap<object, string>();
// Fallback "key" for callers (older tests, non-loop entry points) that
// don't supply one. Code review H3: the previous module-level singleton
// could collide between concurrent unkeyed callers (e.g. tests spawning
// nested runs); we now hand each caller a synthetic-per-mintActiveShell
// key the first time they call without one, persisted via this Symbol
// keyspace so a cancel from the same caller still finds the entry. The
// Map is bounded — `clear` drops the key on shell completion.
const fallbackKeyMap = new Map<symbol, string>();
const SYNTHETIC_FALLBACK_KEY: unique symbol = Symbol(
  "dispatch.fallbackShellKey",
);
type FallbackKey = typeof SYNTHETIC_FALLBACK_KEY;
function fallbackKeyOrSynthetic(
  key: ShellTrackKey | null | undefined,
): object | FallbackKey {
  return key ?? SYNTHETIC_FALLBACK_KEY;
}

/** Stable key for the active-shell map. Use the AbortSignal when available. */
export type ShellTrackKey = object;

export function setActiveShell(key: ShellTrackKey | null, opId: string): void {
  const k = fallbackKeyOrSynthetic(key);
  if (k === SYNTHETIC_FALLBACK_KEY) {
    fallbackKeyMap.set(SYNTHETIC_FALLBACK_KEY, opId);
  } else {
    activeShellByKey.set(k as object, opId);
  }
}

export function clearActiveShell(
  key: ShellTrackKey | null,
  opId: string,
): void {
  const k = fallbackKeyOrSynthetic(key);
  if (k === SYNTHETIC_FALLBACK_KEY) {
    if (fallbackKeyMap.get(SYNTHETIC_FALLBACK_KEY) === opId) {
      fallbackKeyMap.delete(SYNTHETIC_FALLBACK_KEY);
    }
    return;
  }
  if (activeShellByKey.get(k as object) === opId)
    activeShellByKey.delete(k as object);
}

/**
 * Cancel the active shell associated with `key`. With no key, falls back
 * to the unkeyed entry. Returns true iff a cancel was dispatched.
 */
export function cancelActiveShell(key?: ShellTrackKey | null): boolean {
  let id: string | null = null;
  const k = fallbackKeyOrSynthetic(key);
  if (k === SYNTHETIC_FALLBACK_KEY) {
    id = fallbackKeyMap.get(SYNTHETIC_FALLBACK_KEY) ?? null;
    if (id) fallbackKeyMap.delete(SYNTHETIC_FALLBACK_KEY);
  } else {
    id = activeShellByKey.get(k as object) ?? null;
    if (id) activeShellByKey.delete(k as object);
  }
  if (!id) return false;
  const captured = id;
  api.agentCancelShell(captured).catch((err) =>
    logDiag({
      level: "warn",
      source: "agent-loop",
      message: `cancelActiveShell: agent_cancel_shell failed for opId ${captured}`,
      detail: redactDiagDetail(err),
    }),
  );
  return true;
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

/** Recursively redact secret-looking string values within an args value.
 *  Depth-capped — Code review M3: tool args theoretically come from the
 *  model and can't be cyclic via JSON, but a future caller (an MCP server
 *  result, a non-JSON path) could pass something with cycles or absurd
 *  depth and stack-overflow this fn. 32 levels is well past anything any
 *  legit tool surface produces. */
const REDACT_MAX_DEPTH = 32;
function redactValue(v: unknown, depth = 0): unknown {
  if (depth > REDACT_MAX_DEPTH) return "[REDACTED:depth]";
  if (typeof v === "string") return redactSecrets(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(vv, depth + 1);
    }
    return out;
  }
  return v;
}

export function redactArgsForAudit(
  name: string,
  args: Record<string, unknown>,
): string {
  // Fast-path (audit M12, 2026-05-27): redactValue recursively walks every
  // nested string and tests it against looksLikeSecret. For 99% of audit
  // rows there's no secret-shaped content at all (read_file with /tmp/x,
  // list_dir with ~/foo, etc.), and the recursive walk is pure overhead.
  // Stringify the whole args bag once with looksLikeSecret as the gate;
  // if it doesn't trip the heuristic on the combined blob, skip the deep
  // walk entirely. The blob includes keys + values, so an `api_key`
  // *property name* without a sensitive value still triggers the deep
  // walk — false positives stay safe.
  let stringified: string | null = null;
  try {
    stringified = JSON.stringify(args);
  } catch {
    /* fall through to deep walk; redactValue handles cycles via depth cap */
  }
  const needsDeepWalk = stringified == null || looksLikeSecret(stringified);
  // Secret redaction first — covers command, env, headers, body, and any
  // nested string arg — then bulky-field truncation on top.
  const copy = needsDeepWalk
    ? (redactValue({ ...args }) as Record<string, unknown>)
    : ({ ...args } as Record<string, unknown>);
  const fields = ARG_TRUNCATE_FIELDS[name] ?? [];
  for (const f of fields) {
    const v = copy[f];
    if (typeof v === "string") copy[f] = truncateString(v, 256);
  }
  // multi_edit has an `edits` array with old_string/new_string in each.
  if (name === "multi_edit" && Array.isArray(copy.edits)) {
    copy.edits = (copy.edits as Array<Record<string, unknown>>).map((e) => {
      const out: Record<string, unknown> = { ...e };
      if (typeof out.old_string === "string")
        out.old_string = truncateString(out.old_string, 256);
      if (typeof out.new_string === "string")
        out.new_string = truncateString(out.new_string, 256);
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
  /** Set by the workflow runner when this dispatch happened inside a run.
   * Persisted to the audit row so the workflow UI can show "rows produced
   * by this run" and the per-chat view can hide workflow noise. */
  workflowRunId?: number | null;
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
        workflow_run_id: input.workflowRunId ?? null,
      })
      .catch((e) => {
        // The WKWebView console is not user-accessible; route audit
        // failures through the in-app diagnostic ring buffer so the
        // DiagnosticsPanel surfaces the gap.
        logDiag({
          level: "warn",
          source: "audit",
          message: `agent_audit_record failed for ${input.toolName}`,
          detail: redactDiagDetail(e),
        });
      });
  } catch (e) {
    logDiag({
      level: "warn",
      source: "audit",
      message: `agent_audit_record sync error for ${input.toolName}`,
      detail: redactDiagDetail(e),
    });
  }
}

/* ── Risk classifier hookups for dangerous tools ── */

export async function classifyToolRisk(
  fnName: string,
  args: Record<string, unknown>,
): Promise<Risk> {
  // MCP-provided tools are out-of-process and attacker-influenceable — a
  // malicious or careless server could ship an `mcp__srv__delete_everything`
  // tool. They bypass the built-in DANGEROUS_TOOLS list entirely, so classify
  // every MCP tool as at least `destructive` to force the confirmation gate.
  if (isMcpToolName(fnName)) {
    return "destructive";
  }
  // UX re-review C1: tools in IRREVERSIBLE_TOOLS (delete_path, kill_process,
  // agent_undo) are inherently destructive regardless of arguments. The
  // session-blanket approval branch already excludes them, but bumping risk
  // here also flips the confirmation modal's visual badge from `normal` to
  // `destructive`, which matters for the user-facing UX.
  if (IRREVERSIBLE_TOOLS.has(fnName)) {
    // delete_path with recursive=true is one tier worse than a single-file
    // delete: bound it to `destructive` so the modal shows the loud badge.
    return "destructive";
  }
  // File-write / file-mutation tools default to `normal`, but if the target
  // path falls inside a sensitive system / auto-launch / config location
  // we escalate to `destructive` so the `approveAllWrite` blanket-approve
  // CANNOT silently waive it. This complements the Rust-side path safety
  // checks: even if the FS write would be allowed, the user still sees a
  // loud-badge modal.
  if (
    fnName === "write_file" ||
    fnName === "edit_file" ||
    fnName === "multi_edit" ||
    fnName === "move_path" ||
    fnName === "copy_path" ||
    fnName === "make_dir"
  ) {
    // Collect every plausible path argument. write_file/edit_file/
    // multi_edit/make_dir use `path`. move_path/copy_path use `{from, to}`
    // — both sides matter: the `to` is the place data lands (privilege
    // escalation vector); the `from` is the source (sensitive read /
    // exfiltration). Checking each prevents the model from sliding a
    // copy_path into ~/Library/LaunchAgents/ past the approveAllWrite
    // blanket-approve.
    const candidates: string[] = [];
    if (typeof args.path === "string") candidates.push(args.path);
    if (typeof args.from === "string") candidates.push(args.from);
    if (typeof args.to === "string") candidates.push(args.to);
    // Lexically collapse `/segment/../` so a model can't sidestep the
    // classifier with `/Users/me/../../etc/hosts` → `/etc/hosts`. Rust's
    // canonicalize is the authoritative gate, but if it failed AFTER the
    // user clicked through `approveAllWrite`, the UX promise of the
    // toggle is broken. Keep risk-classification honest at the lexical
    // layer too.
    const normalizePath = (p: string): string => {
      const parts = p.split("/");
      const out: string[] = [];
      for (const seg of parts) {
        if (seg === "..") {
          const top = out.length > 0 ? out[out.length - 1] : undefined;
          if (top === undefined || top === "~") {
            // Above the home fence or an empty buffer — preserve the `..`
            // as a literal so a relative-path call (e.g. `../foo`) stays
            // recognizable.
            out.push(seg);
          } else if (top === "") {
            // Past-root `..` (`/foo/../../etc/...`). On a POSIX filesystem
            // `/..` resolves to `/` itself; absorb the segment instead of
            // pushing it. Without this, `/foo/../../etc/hosts` lexically
            // becomes `/../etc/hosts` and the `startsWith("/etc/")` check
            // misses, letting a sensitive write slip past the risk
            // escalation. Rust's canonicalize would still block the actual
            // write — this keeps `approveAllWrite`'s UX promise honest.
            // Do nothing — `..` is absorbed against the root.
          } else {
            out.pop();
          }
        } else if (seg !== "." || out.length === 0) {
          out.push(seg);
        }
      }
      return out.join("/");
    };
    // Match each candidate path independently. Lexical only — the Rust
    // write layer does the authoritative check. `startsWith` anchors to
    // the path beginning so it isn't tricked by an arbitrary substring.
    const isSensitive = (raw: string): boolean => {
      const lower = normalizePath(raw).toLowerCase();
      return (
        // System dirs
        lower.startsWith("/etc/") ||
        lower.startsWith("/system/") ||
        lower.startsWith("/usr/") ||
        lower.startsWith("/bin/") ||
        lower.startsWith("/sbin/") ||
        lower.startsWith("/private/etc/") ||
        lower.startsWith("/private/var/") ||
        // macOS auto-launch locations — writing a plist here is a
        // privilege-escalation pivot.
        lower.includes("/library/launchagents/") ||
        lower.includes("/library/launchdaemons/") ||
        lower.includes("/library/startupitems/") ||
        // Dotfiles + shell rc — match `/.foo` style so we don't pick up
        // user files like `notes.zshrc.md`.
        /(^|\/)\.(zshrc|bashrc|bash_profile|zprofile|profile|zshenv)$/.test(
          lower,
        ) ||
        /(^|\/)\.ssh\//.test(lower) ||
        /(^|\/)\.aws\//.test(lower) ||
        /(^|\/)\.gnupg\//.test(lower) ||
        // Executable-bound extensions that the user might double-click.
        // The `(\/|$)` boundary catches both the bundle root (`foo.app`)
        // and writes INSIDE the bundle (`foo.app/Contents/Info.plist`)
        // — modifying internals can break Gatekeeper, hijack the
        // executable, or persist arbitrary code through an app launch.
        /\.(command|terminal|workflow|tool|app)(\/|$)/.test(lower)
      );
    };
    if (candidates.some(isSensitive)) {
      return "destructive";
    }
  }
  // CRITICAL: Fail CLOSED. If any classifier RPC throws, we MUST NOT return
  // `"normal"` — a broken classifier combined with `approveAllShell` /
  // `approveAllWrite` would otherwise let a dangerous call slide past
  // confirmation. Returning `"destructive"` forces a fresh user prompt.
  if (fnName === SHELL_TOOL) {
    try {
      return (await api.agentClassifyShell(String(args.command ?? ""))) as Risk;
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message:
          "classifyToolRisk: shell classifier failed — failing closed to destructive",
        detail: redactDiagDetail(err),
      });
      return "destructive";
    }
  } else if (fnName === "applescript_run") {
    try {
      return (await api.agentClassifyApplescript(
        String(args.script ?? ""),
      )) as Risk;
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message:
          "classifyToolRisk: applescript classifier failed — failing closed to destructive",
        detail: redactDiagDetail(err),
      });
      return "destructive";
    }
  } else if (fnName === "http_request") {
    // A request carrying a body can exfiltrate data regardless of method —
    // elevate it so it always needs confirmation and is never swept up by a
    // blanket write-approval (which only covers `normal`-risk writes).
    const hasBody = args.body != null && String(args.body).length > 0;
    if (hasBody) return "privileged";
    try {
      const headers =
        args.headers && typeof args.headers === "object"
          ? (args.headers as Record<string, unknown>)
          : {};
      const hasAuth = Object.keys(headers).some(
        (k) => k.toLowerCase() === "authorization",
      );
      return (await api.agentClassifyHttp(
        String(args.method ?? "GET"),
        hasAuth,
      )) as Risk;
    } catch (err) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message:
          "classifyToolRisk: http classifier failed — failing closed to destructive",
        detail: redactDiagDetail(err),
      });
      return "destructive";
    }
  }
  return "normal";
}

/**
 * Strip secret-looking substrings from a `logDiag` detail value before it
 * lands in the (potentially user-visible) diagnostics ring. Strings are
 * passed through `redactSecrets`; Error instances have their `message`
 * scrubbed; objects are recursively redacted. Non-redactable values are
 * passed through unchanged.
 */
function redactDiagDetail(detail: unknown): unknown {
  if (typeof detail === "string") return redactSecrets(detail);
  if (detail instanceof Error) {
    return { name: detail.name, message: redactSecrets(detail.message) };
  }
  if (detail && typeof detail === "object") {
    return redactValue(detail);
  }
  return detail;
}

export interface ExecuteToolOptions {
  /** When true, side-effectful tools short-circuit and return a dry-run payload. */
  dryRun?: boolean;
  /**
   * Run-scoped abort signal. Tools that can actively cancel their backend
   * work (long-running tools with a backend cancel op) listen to this so a
   * user Stop terminates the in-flight operation instead of waiting out the
   * tool's own timeout. The agent loop also races every tool against this
   * signal (see `abortableToolResult` in runner.ts) so the loop itself stops
   * blocking promptly even for tools without backend cancellation.
   */
  signal?: AbortSignal | null;
  /**
   * Per-loop key used to track active shell op ids so `cancelActiveShell` can
   * target this loop's shell call without races against a sibling loop
   * (parent + subagent). Typically the loop's `AbortSignal`. Absent → falls
   * back to a module-level singleton (legacy behaviour, used by tests).
   */
  shellTrackKey?: ShellTrackKey | null;
  /**
   * Active conversation id, forwarded to tools that need to tag their persisted
   * output back to a chat. `null`/absent = cross-conversation / global scope.
   */
  conversationId?: number | null;
  /**
   * Workspace root for the active run. Forwarded to the memory tools so
   * `remember`/`recall` can scope to the current project. `null`/absent =
   * global scope only.
   */
  workspaceRoot?: string | null;
  /**
   * Parent workflow_runs.id when this dispatch is happening inside a workflow
   * card's agent loop. Threaded into audit-marker rows (skill_invocation_*)
   * so the bracket pair correlates back to the run. Null/absent for
   * interactive chat turns. Audit L-A2 (2026-05-28).
   */
  workflowRunId?: number | null;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  options: ExecuteToolOptions = {},
): Promise<string> {
  // Dry-run mode (sec audit round 3/4): DEFAULT-DENY execution.
  //   1. Tools with a rich preview (diffs, would_run) → structured preview.
  //   2. Explicit read-only tools → fall through and actually execute.
  //   3. EVERYTHING ELSE (writes, deletes, RCE, DB persistence, screenshots,
  //      notifications, all MCP tools, and any unknown/future tool) → suppress.
  // Keying on the read-only ALLOWLIST (not a dangerous-tool denylist) is what
  // makes this safe: previously dry-run only suppressed an 8-tool denylist, so
  // run_code/task_create (full RCE) plus format_code/screenshot/remember/
  // workflow_set/task_cancel executed for real while the UI said
  // "side-effects suppressed". A new side-effectful tool is now suppressed
  // automatically until it is consciously declared read-only.
  if (options.dryRun) {
    if (DRY_RUN_TOOLS.has(name)) {
      return dryRunExecute(name, args);
    }
    if (!DRY_RUN_READ_ONLY.has(name)) {
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_call: name,
        suppressed: true,
      });
    }
    // read-only → continue to the normal dispatch below.
  }
  // NOTE: do NOT redact `args` here. Earlier a live-path redactor ran on
  // `args` before dispatch, but that mutated the values forwarded to Rust IPC —
  // a `grep "api_key=" ./src` shell command became `grep "[REDACTED]" …`,
  // and `write_file` content carrying a config template got its body
  // replaced with `[REDACTED]`. Live secret hygiene belongs on the LOG
  // path: `redactArgsForAudit` runs on the audit-DB row, and `redactDiagDetail`
  // runs on diag warn/error payloads. The args going to execution stay raw.
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
        typeof args.context === "number" ? args.context : undefined,
      );
      return JSON.stringify(r);
    }
    case "read_files": {
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
    }
    case "multi_edit": {
      const edits = Array.isArray(args.edits)
        ? (args.edits as Array<{
            old_string: string;
            new_string: string;
            replace_all?: boolean;
          }>)
        : [];
      const r = await api.agentMultiEdit(String(args.path ?? ""), edits);
      return JSON.stringify(r);
    }
    case "git_status": {
      const r = await api.agentGitStatus(
        args.path ? String(args.path) : undefined,
      );
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
      const r = await api.agentGitBranches(
        args.path ? String(args.path) : undefined,
      );
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
      const r = await api.agentScreenshot(
        args.out_path ? String(args.out_path) : undefined,
      );
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
      await api.agentShowNotification(
        String(args.title ?? ""),
        String(args.body ?? ""),
      );
      return JSON.stringify({ ok: true });
    }
    case "applescript_run": {
      const r = await api.agentApplescriptRun(String(args.script ?? ""));
      return JSON.stringify(r);
    }
    case "http_request": {
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
          typeof args.timeout_secs === "number" ? args.timeout_secs : undefined,
      });
      return JSON.stringify(r);
    }
    case "call_api": {
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
          typeof args.timeout_secs === "number" ? args.timeout_secs : undefined,
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
    }
    case "run_code": {
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
    }
    case "calculate":
      return JSON.stringify(safeCalculate(String(args.expression ?? "")));
    case "remember": {
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
    }
    case "recall_memory": {
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
    }
    case "write_file":
      await api.agentWriteFile(
        String(args.path ?? ""),
        String(args.content ?? ""),
      );
      return JSON.stringify({ ok: true, path: args.path });
    case "write_files": {
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
    }
    case "apply_patch": {
      const patch = String(args.patch ?? "");
      if (!patch.trim()) {
        return JSON.stringify({
          ok: false,
          kind: "bad_args",
          message: "apply_patch requires a non-empty unified-diff `patch` string.",
        });
      }
      const r = await api.agentApplyPatch(patch);
      return JSON.stringify(r);
    }
    case "edit_file": {
      const r = await api.agentEditFile(
        String(args.path ?? ""),
        String(args.old_string ?? ""),
        String(args.new_string ?? ""),
        typeof args.replace_all === "boolean" ? args.replace_all : undefined,
      );
      return JSON.stringify(r);
    }
    case "update_plan": {
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
    // ── Extras: file ops + hash + diff + processes + undo ────────────────
    case "move_path": {
      const r = await api.agentMovePath(
        String(args.from ?? ""),
        String(args.to ?? ""),
        typeof args.overwrite === "boolean" ? args.overwrite : undefined,
      );
      return JSON.stringify({ ok: true, ...r });
    }
    case "copy_path": {
      const r = await api.agentCopyPath(
        String(args.from ?? ""),
        String(args.to ?? ""),
        typeof args.overwrite === "boolean" ? args.overwrite : undefined,
      );
      return JSON.stringify({ ok: true, ...r });
    }
    case "delete_path": {
      const r = await api.agentDeletePath(
        String(args.path ?? ""),
        typeof args.recursive === "boolean" ? args.recursive : undefined,
      );
      return JSON.stringify({ ok: true, ...r });
    }
    case "make_dir": {
      const r = await api.agentMakeDir(String(args.path ?? ""));
      return JSON.stringify({ ok: true, ...r });
    }
    case "hash_file": {
      const algo = args.algorithm === "sha512" ? "sha512" : "sha256";
      const r = await api.agentHashFile(String(args.path ?? ""), algo);
      return JSON.stringify({ ok: true, ...r });
    }
    case "diff_files": {
      const r = await api.agentDiffFiles(
        String(args.left ?? ""),
        String(args.right ?? ""),
      );
      return JSON.stringify({ ok: true, ...r });
    }
    case "list_processes": {
      const r = await api.agentListProcesses(
        typeof args.filter === "string" ? args.filter : undefined,
      );
      return JSON.stringify({ ok: true, rows: r });
    }
    case "kill_process": {
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
    }
    case "agent_undo": {
      try {
        const r = await api.agentUndoLast();
        return JSON.stringify({ ok: true, ...r });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ ok: false, kind: "undo_failed", message });
      }
    }
    case "list_undo": {
      const r = await api.agentListUndo();
      return JSON.stringify({ ok: true, rows: r });
    }
    /* ── Workflow scratchpad + cross-run artifacts (Phase 1.1 + 1.2) ── */
    case "create_flow": {
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
    }
    case "workflow_set": {
      const { setEntry } = await import("../workflow/scratchpad");
      const r = setEntry(String(args.key ?? ""), args.value as never);
      return JSON.stringify(r);
    }
    case "workflow_get": {
      const { getEntry } = await import("../workflow/scratchpad");
      const r = getEntry(String(args.key ?? ""));
      return JSON.stringify(r);
    }
    case "workflow_keys": {
      const { listKeys } = await import("../workflow/scratchpad");
      const r = listKeys();
      return JSON.stringify(r);
    }
    case "workflow_get_prior_run": {
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
    }
    /* ── Procedural memory: workflow_save_skill / workflow_list_skills /
         workflow_get_skill / workflow_invoke_skill / workflow_delete_skill.
         Each is workflow-run-scoped — `not_in_workflow` outside a run. ── */
    case "workflow_save_skill": {
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
    }
    case "workflow_list_skills": {
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
    }
    case "workflow_get_skill": {
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
    }
    case "workflow_delete_skill": {
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
    }
    case "workflow_invoke_skill": {
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
      const { recordSkillInvocation } =
        await import("../workflow/skill-invocations");
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
    }
    // ── Claude Skills (imported Anthropic SKILL.md packages) ────────────
    // Read-only, no-approval. `list_claude_skills` enumerates ENABLED
    // entries only — the chat agent shouldn't see disabled skills at all.
    // `load_claude_skill` fetches the full body for one skill so the
    // model can paste its instructions into context on demand instead of
    // paying the full-body cost on every turn.
    case "list_claude_skills": {
      const rows = await api.claudeSkillList(true);
      return JSON.stringify({
        ok: true,
        skills: rows.map((r) => ({ name: r.name, description: r.description })),
      });
    }
    case "load_claude_skill": {
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
    }
    default:
      return JSON.stringify({
        ok: false,
        kind: "unknown_tool",
        message: `Unknown tool: ${name}`,
      });
  }
}

// ── Read-only tool registry + cache ────────────────────────────────────────
//
// `READ_ONLY_TOOLS` is the set of tool names whose execution has no side
// effects on the workspace or process state. The runner uses it for two
// optimizations:
//
//   1. **Per-run result cache.** Duplicate read-only calls in the same agent
//      run (same name + same args hash) return the cached result instead of
//      re-invoking the IPC. The cache is invalidated as soon as any tool
//      OUTSIDE this set runs successfully — the assumption is that any
//      non-read-only tool may have changed filesystem / process / network
//      state in ways the cached read would miss.
//
//   2. **Parallel execution (wired — opt #1, 2026-06-12).** When an assistant
//      turn issues multiple tool calls AND every one is in this set (minus
//      `load_claude_skill`, which mutates the run's allowlist), the runner
//      prefetches them concurrently with a bounded pool and the serial loop
//      consumes the prefetched results in order — preserving result ordering,
//      caching, stall + audit book-keeping. Mixed batches and cloud routes
//      stay strictly sequential. See `runner.ts` (PARALLEL_READ_CAP).
//
// Anything mutating, anything network-side-effectful, anything that depends
// on real-time state (clipboard, screenshots), or anything that requires
// user approval is EXCLUDED. When in doubt, leave it out — false negatives
// just mean missing an optimization; false positives are correctness bugs.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  // read_files is a batched read — same no-side-effect nature as read_file, so
  // it caches + parallelizes the same way.
  "read_files",
  "list_dir",
  "file_exists",
  "search_files",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branches",
  "hash_file",
  "diff_files",
  "find_definition",
  "find_references",
  // Claude Skills lookup: list + load are pure DB reads against the
  // `claude_skills` table. Per-run caching is safe because importing or
  // toggling a skill happens via the panel (a non-loop UI flow); the
  // first mutating tool call invalidates anyway.
  "list_claude_skills",
  "load_claude_skill",
  // Code re-review H-4: `list_processes` + `list_undo` REMOVED — both
  // reflect real-time state that a non-mutating cache invalidator (file
  // edit, shell command, etc.) doesn't catch. A cached `list_processes`
  // could feed a `kill_process` call against an exited PID — which on
  // macOS may now be a different process. Same shape for `list_undo`
  // when concurrent subagents push onto the global stack.
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}
