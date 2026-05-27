import type { AuditApproval, AuditOutcome, Message, ProjectPolicy, ToolCall } from "../../types";
import type { AgentMetrics, AgentRunOptions, Risk, ToolResult } from "./types";
import { TOOLS } from "./tools";
import {
  DANGEROUS_TOOLS,
  IRREVERSIBLE_TOOLS,
  SHELL_TOOL,
  WRITE_TOOLS,
  classifyToolRisk,
  executeTool,
  formatToolError,
  isReadOnlyTool,
  parseArgs,
  recordAuditSafe,
  toolCallSig,
} from "./dispatch";
import { buildSystemPrompt } from "./system-prompt";
import { applyContextBudget, invalidateMessageTokens } from "./context-manager";
import { streamAgentChat } from "./agent-chat";
import { awaitSubagents, listSubagents, runSubagent, spawnSubagentAsync } from "./subagent";
import { fetchMcpTools, isMcpToolName } from "./mcp-tools";
import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";

/**
 * Policy-driven decision for a dangerous tool call. We can't reach into the
 * Rust matcher from the synchronous gate code, so this mirrors the
 * pattern semantics from `src-tauri/src/policy.rs`. Kept intentionally
 * tiny — anything fancier should live on the Rust side.
 */
type PolicyVerdict = "auto" | "needs-confirm" | "denied";

function matchesPolicyPattern(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    if (!dir) return true;
    if (path === dir) return true;
    if (path.split("/").includes(dir)) return true;
    return path.startsWith(`${dir}/`);
  }
  if (pattern.startsWith("*")) {
    const suffix = pattern.slice(1);
    const base = path.split("/").pop() ?? path;
    return base.endsWith(suffix) || path.endsWith(suffix);
  }
  if (pattern.endsWith("*")) {
    return path.startsWith(pattern.slice(0, -1));
  }
  if (path === pattern) return true;
  const base = path.split("/").pop() ?? path;
  return base === pattern;
}

/**
 * Shell metacharacters that turn a single command into a compound expression
 * the model can use to slip past prefix-based policy auto-approval. If any of
 * these appear in `command`, we refuse to evaluate a prefix at all and force
 * confirmation. Matches the policy intent enforced by `agentRunShell`.
 */
