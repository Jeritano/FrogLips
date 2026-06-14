import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";
import type { AuditApproval, AuditOutcome, ToolCall } from "../../types";
import type { Risk } from "./types";
import { dispatchMcpTool, isMcpToolName } from "./mcp-tools";
import { looksLikeSecret } from "../memory-client";
import { DRY_RUN_READ_ONLY, DRY_RUN_TOOLS, dryRunExecute } from "./dry-run";
import { REGISTRY_BY_NAME, TOOL_REGISTRY } from "./tool-registry";
import { lazyDerivedSet } from "./lazy-set";
import securityManifest from "../../../src-tauri/security-manifest.json";

// Re-exported for tests that import it from `./dispatch`.
export { dryRunValidateUrl } from "./url-safety";
// `safeCalculate` (the `calculate` tool's shunting-yard evaluator) now lives in
// its own module; re-export so existing importers (`tool-registry.ts`, tests)
// keep resolving it from `./dispatch`.
export { safeCalculate } from "./tool-handlers/calculator";

// ── Classifier Sets — DERIVED from TOOL_REGISTRY ────────────────────────────
//
// These Sets ARE the danger gate. Their membership used to be hand-maintained
// literals here; they are now derived from the per-tool descriptor flags in
// `tool-registry.ts` (the single source of truth). The `registry-consistency`
// test pins each derived Set against the original frozen literals, so a wrong
// flag in the registry fails CI rather than silently changing the gate.
//
//   • DANGEROUS_TOOLS  ← descriptor.dangerous     (confirmation-modal gate)
//   • WRITE_TOOLS      ← descriptor.writeTool      (blanket-write eligible)
//   • IRREVERSIBLE_TOOLS ← descriptor.irreversible (never blanket-approve)
//
// The rationale comments for each membership live in tool-registry.ts beside
// the descriptor flag they justify.

/**
 * Tools whose execution shows a confirmation modal. Membership is the ONLY
 * thing that surfaces the modal — the Rust side binds the token, but the
 * renderer mints it inline, so a tool missing here runs unconfirmed.
 */
export const DANGEROUS_TOOLS = lazyDerivedSet(() =>
  TOOL_REGISTRY.filter((d) => d.dangerous).map((d) => d.name),
);
export const SHELL_TOOL = "run_shell";

/**
 * Write-class tools eligible for blanket session approval ("Approve all
 * writes this session"). Excludes the IRREVERSIBLE_TOOLS (delete/kill/undo)
 * even though they mutate — those always require a fresh confirmation.
 */
export const WRITE_TOOLS = lazyDerivedSet(() =>
  TOOL_REGISTRY.filter((d) => d.writeTool).map((d) => d.name),
);

/**
 * Tools that are NEVER eligible for blanket session approval — every call
 * always requires an explicit user confirmation, even when "Approve all
 * writes this session" or "Approve all shell this session" is on. The
 * common theme: the operation is either irreversible (delete, kill,
 * undo-of-undo) or its blast radius is too easy to misestimate from a
 * single JSON-blob preview.
 */
export const IRREVERSIBLE_TOOLS = lazyDerivedSet(() =>
  TOOL_REGISTRY.filter((d) => d.irreversible).map((d) => d.name),
);

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

/**
 * Lowercased protected-path tokens from the SINGLE security manifest, used by
 * `isSensitive` to escalate the write-confirmation badge. UX-only (the Rust
 * path gates are authoritative), but sourcing the credential/home/system set
 * from the manifest means this badge can't fall behind the real gate. We keep
 * EVERY manifest entry — read- or write-flagged — since any of them landing a
 * write deserves the loud badge.
 *
 *   • homeTokens  — `$HOME`-relative subpaths, matched component-wise as
 *     `(^|/)<tok>(/|$)` against the normalized path.
 *   • absoluteTokens — literal absolute prefixes, matched with `startsWith`.
 */
const MANIFEST_HOME_TOKENS: readonly string[] =
  securityManifest.protectedPaths.homeRelative.map((e) =>
    e.path.toLowerCase(),
  );
const MANIFEST_ABSOLUTE_TOKENS: readonly string[] =
  securityManifest.protectedPaths.absolute.map(
    (e) => `${e.path.toLowerCase()}/`,
  );

/** True when `lower` (already normalized + lowercased) falls under a manifest
 *  protected path. Component-anchored for home tokens so `~/.sshfoo` does not
 *  match `~/.ssh`; the `escapeRe` keeps regex metachars (`.`) literal. */
function matchesManifestProtected(lower: string): boolean {
  for (const tok of MANIFEST_ABSOLUTE_TOKENS) {
    if (lower.startsWith(tok)) return true;
  }
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const tok of MANIFEST_HOME_TOKENS) {
    if (new RegExp(`(^|/)${escapeRe(tok)}(/|$)`).test(lower)) return true;
  }
  return false;
}

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
      const base = lower.split("/").pop() ?? lower;
      const cb = securityManifest.credentialBasenames;
      return (
        // Manifest-sourced credential / home / system protected paths — the
        // SAME set the Rust path gate enforces, so this badge can't lag behind
        // it. Covers ~/.ssh, ~/.aws, ~/.gnupg, gh/gcloud, browser profiles,
        // Keychains, /etc, /System, LaunchAgents, Froglips' own store, etc.
        matchesManifestProtected(lower) ||
        // Credential-style basenames anywhere (`.env*`, `credentials[.json]`).
        cb.prefixes.some((p) => base.startsWith(p)) ||
        cb.exact.includes(base) ||
        // ── UX-only extras with NO Rust gate (kept verbatim) ──
        // System dirs not in the manifest's path list.
        lower.startsWith("/usr/") ||
        lower.startsWith("/bin/") ||
        lower.startsWith("/sbin/") ||
        lower.startsWith("/private/var/") ||
        // macOS auto-launch / startup locations.
        lower.includes("/library/startupitems/") ||
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
  } else if (fnName === "run_code") {
    // Audit A24: run_code with language bash/sh/shell re-enters a full shell —
    // identical RCE surface to run_shell — but used to skip the shell risk
    // classifier, so a destructive `rm -rf /` snippet showed only the generic
    // dangerous badge. Route shell-language code through the SAME classifier so
    // the destructive/privileged badge fires identically. Other languages keep
    // the default dangerous risk (already gated + sandboxed temp-file run).
    const lang = String(args.language ?? "").toLowerCase();
    if (lang === "bash" || lang === "sh" || lang === "shell") {
      try {
        return (await api.agentClassifyShell(String(args.code ?? ""))) as Risk;
      } catch (err) {
        logDiag({
          level: "warn",
          source: "agent-loop",
          message:
            "classifyToolRisk: run_code shell classifier failed — failing closed to destructive",
          detail: redactDiagDetail(err),
        });
        return "destructive";
      }
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

/**
 * Exported alias for `redactDiagDetail` so the registry's verbatim handler
 * bodies (moved out of the old executeTool switch) keep the same diagnostic
 * redaction behaviour. The original is module-private by design — this is the
 * single sanctioned re-export for the tool-registry split.
 */
export function redactDiagDetailForRegistry(detail: unknown): unknown {
  return redactDiagDetail(detail);
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
  // Registry-driven dispatch. The per-tool arm bodies live VERBATIM in each
  // descriptor's `handler.run` (tool-registry.ts). Tools with handler.kind ===
  // "runner-special" (spawn_subagent / await_subagents / list_subagents) are
  // handled in runner.ts BEFORE executeTool is reached; if one ever falls
  // through to here, treat it exactly like an unknown tool (the prior switch
  // had no case for them — they hit `default`).
  const descriptor = REGISTRY_BY_NAME.get(name);
  if (
    !descriptor ||
    descriptor.handler.kind === "runner-special" ||
    !descriptor.handler.run
  ) {
    return JSON.stringify({
      ok: false,
      kind: "unknown_tool",
      message: `Unknown tool: ${name}`,
    });
  }
  return descriptor.handler.run(args, options);
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
//
// DERIVED from `descriptor.cacheableRead` — set EXPLICITLY per tool in
// tool-registry.ts (NOT inferred from sideEffect). The notable exclusions
// (list_processes / list_undo / recall_memory / search_project_knowledge are
// reads but NON-cacheable: they reflect real-time state a cache invalidator
// wouldn't catch) carry their rationale on the descriptor flag. Pinned by the
// registry-consistency test against the original literal.
export const READ_ONLY_TOOLS: ReadonlySet<string> = lazyDerivedSet(() =>
  TOOL_REGISTRY.filter((d) => d.cacheableRead).map((d) => d.name),
);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}