const SHELL_METACHAR_RE = /[;&|<>`]|\$\(/;

function safeShellPrefix(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (SHELL_METACHAR_RE.test(trimmed)) return null;
  // Use a stricter whitespace split: any IFS-class whitespace splits tokens,
  // but the first token is the only thing that can be a prefix. Reject quotes
  // around the first token too — a quoted prefix is a sign the model is
  // trying to obfuscate.
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (!first) return null;
  if (/["'\\]/.test(first)) return null;
  return first;
}

function policyShellVerdict(policy: ProjectPolicy, command: string): PolicyVerdict {
  const prefixes = policy.allowed_shell_prefixes;
  if (!prefixes || prefixes.length === 0) return "needs-confirm";
  const first = safeShellPrefix(command);
  if (!first) return "needs-confirm";
  return prefixes.includes(first) ? "auto" : "needs-confirm";
}

function policyWriteVerdict(policy: ProjectPolicy, path: string): PolicyVerdict {
  if (!path) return "needs-confirm";
  if (policy.denied_write_paths) {
    for (const p of policy.denied_write_paths) {
      if (matchesPolicyPattern(path, p)) return "denied";
    }
  }
  if (policy.allowed_write_paths) {
    for (const p of policy.allowed_write_paths) {
      if (matchesPolicyPattern(path, p)) return "auto";
    }
    return "needs-confirm";
  }
  return "needs-confirm";
}

/**
 * Tools whose risk is severe enough that NO `auto_approve_dangerous_tools`
 * entry may wave them through — they always require an explicit per-call
 * confirmation when the user opts in via the bare-tool-name allowlist. A
 * malicious repo ships its own `.froglips/policy.json`, so the blanket-list
 * form of auto-approve can never be trusted to silently run a shell command
 * or arbitrary AppleScript.
 *
 * NOTE: this set does NOT block the structured `allowed_shell_prefixes`
 * field — that field is documented (`src-tauri/src/policy.rs`) as the
 * intended way for a USER policy to auto-approve a specific shell binary by
 * its first token (`cargo`, `git`, …). Repo-local policies are still
 * blocked from honouring that field via `isRepoLocalPolicy` in
 * `policyDecisionFor` below.
 */
const NEVER_AUTO_APPROVE = new Set([SHELL_TOOL, "applescript_run"]);

/**
 * True when a loaded policy did NOT come from the user's own config — i.e. it
 * was discovered by walking up from the workspace cwd (a repo-local
 * `.froglips/policy.json`). Such a policy is attacker-controllable: just
 * opening a file in a hostile repo activates it. The frontend cannot see the
 * user's home config dir, so we treat *any* policy with a `source_path`
 * containing the `.froglips/` segment as repo-local and refuse to honor its
 * `auto_approve_dangerous_tools`. (A Rust-side change could mark the policy's
 * origin explicitly — see report — but ignoring repo-local auto-approve here
 * is the safe default.)
 */
function isRepoLocalPolicy(policy: ProjectPolicy): boolean {
  // Lowercase comparison so case-variant repo dirs (`.Froglips/`,
  // `.FROGLIPS\`) on case-insensitive filesystems (Windows NTFS, macOS HFS+
  // default, exFAT) still match. The previous case-sensitive match let an
  // attacker-controlled repo dodge the repo-local detection on those FSes
  // and have their `.Froglips/policy.json` auto-approve dangerous tools.
  const sp = (policy.source_path ?? "").toLowerCase();
  return sp.includes("/.froglips/") || sp.includes("\\.froglips\\");
}

/**
 * Consult the active project policy for a tool call. Returns:
 *   - "auto"          → skip the confirmation prompt entirely
 *   - "needs-confirm" → fall through to the existing gate
 *   - "denied"        → reject without executing
 *
 * `risk` is the upstream risk classification for the call. Auto-approval is
 * only ever granted for `normal`-risk tools — a policy can never wave through
 * a `destructive`/`privileged` call.
 *
 * Exported for unit tests; the runner uses it internally.
 */
export function policyDecisionFor(
  policy: ProjectPolicy | null | undefined,
  fnName: string,
  args: Record<string, unknown>,
  risk: Risk = "normal",
): PolicyVerdict {
  if (!policy) return "needs-confirm";
  if (policy.auto_approve_dangerous_tools?.includes(fnName)) {
    // Shell / AppleScript always confirm, regardless of any policy entry.
    if (NEVER_AUTO_APPROVE.has(fnName)) return "needs-confirm";
    // Repo-local policies are attacker-controllable — never honor their
    // auto-approve list. Auto-approve is reserved for user-global policy.
    if (isRepoLocalPolicy(policy)) return "needs-confirm";
    // Only normal-risk tools may be auto-approved.
    if (risk !== "normal") return "needs-confirm";
    return "auto";
  }
  if (fnName === SHELL_TOOL) {
    // `allowed_shell_prefixes` is the documented structured opt-in for a
    // USER-level policy to auto-approve a specific shell binary by its
    // first token. Honour it here — repo-local policies are filtered out
    // above via `isRepoLocalPolicy`, so an auto verdict at this point can
    // only have come from the user's own config.
    if (isRepoLocalPolicy(policy)) {
      const v = policyShellVerdict(policy, String(args.command ?? ""));
      return v === "auto" ? "needs-confirm" : v;
    }
    // User-level policy: honour the prefix allowlist (auto/needs-confirm).
    // safeShellPrefix inside policyShellVerdict already rejects compound
    // commands containing shell metacharacters.
    return policyShellVerdict(policy, String(args.command ?? ""));
  }
  if (WRITE_TOOLS.has(fnName)) {
    // Tools that take a `path` field map directly. For other write tools
    // (git_commit / clipboard_set / applescript_run / http_request) we
    // have no path to evaluate — fall through to the existing prompt.
    const path = typeof args.path === "string" ? args.path : "";
    if (!path) return "needs-confirm";
    return policyWriteVerdict(policy, path);
  }
  return "needs-confirm";
}

const MAX_ITERATIONS = 40;

/**
 * `approveAllWrite` is a UX shortcut for "I trust this run to produce
 * files without a modal per write". It covers ONLY actual filesystem
 * writes — not other WRITE_TOOLS entries that happen to share the bucket.
 * `http_request`, `clipboard_set`, `applescript_run`, `git_commit` ride a
 * different risk profile; the user's mental model when they tick
 * "Auto-approve file writes" does NOT include them.
 */
const APPROVE_ALL_WRITE_FS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "make_dir",
  "move_path",
  "copy_path",
]);

/** Reasons valid on a deny-path `ConfirmDecision`. Anything else is normalised
 * to `"user_deny"` for both the model-facing message body and the audit row. */
const VALID_DENY_REASONS = new Set(["user_deny", "aborted", "unattended_denied"]);

/** Per-reason text shown to the model in the rejection body. */
const DENY_MESSAGE_BY_REASON: Record<string, string> = {
  user_deny: "User denied this tool call.",
  aborted: "Run was aborted before this tool call could complete.",
  unattended_denied:
    "Tool call denied by the default unattended gate. " +
    "Enable the card's `unattended` flag and ensure the tool name is in the card's allowlist.",
};
// Stall detection: if agent reads the same path > this many times in
// monotonically-advancing tiny chunks, abort the loop with an explanatory msg.
const STALL_SAME_PATH_LIMIT = 6;
// Consecutive-error budget: after this many tool results in a row come back
// `ok:false` (even with differing args — the dedupe window only catches
// IDENTICAL calls), inject a stop-and-report hint so a permission wall or
// broken tool can't burn the whole iteration budget. A success resets it.
const MAX_CONSECUTIVE_TOOL_ERRORS = 5;

function makeTmpKey() {
  return `tmp:${crypto.randomUUID()}`;
}

/* ── Main loop ── */

/**
 * Best-effort: persist a session-level metrics row when `runAgentLoop` exits.
 * Failure paths (db locked / disk full / IPC unavailable in tests) must never
 * affect the agent run — caller voids the returned promise.
 */
function recordSessionMetricsSafe(conversationId: number, metrics: AgentMetrics): void {
  try {
    void api
      .agentSessionMetricsRecord({
        ts: Date.now(),
        conversation_id: String(conversationId),
        iterations: metrics.iterations,
        tool_calls: metrics.toolCalls,
        total_tool_ms: Math.max(0, Math.round(metrics.totalToolMs)),
        total_llm_ms: Math.max(0, Math.round(metrics.totalLlmMs)),
        prompt_tokens: metrics.promptTokens,
        completion_tokens: metrics.completionTokens,
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[session-metrics] record failed:", e);
      });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[session-metrics] record sync error:", e);
  }
}

/**
 * Build a JSON body for a rejected/short-circuited tool call. Mirrors the
 * `{ok:false, kind, message}` protocol every tool result already uses.
 */
function rejectionBody(kind: string, message: string): string {
  return JSON.stringify({ ok: false, kind, message } satisfies ToolResult);
}

interface PushToolResultOpts {
  /** Audit approval classification for the call. */
  approval: AuditApproval;
  /** Audit outcome classification. */
  outcome: AuditOutcome;
  /** Optional audit error-kind tag. */
  errorKind?: string | null;
  /** Tool-call arguments to record in the audit row (default `{}`). */
  args?: Record<string, unknown>;
  /** Tool wall-clock duration in ms (default 0 for short-circuited calls). */
  durationMs?: number;
}

/**
 * Push a `tool` message for `tc` carrying `body`, record the matching audit
 * row, and fire `onUpdate`. This is the single shared tail every per-tool-call
 * branch (allowlist-deny, bad-args, stall-guard, policy-deny, user-deny,
 * duplicate, and the normal execution path) funnels through.
 */
function pushToolResult(
  msgs: Message[],
  conversationId: number,
  onUpdate: (msgs: Message[]) => void,
  tc: ToolCall,
  body: string,
  o: PushToolResultOpts,
  workflowRunId: number | null = null,
): void {
  const fnName = tc.function?.name ?? "";
  msgs.push({
    _tmpKey: makeTmpKey(),
    conversation_id: conversationId,
    role: "tool",
    content: body,
    tool_call_id: tc.id,
    tool_name: fnName,
  });
  recordAuditSafe({
    toolName: fnName,
    args: o.args ?? {},
    resultBody: body,
    durationMs: o.durationMs ?? 0,
    approval: o.approval,
    outcome: o.outcome,
    errorKind: o.errorKind ?? null,
    conversationId,
    workflowRunId,
  });
  onUpdate([...msgs]);
}

/** Multiset (sig → count) for a single turn. */
function sigMultiset(sigs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sigs) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
}

/**
 * True when THIS turn's tool calls are an exact multiset match against the
 * IMMEDIATELY-PRIOR turn's tool calls. Previously this was an
 * order-insensitive subset check over the whole dedupe window, which would
 * fire on perfectly normal interleavings (e.g. read_file(A) on turn N,
 * read_file(B) on turn N+1, read_file(A) on turn N+2 — last turn flagged as a
 * dup even though A had legitimate intervening progress). Comparing per-turn
 * multisets restricts the rejection to "the model just made the same set of
 * calls again, in any order, with the same arity".
 */
function isDuplicateTurn(currentSigs: string[], prevSigs: string[] | null): boolean {
  if (!prevSigs || prevSigs.length === 0) return false;
  if (currentSigs.length !== prevSigs.length) return false;
  const cur = sigMultiset(currentSigs);
  const prev = sigMultiset(prevSigs);
  if (cur.size !== prev.size) return false;
  for (const [k, v] of cur) {
    if (prev.get(k) !== v) return false;
  }
  return true;
}

/**
 * Stall predicate for `read_file`: bumps the per-path read counter and
 * reports whether the agent has exceeded the chunk-thrashing limit.
 */
function isReadFileStalling(
  fnName: string,
  args: Record<string, unknown>,
  readCounts: Map<string, number>,
): { stalling: boolean; path: string; count: number } {
  if (fnName !== "read_file") return { stalling: false, path: "", count: 0 };
  const path = String(args.path ?? "");
  const count = (readCounts.get(path) ?? 0) + 1;
  readCounts.set(path, count);
  return { stalling: count > STALL_SAME_PATH_LIMIT, path, count };
}

export async function runAgentLoop(opts: AgentRunOptions): Promise<string | null> {
  const {
    onUpdate, onStatusChange, onMetrics, onAssistantDelta, requestConfirmation, signal,
    workspaceRoot, systemPromptOverride,
    toolAllowlist = [], approveAllShell, approveAllWrite,
    approvedShellPrefixes = [], onApproveShellPrefix,
    dryRun = false,
  } = opts;
  const msgs: Message[] = [...opts.messages];

  // Project policy: either explicitly supplied (tests / subagents) or loaded
  // lazily from the workspace cwd. Failures are swallowed so a missing
  // policy file is indistinguishable from "no policy" → existing behaviour.
  let projectPolicy: ProjectPolicy | null | undefined = opts.projectPolicy;
  if (projectPolicy === undefined) {
    if (workspaceRoot) {
      try {
        projectPolicy = await api.policyLoad(workspaceRoot);
      } catch {
        projectPolicy = null;
      }
    } else {
      projectPolicy = null;
    }
  }

  // A repo-supplied `.froglips/policy.json` is attacker-controllable: opening
  // a file in a hostile repo activates it. Surface a visible warning so the
  // user knows a repo policy is in effect; its auto-approve entries are
  // ignored downstream in policyDecisionFor.
  if (projectPolicy && isRepoLocalPolicy(projectPolicy)) {
    const hasAutoApprove = (projectPolicy.auto_approve_dangerous_tools?.length ?? 0) > 0;
    logDiag({
      level: "warn",
      source: "agent-policy",
      message:
        `A repo-supplied policy is in effect (${projectPolicy.source_path ?? "unknown path"}). ` +
        (hasAutoApprove
          ? "Its auto-approve list is being IGNORED — repo-local policies cannot auto-approve dangerous tools."
          : "Repo-local policies cannot auto-approve dangerous tools."),
      detail: { source_path: projectPolicy.source_path ?? null },
    });
  }

  const metrics: AgentMetrics = {
    iterations: 0,
    toolCalls: 0,
    totalToolMs: 0,
    totalLlmMs: 0,
    retries: 0,
    promptTokens: 0,
    completionTokens: 0,
    toolStats: {},
  };
  /** Maturity review P1 #23: increment per-tool stats after each call. */
  const recordToolStat = (name: string, ms: number, ok: boolean): void => {
    if (!metrics.toolStats) metrics.toolStats = {};
    const slot = metrics.toolStats[name] ?? { count: 0, totalMs: 0, errors: 0 };
    slot.count += 1;
    slot.totalMs += Math.max(0, ms);
    if (!ok) slot.errors += 1;
    metrics.toolStats[name] = slot;
  };
  // Signatures of the immediately-prior turn's tool calls. Per-turn multiset
  // comparison (see `isDuplicateTurn`) restricts dedupe to "the model just
  // repeated last turn", which is the case worth aborting on — a
  // window-wide subset check produced false positives.
  let prevTurnSigs: string[] | null = null;
  // Per-path read counter — guards against agents chunking the same file
  // into dozens of tiny reads and blowing the iteration budget.
  const readCounts = new Map<string, number>();
  // Consecutive tool-failure counter — bumped on every `ok:false` result,
  // reset on the first success. Once it crosses MAX_CONSECUTIVE_TOOL_ERRORS
  // the loop injects a stop-and-report hint.
  let consecutiveToolErrors = 0;
  let stopAndReportHintPending = false;
  // Per-run cache for read-only tool results. Keyed by
  // `${name}::${stableArgsHash}`. Invalidated whenever any mutating tool
  // (anything NOT in READ_ONLY_TOOLS from dispatch.ts) succeeds — at that
  // point the cached read may no longer reflect disk state. See dispatch.ts
  // for the registry definition.
  //
  // Code review H1: bounded at READ_ONLY_CACHE_CAP entries with FIFO
  // eviction so a long-running loop that reads many distinct files can't
  // grow the map unboundedly. JS Map preserves insertion order, so we
  // delete the oldest key (the first one) when at cap.
  const READ_ONLY_CACHE_CAP = 256;
  const readOnlyCache = new Map<string, string>();
  const cacheKey = (name: string, args: Record<string, unknown>): string => {
    // Stable JSON.stringify with sorted keys so {a:1,b:2} and {b:2,a:1}
    // produce identical keys. JSON.stringify by itself preserves insertion
    // order, which is not stable across model providers' arg serialization.
    const keys = Object.keys(args).sort();
    const norm: Record<string, unknown> = {};
    for (const k of keys) norm[k] = args[k];
    return `${name}::${JSON.stringify(norm)}`;
  };
  const cacheStore = (key: string, value: string) => {
    // Code re-review M-3: skip eviction when overwriting an existing
    // entry. Without this guard, hitting the cap with a re-set drops a
    // different unrelated entry while just updating the present key.
    if (!readOnlyCache.has(key) && readOnlyCache.size >= READ_ONLY_CACHE_CAP) {
      const oldest = readOnlyCache.keys().next().value;
      if (oldest !== undefined) readOnlyCache.delete(oldest);
    }
    readOnlyCache.set(key, value);
  };

  onStatusChange("thinking");

  // Discover MCP-provided tools once per run. Failures are swallowed inside
  // fetchMcpTools so the loop never blocks on a broken server.
  const mcpTools = await fetchMcpTools();

  // System prompt built after MCP discovery so the "Available tools" section
  // can name MCP tools — the model is otherwise never told they exist.
  const sysMsg: Message = {
    conversation_id: opts.conversationId,
    role: "system",
    content: buildSystemPrompt(workspaceRoot, toolAllowlist, systemPromptOverride, mcpTools),
  };
  msgs.unshift(sysMsg);

  // Wrap the rest of the run in a try/finally so the session-metrics row is
  // written exactly once regardless of how we exit (completion, abort,
  // exception, or iteration-cap).
  let _sessionMetricsRecorded = false;
  const recordMetricsOnce = () => {
    if (_sessionMetricsRecorded) return;
    _sessionMetricsRecorded = true;
    recordSessionMetricsSafe(opts.conversationId, metrics);
  };

  // Filter tool defs by allowlist. The allowlist applies to both built-in
  // and MCP tools — if a user-set allowlist is in effect, MCP tool names
  // (`mcp__server__tool`) must appear explicitly to be exposed.
  const allTools = [
    ...TOOLS,
    ...mcpTools,
  ] as unknown as typeof TOOLS;
  // Maturity review P0 #5: precompute allowlist Set once. The original
  // `.filter(... .includes(...))` was O(n×m) and ran every agent iteration
  // when re-deriving the tool list. The allowlist is run-scoped + immutable
  // so the Set hoists fine.
  const allowlistSet = toolAllowlist.length ? new Set(toolAllowlist) : null;
  const tools = allowlistSet
    ? allTools.filter((t) => allowlistSet.has(t.function.name))
    : allTools;

  // Track "research without writing" so we can nudge the model when it
  // spins on web_search/web_fetch and never delivers the file the user
  // asked for. The set below is intentionally narrow: only the pure
  // read-only research tools count toward the budget. The threshold is
  // intentionally generous — a real research task may need 8+ searches
  // — but past that we inject one synthetic system reminder, AND just
  // before the iteration cap we inject a stronger one.
  const RESEARCH_NUDGE_THRESHOLD = 10;
  // External-only research surface. Filesystem inspection (read_file,
  // list_dir, search_files) is intentionally NOT counted — a Coder
  // agent doing focused codebase exploration is doing exactly what it
  // should be, and nudging it to write before it understands the
  // problem is counterproductive.
  const RESEARCH_TOOLS = new Set([
    "web_search",
    "web_fetch",
    "read_pdf",
  ]);
  // Nudge fires when the card has SOME way to commit the deliverable.
  // edit_file and multi_edit count too — a Coder-style card may prefer
  // edit_file over write_file, but it still needs to land its work on
  // disk eventually.
  const canWriteFile =
    !toolAllowlist.length
    || toolAllowlist.includes("write_file")
    || toolAllowlist.includes("edit_file")
    || toolAllowlist.includes("multi_edit");
  // Narrow RESEARCH_TOOLS to *external* research so local read_file /
  // list_dir / search_files don't trip the nudge for Coder agents that
  // legitimately read many files before issuing the first edit. Pure
  // codebase exploration without web access never fires the nudge.
  let researchCallCount = 0;
  let writeCallCount = 0;
  let researchNudgeFired = false;

  try {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) return null;
    metrics.iterations = i + 1;

    const llmStart = performance.now();
    // Streaming placeholder: pushed into msgs so consumers see in-flight text.
    // After the stream resolves we either (a) leave it as the final reply, or
    // (b) annotate it with tool_calls and proceed to dispatch.
    const streamingKey = makeTmpKey();
    const streamingMsg: Message = {
      _tmpKey: streamingKey,
      conversation_id: opts.conversationId,
      role: "assistant",
      content: "",
    };
    msgs.push(streamingMsg);
    let streamPushed = true;

    // Budget the SENT copy against the model's context window. Operates on a
    // copy — the persisted/displayed `msgs` array is never mutated. Keeps the
    // system prompt (first message) intact; truncates oversized tool results
    // and collapses old turns when the array would overflow the window.
    const budgeted = applyContextBudget(
      msgs.filter((m) => m._tmpKey !== streamingKey),
      { model: opts.model, contextTokens: opts.contextTokens },
    );
    if (budgeted.trimmed) {
      logDiag({
        level: "info",
        source: "agent-context",
        message:
          `Context budget applied: ${budgeted.estimatedBefore} → ` +
          `${budgeted.estimatedAfter} est. tokens (budget ${budgeted.budget})`,
        detail: {
          toolResultsTruncated: budgeted.toolResultsTruncated,
          turnsCollapsed: budgeted.turnsCollapsed,
        },
      });
    }

    let result: { content: string; tool_calls: ToolCall[]; prompt_eval_count?: number; eval_count?: number };
    // Stream-delta coalescing (audit H5 + H6, 2026-05-27).
    // - H5: every delta previously did `onUpdate([...msgs])` — full-array
    //   spread per chunk. A 200-token reply with 50 deltas = 50 full
    //   array allocations + 50 React reconcile rounds.
    // - H6: `streamingMsg.content += delta` is O(n²) under the hood for
    //   long replies. Buffer deltas into a string[] and `.join("")` lazily.
    // Strategy: append delta to a buffer + bump a dirty flag; a 16ms
    // timer (one webview frame) flushes the buffer into content and
    // calls onUpdate once. Final flush is synchronous on stream
    // resolve/error/abort so the persisted msgs always reflect the
    // final content.
    const deltaBuf: string[] = [];
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStream = () => {
      if (coalesceTimer != null) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      if (deltaBuf.length === 0) return;
      streamingMsg.content += deltaBuf.join("");
      deltaBuf.length = 0;
      // Mutated `content` in place — invalidate cached token estimate
      // (audit H4 contract: in-place mutation requires explicit drop).
      invalidateMessageTokens(streamingMsg);
      onUpdate([...msgs]);
    };
    const scheduleFlush = () => {
      if (coalesceTimer != null) return;
      coalesceTimer = setTimeout(flushStream, 16);
    };
    try {
      result = await streamAgentChat(
        opts,
        budgeted.messages,
        tools,
        signal,
        (delta) => {
          deltaBuf.push(delta);
          // onAssistantDelta is for raw stream consumers (DiagnosticsPanel,
          // workflow card output stream); they want every delta, not the
          // coalesced flush. Forward immediately.
          onAssistantDelta?.(delta);
          scheduleFlush();
        },
        () => {
          // Retry fired — bump the counter and reset the placeholder so the
          // bubble doesn't duplicate text from the half-streamed attempt.
          metrics.retries++;
          if (coalesceTimer != null) {
            clearTimeout(coalesceTimer);
            coalesceTimer = null;
          }
          deltaBuf.length = 0;
          streamingMsg.content = "";
          invalidateMessageTokens(streamingMsg);
        },
      );
      // Final synchronous flush so the placeholder carries the full reply
      // before downstream code reads `streamingMsg.content`.
      flushStream();
    } catch (e) {
      // Drop any pending coalesce timer before unwinding the error path.
      if (coalesceTimer != null) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      deltaBuf.length = 0;
      // Drop the streaming placeholder so error paths don't leak a stub bubble.
      if (streamPushed) {
        const idx = msgs.findIndex((m) => m._tmpKey === streamingKey);
        if (idx !== -1) msgs.splice(idx, 1);
        streamPushed = false;
      }
      if (signal.aborted) return null;
      throw e;
    }
    metrics.totalLlmMs += performance.now() - llmStart;
    const promptTok = result.prompt_eval_count;
    const evalTok = result.eval_count;
    if (typeof promptTok === "number") metrics.promptTokens += promptTok;
    if (typeof evalTok === "number") metrics.completionTokens += evalTok;
    onMetrics?.({ ...metrics });

    // Cloud-routing Ollama models (kimi-k2.6:cloud, deepseek-v4-pro:cloud, …)
    // have been observed to reject the next request with the cryptic
    // "Value looks like object, but can't find closing '}' symbol" 400
    // when an assistant turn carries multiple parallel tool_calls. Force
    // serial execution on those routes: keep only the first tool_call,
    // and the model will re-issue any remaining intent on the next turn
    // (the prompt loop is unchanged — agent loops are designed to handle
    // one-tool-per-turn flows transparently). Local Ollama + MLX + native
    // backends keep full parallel tool-call support.
    let toolCalls = result.tool_calls;
    let droppedParallelCount = 0;
    if (
      typeof opts.model === "string" &&
      opts.model.endsWith(":cloud") &&
      toolCalls.length > 1
    ) {
      droppedParallelCount = toolCalls.length - 1;
      toolCalls = [toolCalls[0]];
    }
    const preludeText = result.content;
    // Pop the streaming placeholder; the loop below re-pushes the canonical
    // message (final reply OR assistant-with-tool-calls) using makeTmpKey.
    if (streamPushed) {
      const idx = msgs.findIndex((m) => m._tmpKey === streamingKey);
      if (idx !== -1) msgs.splice(idx, 1);
      streamPushed = false;
    }

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
    if (isDuplicateTurn(sigs, prevTurnSigs)) {
      msgs.push({
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "assistant",
        content: preludeText,
        tool_calls: toolCalls,
      });
      const dupBody = rejectionBody(
        "duplicate_call",
        "You just called this exact tool with these exact arguments. Try a different approach or report what you've learned to the user.",
      );
      for (const tc of toolCalls) {
        const dupParsed = parseArgs(tc.function?.arguments);
        pushToolResult(msgs, opts.conversationId, onUpdate, tc, dupBody, {
          approval: "auto",
          outcome: "duplicate",
          errorKind: "duplicate_call",
          args: dupParsed.ok ? dupParsed.args : {},
        }, opts.workflowRunId ?? null);
      }
      // Update prev-turn sigs even on a dup so two-back→one-back→now also fires.
      prevTurnSigs = sigs;
      continue;
    }
    // Snapshot this turn's tool-call signatures for next iteration's compare.
    prevTurnSigs = sigs;

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

      // Allowlist gate — uses the precomputed Set (P0 #5).
      if (allowlistSet && !allowlistSet.has(fnName)) {
        const naParsed = parseArgs(tc.function?.arguments);
        pushToolResult(msgs, opts.conversationId, onUpdate, tc,
          rejectionBody("tool_not_allowed", `Tool '${fnName}' is not enabled for this conversation.`),
          {
            approval: "denied",
            outcome: "denied",
            errorKind: "tool_not_allowed",
            args: naParsed.ok ? naParsed.args : {},
          }, opts.workflowRunId ?? null);
        continue;
      }

      const parsed = parseArgs(tc.function?.arguments);
      if (!parsed.ok) {
        pushToolResult(msgs, opts.conversationId, onUpdate, tc,
          rejectionBody("bad_arguments", parsed.err),
          { approval: "auto", outcome: "error", errorKind: "bad_arguments" },
          opts.workflowRunId ?? null);
        continue;
      }
      const args = parsed.args;

      // Stall guard: if the agent keeps re-reading the same file in chunks,
      // bail out with a hint instead of letting it eat the iteration budget.
      const stall = isReadFileStalling(fnName, args, readCounts);
      if (stall.stalling) {
        pushToolResult(msgs, opts.conversationId, onUpdate, tc,
          rejectionBody(
            "stall_guard",
            `read_file has been called ${stall.count} times for '${stall.path}'. Stop chunking — call read_file ONCE without 'limit' to read up to 65536 bytes, then continue only if total_bytes > 65536. If you have enough context, answer the user now.`,
          ),
          { approval: "auto", outcome: "stall_guard", errorKind: "stall_guard", args },
          opts.workflowRunId ?? null);
        continue;
      }

      // Track which approval branch authorised this call — used in the
      // audit row so we can later distinguish auto/session/user approvals.
      let auditApproval: AuditApproval = "auto";

      // Confirmation gate for dangerous tools. MCP-provided tools are
      // out-of-process and not in the built-in DANGEROUS_TOOLS list, so they
      // are gated explicitly here — classifyToolRisk returns a non-normal
      // risk for them, and a careless/malicious MCP tool must never auto-run.
      if (DANGEROUS_TOOLS.has(fnName) || isMcpToolName(fnName)) {
        const risk = await classifyToolRisk(fnName, args);

        // Policy wins over session approval state. A loaded policy can
        // either auto-approve (skip confirmation) or deny outright. Risk is
        // passed so a policy can never auto-approve a non-normal-risk call.
        const policyVerdict = policyDecisionFor(projectPolicy, fnName, args, risk);
        if (policyVerdict === "denied") {
          pushToolResult(msgs, opts.conversationId, onUpdate, tc,
            rejectionBody(
              "policy_denied",
              `Tool call denied by project policy${projectPolicy?.source_path ? ` (${projectPolicy.source_path})` : ""}.`,
            ),
            { approval: "denied", outcome: "denied", errorKind: "policy_denied", args },
            opts.workflowRunId ?? null);
          continue;
        }

        const cmd = String(args.command ?? "");
        // safeShellPrefix returns null if the command contains shell
        // metacharacters (`;`, `&`, `|`, `>`, `<`, backtick, `$(`) — that
        // makes prefix-based session approval ineligible, forcing the
        // confirmation prompt.
        const firstWord = safeShellPrefix(cmd) ?? "";
        const prefixApproved =
          fnName === SHELL_TOOL &&
          risk === "normal" &&
          firstWord !== "" &&
          approvedShellPrefixes.includes(firstWord);
        // UX re-review C1 (2026-05-24): tools in IRREVERSIBLE_TOOLS NEVER
        // ride the session-blanket-approve branch. delete_path,
        // kill_process, agent_undo all permanently change state in ways
        // the user can't recover from with another agent call.
        const isIrreversible = IRREVERSIBLE_TOOLS.has(fnName);
        const sessionApproved =
          !isIrreversible &&
          (policyVerdict === "auto" ||
            prefixApproved ||
            (fnName === SHELL_TOOL && approveAllShell && risk === "normal") ||
            // Blanket write-approval only covers normal-risk *filesystem*
            // writes — an elevated call (sensitive-path-classified write,
            // http_request, etc.) always needs explicit confirmation.
            (APPROVE_ALL_WRITE_FS.has(fnName) && approveAllWrite && risk === "normal"));
        if (sessionApproved) {
          auditApproval = "session_allowed";
        }
        if (!sessionApproved) {
          const decision = await requestConfirmation(fnName, args, risk);
          if (!decision.approve) {
            // Three deny paths the audit log must distinguish:
            //   - human clicked Deny       → reason: "user_deny"
            //   - run was cancelled        → reason: "aborted"
            //   - default deny-all fired   → reason: "unattended_denied"
            // Anything outside the allowed set (including a stray
            // "user_allow" that callers must never produce on a deny
            // path) is normalised to "user_deny" so the audit row +
            // tool body stay coherent.
            const rawReason = decision.reason ?? "user_deny";
            const auditReason = VALID_DENY_REASONS.has(rawReason) ? rawReason : "user_deny";
            // Model-facing `kind`: collapse to a single learnable error
            // class ("permission_denied"). Models trained on standard
            // permission errors recognise this; the internal taxonomy
            // (user_deny / aborted / unattended_denied) lives ONLY in
            // the audit row so post-hoc reviewers retain full fidelity.
            pushToolResult(msgs, opts.conversationId, onUpdate, tc,
              rejectionBody(
                "permission_denied",
                DENY_MESSAGE_BY_REASON[auditReason] ?? DENY_MESSAGE_BY_REASON.user_deny,
              ),
              { approval: "denied", outcome: "denied", errorKind: auditReason, args },
              opts.workflowRunId ?? null);
            continue;
          }
          auditApproval = "user_allowed";
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
      let toolErrorKind: string | null = null;
      try {
        if (fnName === "spawn_subagent") {
          const mode = typeof args.mode === "string" ? args.mode : "sync";
          if (mode === "async") {
            result = await spawnSubagentAsync(args, opts);
          } else {
            result = await runSubagent(args, opts);
          }
        } else if (fnName === "await_subagents") {
          const ids = Array.isArray(args.subagent_ids)
            ? (args.subagent_ids as unknown[]).map((v) => String(v))
            : [];
          // Clamp the model-supplied timeout: floor 0, ceiling 10 min, so a
          // bogus huge value can't wedge the loop indefinitely. Coerce via
          // Number() so a stringified "30" (which the previous typeof check
          // silently rejected, falling back to 600s) is honored. Non-finite
          // / NaN inputs collapse to the 600s default rather than 0 (a 0s
          // timeout would fire immediately and orphan the subagents).
          const AWAIT_TIMEOUT_CAP_MS = 600_000;
          const coerced = Number(args.timeout_seconds ?? 600);
          const rawTimeoutSecs = Number.isFinite(coerced) ? coerced : 600;
          const timeoutMs = Math.min(AWAIT_TIMEOUT_CAP_MS, Math.max(0, rawTimeoutSecs) * 1000);
          result = await awaitSubagents(ids, timeoutMs);
        } else if (fnName === "list_subagents") {
          result = listSubagents();
        } else {
          // Read-only cache short-circuit: if the model just called the same
          // read-only tool with the same args (e.g. read_file the same path
          // twice across two iterations), return the cached payload instead
          // of round-tripping IPC. The cache is invalidated below whenever a
          // non-read-only tool succeeds.
          const isCacheable = isReadOnlyTool(fnName);
          const ckey = isCacheable ? cacheKey(fnName, args) : null;
          if (ckey != null && readOnlyCache.has(ckey)) {
            result = readOnlyCache.get(ckey)!;
          } else {
            // `shellTrackKey: signal` keys this loop's active-shell entry
            // by its AbortSignal. Sibling loops (parent + subagent) get
            // distinct signals and therefore distinct map entries, so a
            // `run_shell` in one loop can't be overwritten or cancelled by
            // the other.
            result = await executeTool(fnName, args, {
              dryRun,
              shellTrackKey: signal,
              // Surfaced for tools that tag their output to a conversation
              // (currently `generate_image`). The runner already carries
              // the active conversation id in opts; pass it down
              // unmodified.
              conversationId: opts.conversationId,
            });
            if (ckey != null) {
              // Only cache responses that don't look like errors — caching
              // a transient `{ok:false}` would mask a retry.
              let cacheable = true;
              try {
                const r = JSON.parse(result) as { ok?: boolean } | null;
                if (r && r.ok === false) cacheable = false;
              } catch {
                /* non-JSON read result — cache it */
              }
              if (cacheable) cacheStore(ckey, result);
            }
          }
        }
      } catch (e) {
        result = formatToolError(e);
        toolErrorKind = "tool_error";
      }
      const durationMs = performance.now() - toolStart;
      metrics.totalToolMs += durationMs;
      metrics.toolCalls++;
      // P1 #23: per-tool breakdown. ok flag flipped from toolErrorKind
      // since it isn't computed until a few lines below — but a tool
      // that *threw* always sets toolErrorKind in the catch block above,
      // so checking it here is correct for the catch path. For the
      // success branch we'll record ok=true; the post-parse outcome
      // re-classification below (which may flip a returned-but-failed
      // result to "error") is recorded against errorKind in the audit
      // log, not in metrics.
      recordToolStat(fnName, durationMs, !toolErrorKind);
      onMetrics?.({ ...metrics });

      // Determine final outcome by sniffing the result body — many tool
      // wrappers return `{ok:false, kind:...}` rather than throwing. The tool
      // protocol is JSON-over-string, so parse into a `ToolResult` shape
      // rather than `any`.
      let outcome: AuditOutcome = toolErrorKind ? "error" : "ok";
      if (!toolErrorKind) {
        try {
          const parsedResult = JSON.parse(result) as Partial<ToolResult> | null;
          if (parsedResult && typeof parsedResult === "object") {
            // Dry-run results take precedence — they're recorded as `dry_run`
            // regardless of `ok` status so the suppressed call shows up
            // distinctly in the audit log.
            if (parsedResult.dry_run === true) {
              outcome = "dry_run";
              if (parsedResult.ok === false && typeof parsedResult.blocked_by_safety === "string") {
                toolErrorKind = "blocked_by_safety";
              } else if (parsedResult.ok === false && typeof parsedResult.kind === "string") {
                toolErrorKind = parsedResult.kind;
              }
            } else if (parsedResult.ok === false) {
              outcome = "error";
              if (typeof parsedResult.kind === "string") {
                toolErrorKind = parsedResult.kind;
              }
            }
          }
        } catch {
          /* result not JSON — leave outcome=ok */
        }
      }

      pushToolResult(msgs, opts.conversationId, onUpdate, tc, result, {
        approval: auditApproval,
        outcome,
        errorKind: toolErrorKind,
        args,
        durationMs,
      }, opts.workflowRunId ?? null);

      // Track research-vs-write balance so the post-turn block below can
      // inject a "stop researching, write the file" nudge before the
      // iteration budget is exhausted. `outcome` of `error` is not
      // counted — only successful research calls accumulate. (Denied
      // calls short-circuited earlier via `continue` and never reach
      // this point in the loop.)
      if (outcome !== "error") {
        if (RESEARCH_TOOLS.has(fnName)) researchCallCount++;
        if (fnName === "write_file" || fnName === "edit_file" || fnName === "multi_edit") {
          writeCallCount++;
        }
      }

      // Consecutive-error budget: a real failure (error outcome) bumps the
      // counter; any non-error outcome resets it. Dry-run results count as
      // successes — they're a deliberate suppression, not a failure.
      if (outcome === "error") {
        consecutiveToolErrors++;
        if (consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
          stopAndReportHintPending = true;
        }
      } else {
        consecutiveToolErrors = 0;
      }

      // Invalidate the read-only cache whenever a non-read-only tool ran
      // successfully — any cached read for the affected file/dir/process
      // table could now be stale. Conservative: nuke the whole map rather
      // than try to dependency-track by path.
      if (outcome !== "error" && !isReadOnlyTool(fnName)) {
        readOnlyCache.clear();
      }
    }

    // Surface dropped parallel tool_calls (cloud-route truncation) as a
    // synthetic system reminder for the NEXT turn. Pushed AFTER the tool
    // result(s) so the assistant↔tool message pairing stays adjacent —
    // some cloud gateways (Ollama `*:cloud`) re-validate body shape and
    // reject any system message interleaved between an assistant tool_calls
    // turn and its tool result. The model sees this reminder when it
    // composes its NEXT response, prompting it to reissue the dropped
    // calls instead of assuming they ran.
    if (droppedParallelCount > 0) {
      msgs.push({
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "system",
        content:
          `[agent-loop] Cloud-route only executes ONE tool call per turn. ` +
          `${droppedParallelCount} additional tool call(s) you issued in the previous turn were dropped — ` +
          `reissue any that still matter on your next turn.`,
      });
      onUpdate([...msgs]);
      // No explicit reset — `droppedParallelCount` is a per-iteration
      // `let` declared at the top of the for-body and re-initialises
      // to 0 each turn.
    }

    // After a run of consecutive tool failures, inject a system hint so the
    // model stops retrying and reports the blocker to the user. This is an
    // additional guard layered on top of the dedupe / stall / MAX_ITERATIONS
    // logic — the dedupe window only catches IDENTICAL repeated calls.
    let stopAndReportInjectedThisIter = false;
    if (stopAndReportHintPending) {
      stopAndReportHintPending = false;
      consecutiveToolErrors = 0;
      stopAndReportInjectedThisIter = true;
      msgs.push({
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "system",
        content:
          `[agent-loop] ${MAX_CONSECUTIVE_TOOL_ERRORS} tool calls in a row failed. ` +
          "Stop retrying tools. Report to the user what you were trying to do, " +
          "what failed, and the error messages — then ask how to proceed.",
      });
      onUpdate([...msgs]);
    }

    // Research-budget nudge: if the agent has done a lot of read-only
    // research without producing a file (despite write_file being in
    // its allowlist), inject a one-time strong reminder. Many models —
    // kimi-k2.6:cloud in particular — happily spin on web_search and
    // never get around to the write step the user asked for. This nudge
    // breaks the loop. Fires once per run.
    //
    // Skip the nudge on a turn where the stop-and-report hint already
    // fired — the two messages give conflicting instructions ("stop
    // retrying, report the blocker" vs "stop researching, write the
    // file") and the model gets muddled. Stop-and-report wins because
    // it indicates the runner is in a failure mode, not just spinning.
    if (
      !researchNudgeFired &&
      !stopAndReportInjectedThisIter &&
      canWriteFile &&
      writeCallCount === 0 &&
      researchCallCount >= RESEARCH_NUDGE_THRESHOLD
    ) {
      researchNudgeFired = true;
      msgs.push({
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "system",
        content:
          `[agent-loop] You have already made ${researchCallCount} research calls without committing a file. ` +
          "STOP RESEARCHING. On your next turn, call `write_file` (or `edit_file` / `multi_edit` for existing " +
          "files) with the deliverable using the information you already have. The user is waiting for the " +
          "file — not more research. " +
          `Remaining turn budget: ${MAX_ITERATIONS - (i + 1)}.`,
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
  } finally {
    recordMetricsOnce();
  }
}
