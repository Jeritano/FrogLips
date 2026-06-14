import type {
  AuditApproval,
  AuditOutcome,
  Message,
  ProjectPolicy,
  ToolCall,
} from "../../types";
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
import { classifyToolFitness } from "../model-capabilities";
import { applyContextBudget } from "./context-manager";
import { streamAgentChat } from "./agent-chat";
import {
  awaitSubagents,
  listSubagents,
  runSubagent,
  spawnSubagentAsync,
} from "./subagent";
import { fetchMcpTools, isMcpToolName } from "./mcp-tools";
import {
  isDuplicateTurn,
  isToolStalling,
  looksLikeActionPreamble,
  makeTmpKey,
  rejectionBody,
  runWithConcurrency,
} from "./runner-helpers";
import { api, type CheckpointTurn } from "../tauri-api";
import { logDiag } from "../diagnostics";

/**
 * Map the runner's in-memory message array to durable checkpoint turns (item
 * 4A). System and user turns are excluded — only the agent's own assistant +
 * tool-result turns form the run's recoverable state. `turn_index` is the
 * position within the EMITTED turn sequence (stable across re-checkpoints of the
 * same run, since the runner only ever appends to `msgs`). Assistant turns that
 * carried tool_calls preserve them by JSON-encoding the structured calls into
 * `content` so a future recovery pass can reconstruct the turn; their
 * human-readable prelude is kept too.
 */
function checkpointTurnsFrom(msgs: Message[]): CheckpointTurn[] {
  const turns: CheckpointTurn[] = [];
  let turnIndex = 0;
  for (const m of msgs) {
    if (m.role !== "assistant" && m.role !== "tool") continue;
    let content = m.content ?? "";
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      // Encode the structured calls alongside the prelude so the shadow record
      // is lossless. Recovery (deferred) parses this back; the normal view never
      // sees checkpoint rows (run_id IS NOT NULL filtered out in list_messages).
      content = JSON.stringify({
        content: m.content ?? "",
        tool_calls: m.tool_calls,
      });
    }
    turns.push({
      turn_index: turnIndex++,
      role: m.role,
      content,
      tool_call_id: m.tool_call_id ?? null,
      tool_name: m.tool_name ?? null,
      model: m.model ?? null,
    });
  }
  return turns;
}

/**
 * Stub-prompt header inserted into the system context when at least one
 * non-pinned Claude Skill is enabled. The translation glossary is the
 * core payload: Anthropic SKILL.md packages reference upstream tool
 * names (Read, Write, Bash, …) that don't exist in Froglips's dispatch
 * table, so we tell the model what to call instead.
 *
 * Kept as a module-level constant rather than computed-per-run so the
 * test suite can assert against a stable string and the prompt cache
 * upstream sees a steady prefix across turns.
 */
const CLAUDE_SKILLS_STUB_HEADER =
  "You have access to imported Claude Skills. Each is a markdown instruction set the user has imported into Froglips.\n\n" +
  "Tool-name translation (Anthropic tool names → Froglips tool names that exist in your current allowlist):\n" +
  "  Read → read_file\n" +
  "  Write → write_file\n" +
  "  Edit → edit_file\n" +
  "  MultiEdit → multi_edit\n" +
  "  Bash → run_shell\n" +
  "  Glob → search_files (use glob arg)\n" +
  "  Grep → search_files (use pattern arg)\n" +
  "  WebFetch → web_fetch\n" +
  "  WebSearch → web_search\n" +
  "  TodoWrite → workflow_set (not a perfect mapping; use scratchpad)\n\n" +
  "When a skill body references one of the above Anthropic tool names, call the Froglips equivalent instead.";

/**
 * Inject Claude Skills context into `msgs` immediately after the main
 * system prompt (index 1) and before any user / assistant content.
 *
 * Layout produced (top → bottom):
 *   [0] main system prompt   (already unshifted by caller)
 *   [1] stub catalog        (when non-pinned enabled skills exist)
 *   [2..] pinned-body system messages, one per pinned skill, in enabled-
 *         list order
 *   [next] pre-existing user/assistant history
 *
 * Rationale: the stub is a catalog the model reaches for via
 * load_claude_skill; pinned bodies are authoritative reference text the
 * user has explicitly elevated. Keeping pinned bodies immediately above
 * the conversation history (and the eventual user-profile injection)
 * makes them feel like the most-recent system context the model should
 * obey, while still living BELOW any user-profile injection appended
 * later.
 *
 * IPC failures are non-fatal — we log a diag and return. The runner
 * continues without skill context rather than crashing the chat.
 */
async function injectClaudeSkillsContext(
  msgs: Message[],
  conversationId: number,
): Promise<void> {
  let enabled: Awaited<ReturnType<typeof api.claudeSkillList>>;
  try {
    enabled = await api.claudeSkillList(true);
  } catch (e) {
    logDiag({
      level: "warn",
      source: "claude-skills",
      message:
        "claude_skill_list failed at chat start — continuing without skill context",
      detail: { error: e instanceof Error ? e.message : String(e) },
    });
    return;
  }
  if (!enabled || enabled.length === 0) return;

  const pinned = enabled.filter((s) => s.pinned);
  const nonPinned = enabled.filter((s) => !s.pinned);

  // Insert position: directly after the main system prompt that the
  // caller just unshifted. Using `splice` instead of `unshift` keeps the
  // main sysMsg at index 0 (where downstream context-budget logic
  // expects the canonical system rules) and slots the skill context
  // between rules and user history.
  let insertAt = 1;

  // Stub first so pinned-body messages slot above it (closer to user
  // history). Pinned reference text reads more authoritatively when
  // adjacent to the turn the model is answering.
  if (nonPinned.length > 0) {
    const bullets = nonPinned
      .map((s) => `  - ${s.name}: ${s.description}`)
      .join("\n");
    const stub =
      `${CLAUDE_SKILLS_STUB_HEADER}\n\n` +
      `Available skills:\n${bullets}\n\n` +
      "Call list_claude_skills() to refresh this list, load_claude_skill(name) to read the full instructions on demand.";
    msgs.splice(insertAt, 0, {
      conversation_id: conversationId,
      role: "system",
      content: stub,
    });
    insertAt += 1;
  }

  // Pinned-skill bodies — one combined system message with per-skill
  // separators. Keeping it to a single message bounds the system-prompt
  // count for downstream context-budget tracking. A `get` failure for
  // one skill skips that skill but still emits the others.
  if (pinned.length > 0) {
    const parts: string[] = [];
    for (const s of pinned) {
      try {
        const row = await api.claudeSkillGet(s.name);
        if (!row || !row.enabled) continue;
        parts.push(`\n\n--- Claude Skill: ${row.name} ---\n${row.body_md}`);
      } catch (e) {
        logDiag({
          level: "warn",
          source: "claude-skills",
          message: `claude_skill_get failed for pinned skill "${s.name}"`,
          detail: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
    if (parts.length > 0) {
      msgs.splice(insertAt, 0, {
        conversation_id: conversationId,
        role: "system",
        content: parts.join("").trimStart(),
      });
    }
  }
}

/**
 * Policy-driven decision for a dangerous tool call. We can't reach into the
 * Rust matcher from the synchronous gate code, so this mirrors the
 * pattern semantics from `src-tauri/src/policy.rs`. Kept intentionally
 * tiny — anything fancier should live on the Rust side.
 */
type PolicyVerdict = "auto" | "needs-confirm" | "denied";

export function matchesPolicyPattern(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;
  // Sec audit round 3/4: case-fold both sides. macOS APFS is case-insensitive,
  // so a user policy rule `secrets/` / `.env` / `*.key` must also match
  // `Secrets/` / `.ENV` / `evil.KEY`. ASCII-ONLY fold to stay byte-identical to
  // the Rust twin policy.rs matches_pattern (`to_ascii_lowercase`) — full
  // Unicode `toLowerCase()` would diverge on non-ASCII and (for allow-rules)
  // match more than Rust. Keep both in sync.
  const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  path = asciiLower(path);
  pattern = asciiLower(pattern);
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
// S5: include newline + carriage return. A command like `git status\nrm -rf ~`
// has first token `git` and (without the newline class) no metachar match, so
// it could ride a `git`-prefix session auto-approval while smuggling a second
// command on the next line. Treating any newline as a separator forces the
// confirmation prompt, same as `;`/`&&`/`|`.
const SHELL_METACHAR_RE = /[;&|<>`\n\r]|\$\(/;

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

function policyShellVerdict(
  policy: ProjectPolicy,
  command: string,
): PolicyVerdict {
  const prefixes = policy.allowed_shell_prefixes;
  if (!prefixes || prefixes.length === 0) return "needs-confirm";
  const first = safeShellPrefix(command);
  if (!first) return "needs-confirm";
  return prefixes.includes(first) ? "auto" : "needs-confirm";
}

function policyWriteVerdict(
  policy: ProjectPolicy,
  path: string,
): PolicyVerdict {
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

// Default agent turn budget. Raised 40 → 80 (2026-06-12): a whole-app build
// (e.g. scaffolding a multi-file frontend) routinely needs more than 40 tool
// turns and was stalling mid-task. Overridable per-run via
// `AgentRunOptions.maxIterations` (wired from the agent setting), clamped to a
// sane range so a typo can't spin forever.
const DEFAULT_MAX_ITERATIONS = 80;
const MIN_MAX_ITERATIONS = 5;
const MAX_MAX_ITERATIONS = 400;

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
  // write_files is a multi-file write — same nature as write_file, so the
  // "auto-approve file writes this run" blanket covers it too (2026-06-12).
  "write_files",
  // apply_patch creates/edits files from a unified diff — same filesystem-write
  // nature, so the same blanket covers it (2026-06-12).
  "apply_patch",
  "edit_file",
  "multi_edit",
  "make_dir",
  "move_path",
  "copy_path",
  // format_code rewrites file content in place — same nature as edit_file, so a
  // user who ticked "auto-approve file writes" reasonably expects it covered.
  // (It still escalates to a prompt on a sensitive-path / non-normal risk.)
  "format_code",
]);

/** Reasons valid on a deny-path `ConfirmDecision`. Anything else is normalised
 * to `"user_deny"` for both the model-facing message body and the audit row. */
const VALID_DENY_REASONS = new Set([
  "user_deny",
  "aborted",
  "unattended_denied",
]);

/** Per-reason text shown to the model in the rejection body. */
const DENY_MESSAGE_BY_REASON: Record<string, string> = {
  user_deny: "User denied this tool call.",
  aborted: "Run was aborted before this tool call could complete.",
  unattended_denied:
    "Tool call denied by the default unattended gate. " +
    "Enable the card's `unattended` flag and ensure the tool name is in the card's allowlist.",
};
// How many prior turns the dedupe guard compares against. >1 so an A/B/A/B
// oscillation (which a one-turn-back check never catches) trips the guard.
const DEDUPE_HISTORY = 3;
// How many times an agent run will nudge a model that returns a "let me fix X:"
// preamble with ZERO tool calls (and zero tools all run) before accepting the
// text as final. Bounded so a model that genuinely can't act still exits.
const MAX_NARRATION_NUDGES = 2;

// Max read-only tool calls executed concurrently in one turn's prefetch
// (opt #1). Bounded so a turn that issues many reads doesn't slam the IPC
// bridge / disk with unlimited parallelism.
const PARALLEL_READ_CAP = 6;
// Consecutive-error budget: after this many tool results in a row come back
// `ok:false` (even with differing args — the dedupe window only catches
// IDENTICAL calls), inject a stop-and-report hint so a permission wall or
// broken tool can't burn the whole iteration budget. A success resets it.
const MAX_CONSECUTIVE_TOOL_ERRORS = 5;

// Checkpoint coalescing (item 4A perf fix). The durable checkpoint
// (`onCheckpoint`) re-serialises ALL accumulated turns and the Rust side does a
// full DELETE+re-INSERT under the global write lock, so firing it once PER
// iteration is O(N²) JSON.stringify + O(N²) row writes + O(N²) IPC bytes across
// a long run. Coalesce instead: fire at most once every CHECKPOINT_MIN_TURNS new
// turns OR once CHECKPOINT_MIN_INTERVAL_MS has elapsed since the last flush,
// whichever comes first. The final state is always flushed when the loop exits
// (completion, abort, exception, or iteration cap) so no settled work is lost.
const CHECKPOINT_MIN_TURNS = 4;
const CHECKPOINT_MIN_INTERVAL_MS = 4000;

/* ── Main loop ── */

/**
 * Best-effort: persist a session-level metrics row when `runAgentLoop` exits.
 * Failure paths (db locked / disk full / IPC unavailable in tests) must never
 * affect the agent run — caller voids the returned promise.
 */
function recordSessionMetricsSafe(
  conversationId: number,
  metrics: AgentMetrics,
): void {
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
        logDiag({
          level: "warn",
          source: "session-metrics",
          message: "record failed",
          detail: e,
        });
      });
  } catch (e) {
    logDiag({
      level: "warn",
      source: "session-metrics",
      message: "record sync error",
      detail: e,
    });
  }
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
  /**
   * Perf: when true, skip the per-call `onUpdate([...msgs])` fan-out. Used by
   * tight loops that push many results in one pass (duplicate-turn, abort-pair)
   * so they can coalesce into a SINGLE `onUpdate` after the loop instead of one
   * O(n) array clone per call. The audit row and `msgs` push still happen.
   */
  skipUpdate?: boolean;
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
  if (!o.skipUpdate) onUpdate([...msgs]);
}

/**
 * Enforce the OpenAI tool-call/result pairing invariant on a message array:
 * every assistant `tool_calls` id must have a matching `role:"tool"` result.
 * Drops any assistant `tool_calls` turn that isn't fully paired (keeping its
 * text as a plain assistant message so context isn't lost) and any orphan tool
 * result whose call was dropped/absent. A healthy history is returned
 * unchanged. Round 6 (2026-05-30).
 */
export function stripUnpairedToolCalls(messages: Message[]): Message[] {
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) resultIds.add(m.tool_call_id);
  }
  const keptCallIds = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const ids = m.tool_calls.map((tc) => tc.id);
      if (ids.every((id) => resultIds.has(id))) {
        ids.forEach((id) => keptCallIds.add(id));
        out.push(m);
      } else if (m.content && m.content.trim()) {
        // Keep any assistant prose, drop the unpaired tool_calls.
        out.push({ ...m, tool_calls: undefined });
      }
      // else: pure orphan tool_calls turn → drop entirely.
    } else if (m.role === "tool") {
      if (m.tool_call_id && keptCallIds.has(m.tool_call_id)) out.push(m);
      // else: orphan result whose call was dropped/absent → drop.
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Tool result returned to the loop when a Stop cancels an in-flight tool. */
const ABORTED_TOOL_RESULT = JSON.stringify({
  ok: false,
  kind: "aborted",
  message:
    "Tool cancelled by the user (Stop). The underlying operation may still be finishing in the background.",
});

/**
 * C1 (2026-06-01): race a tool execution against the run's abort signal. The
 * loop only checked `signal.aborted` *between* tool calls, so a Stop during a
 * long in-flight tool (http_request, web_fetch, browser_*) was ignored
 * until that tool's own timeout elapsed. This wrapper resolves immediately
 * with an aborted result on Stop so the loop stops blocking; the real promise
 * is left to settle in the background with its rejection swallowed. Tools that
 * support active backend cancellation additionally terminate their op via
 * `opts.signal`. A normal rejection is re-thrown unchanged so the caller's
 * existing try/catch error handling is preserved.
 */
function abortableToolResult(
  p: Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.resolve(ABORTED_TOOL_RESULT);
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(ABORTED_TOOL_RESULT);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (r) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
    // If we resolve early via abort, the real promise may still reject later —
    // swallow it so it doesn't surface as an unhandled rejection.
    p.catch(() => {});
  });
}

export async function runAgentLoop(
  opts: AgentRunOptions,
): Promise<string | null> {
  const {
    onUpdate,
    onStatusChange,
    onMetrics,
    onCheckpoint,
    onAssistantDelta,
    onStreamReset,
    requestConfirmation,
    signal,
    workspaceRoot,
    systemPromptOverride,
    toolAllowlist = [],
    approveAllShell,
    approveAllWrite,
    approvedShellPrefixes = [],
    onApproveShellPrefix,
    dryRun = false,
  } = opts;
  // Root-cause guard for tool-call/result pairing: drop any incoming
  // assistant `tool_calls` turn whose ids aren't ALL paired by `tool` results,
  // and any orphan `tool` result. An aborted run (Stop mid-tool, or mid-
  // confirmation) can leave such an orphan in the React message list; on the
  // next same-conversation send it would reach the backend verbatim and 400
  // ("tool_call_id not found"). Sanitizing the runner input closes every such
  // path regardless of how the orphan got there. Round 6 (2026-05-30).
  const msgs: Message[] = stripUnpairedToolCalls([...opts.messages]);

  // Project policy: either explicitly supplied (tests / subagents) or loaded
  // lazily from the workspace cwd. `api.policyLoad` returns null for BOTH "no
  // policy file" and "file present but unreadable/invalid" — but the Rust side
  // (policy::load_for_cwd) routes the invalid/untrusted/unowned cases through
  // the diagnostics warn log, so a malformed *deny* policy is surfaced there.
  // The one remaining silent path is a transient IPC failure of the command
  // itself: previously swallowed, which made "policy silently failed to load"
  // look identical to "no policy was ever set". Log it so a vanished deny rule
  // is visible. We still proceed with no policy (rather than hard-failing the
  // run) because policyLoad rarely throws and the common case is genuinely no
  // policy — but the operator now has a breadcrumb.
  let projectPolicy: ProjectPolicy | null | undefined = opts.projectPolicy;
  if (projectPolicy === undefined) {
    if (workspaceRoot) {
      try {
        projectPolicy = await api.policyLoad(workspaceRoot);
      } catch (e) {
        projectPolicy = null;
        logDiag({
          level: "warn",
          source: "policy",
          message:
            `policy load failed for ${workspaceRoot} — proceeding with NO project policy ` +
            `(any deny rules are NOT in effect this run)`,
          detail: { error: e instanceof Error ? e.message : String(e) },
        });
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
    const hasAutoApprove =
      (projectPolicy.auto_approve_dangerous_tools?.length ?? 0) > 0;
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
  // Ring buffer of the last DEDUPE_HISTORY turns' tool-call signatures. Per-turn
  // multiset comparison (see `isDuplicateTurn`) flags "the model repeated a
  // recent turn's exact set of calls" — including an A/B/A/B oscillation, which
  // a one-turn-back check missed. Kept short so legitimate re-reads with real
  // intervening progress are not false-positived.
  const prevTurnSigsHistory: string[][] = [];
  const pushTurnSigs = (sigs: string[]): void => {
    prevTurnSigsHistory.push(sigs);
    if (prevTurnSigsHistory.length > DEDUPE_HISTORY)
      prevTurnSigsHistory.shift();
  };
  // Per-path read counter — guards against agents chunking the same file
  // into dozens of tiny reads and blowing the iteration budget.
  const readCounts = new Map<string, number>();
  // Consecutive tool-failure counter — bumped on every `ok:false` result,
  // reset on the first success. Once it crosses MAX_CONSECUTIVE_TOOL_ERRORS
  // the loop injects a stop-and-report hint.
  let consecutiveToolErrors = 0;
  // Turn-level non-progress counter (audit A09): the per-call consecutiveToolErrors
  // only counts calls that EXECUTED and errored — a turn where every call was
  // DENIED/blocked (allowlist, permission, policy, stall, duplicate) short-
  // circuits before that counter and used to burn the whole iteration budget.
  // This bumps on any turn that issued tool calls but landed zero successes,
  // resets on a turn with ≥1 success, and trips the same stop-and-report hint.
  let nonProgressTurns = 0;
  const MAX_NONPROGRESS_TURNS = 4;
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

  // Checkpoint coalescing state (item 4A perf fix). `checkpointedTurns` is the
  // turn count persisted at the last flush; `lastCheckpointAt` is its wall-clock
  // time. `flushCheckpoint` fires `onCheckpoint` with the full current turn set
  // (the Rust side still does a full rewrite — append-only is a deferred Rust
  // change, see report) but only when enough new turns / time have accumulated,
  // or when `force` is set (loop exit). This caps the per-iteration full-rewrite
  // that made the path O(N²).
  let checkpointedTurns = 0;
  // Seed from run start so the interval throttle is measured from the run
  // beginning, not the epoch — otherwise the first sub-CHECKPOINT_MIN_TURNS
  // iteration would always read a huge `elapsed` and flush eagerly.
  let lastCheckpointAt = performance.now();
  // Cheap O(n) count of the agent turns the next checkpoint WOULD emit — used to
  // evaluate the throttle WITHOUT paying the full `checkpointTurnsFrom`
  // serialize (which JSON.stringify's every tool-call turn). We only serialize
  // when we actually flush.
  const countAgentTurns = (): number => {
    let n = 0;
    for (const m of msgs) if (m.role === "assistant" || m.role === "tool") n++;
    return n;
  };
  const flushCheckpoint = (force: boolean): void => {
    if (!onCheckpoint) return;
    const turnCount = countAgentTurns();
    // Nothing new since the last flush — skip the redundant full-rewrite IPC.
    // Also skips the degenerate "never checkpointed, still zero turns" case so a
    // run that produced no agent turns doesn't fire an empty checkpoint.
    if (turnCount === checkpointedTurns) return;
    if (!force) {
      const newTurns = turnCount - checkpointedTurns;
      const elapsed = performance.now() - lastCheckpointAt;
      if (newTurns < CHECKPOINT_MIN_TURNS && elapsed < CHECKPOINT_MIN_INTERVAL_MS)
        return;
    }
    onCheckpoint(checkpointTurnsFrom(msgs));
    checkpointedTurns = turnCount;
    lastCheckpointAt = performance.now();
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
    content: buildSystemPrompt(
      workspaceRoot,
      toolAllowlist,
      systemPromptOverride,
      mcpTools,
      opts.modelFitness ?? classifyToolFitness(opts.model),
      opts.savedApiNames ?? [],
    ),
  };
  msgs.unshift(sysMsg);

  // ── Claude Skills injection ────────────────────────────────────────────
  // If the user has imported any Anthropic-format SKILL.md packages and
  // marked them enabled, surface them to the model:
  //
  //   - Pinned skills get their FULL body inlined as one system message
  //     per skill — the user explicitly elevated them, so we pay the
  //     full-body cost up front instead of waiting for a load_claude_skill
  //     round-trip.
  //   - Other enabled (non-pinned) skills appear as a single stub system
  //     message that the model can drill into via load_claude_skill.
  //
  // Both injections come AFTER the main system prompt and BEFORE any
  // later user-profile / handoff context, so user-most-recent ordering
  // is preserved. Failures here are non-fatal — a Rust IPC outage at
  // chat start logs a diag and the loop runs without skills.
  await injectClaudeSkillsContext(msgs, opts.conversationId);

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
  const allTools = [...TOOLS, ...mcpTools] as unknown as typeof TOOLS;
  // Maturity review P0 #5: precompute allowlist Set once. The original
  // `.filter(... .includes(...))` was O(n×m) and ran every agent iteration
  // when re-deriving the tool list. The allowlist is run-scoped + immutable
  // so the Set hoists fine.
  // `let`, not `const`: loading a Claude skill with a declared `allowed_tools`
  // narrows this set for the rest of the run (enforced by the hard gate below),
  // so a skill scoped to e.g. read_file can't then invoke run_shell.
  let allowlistSet = toolAllowlist.length ? new Set(toolAllowlist) : null;
  // The model-facing tool list is built once from the initial grant (a const
  // snapshot so the closure narrows; later skill-narrowing only tightens the
  // dispatch gate, not the advertised list).
  const initialAllow = allowlistSet;
  const tools = initialAllow
    ? allTools.filter((t) => initialAllow.has(t.function.name))
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
  const RESEARCH_TOOLS = new Set(["web_search", "web_fetch", "read_pdf"]);
  // Nudge fires when the card has SOME way to commit the deliverable.
  // edit_file and multi_edit count too — a Coder-style card may prefer
  // edit_file over write_file, but it still needs to land its work on
  // disk eventually.
  const canWriteFile =
    !toolAllowlist.length ||
    toolAllowlist.includes("write_file") ||
    toolAllowlist.includes("edit_file") ||
    toolAllowlist.includes("multi_edit");
  // Narrow RESEARCH_TOOLS to *external* research so local read_file /
  // list_dir / search_files don't trip the nudge for Coder agents that
  // legitimately read many files before issuing the first edit. Pure
  // codebase exploration without web access never fires the nudge.
  let researchCallCount = 0;
  let writeCallCount = 0;
  let researchNudgeFired = false;
  // Bounded counter for the narrate-without-acting guard (see the
  // toolCalls.length === 0 branch).
  let narrationNudges = 0;

  // Per-run turn budget: the setting (opts.maxIterations) overrides the
  // default, clamped so a bad value can't spin forever or stall instantly.
  const MAX_ITERATIONS =
    opts.maxIterations != null
      ? Math.min(
          MAX_MAX_ITERATIONS,
          Math.max(MIN_MAX_ITERATIONS, Math.floor(opts.maxIterations)),
        )
      : DEFAULT_MAX_ITERATIONS;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal.aborted) return null;
      metrics.iterations = i + 1;

      const llmStart = performance.now();

      // Budget the SENT copy against the model's context window. Operates on a
      // copy — the persisted/displayed `msgs` array is never mutated. Keeps the
      // system prompt (first message) intact; truncates oversized tool results
      // and collapses old turns when the array would overflow the window.
      const budgeted = applyContextBudget(msgs, {
        model: opts.model,
        contextTokens: opts.contextTokens,
      });
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

      // C5: re-apply the unpaired-tool-call sanitizer to the BUDGETED copy that
      // is actually sent. `applyContextBudget` collapses old turns and can drop a
      // `role:"tool"` result while keeping its assistant `tool_calls` turn (or
      // vice versa); an unpaired tool_call id 400s the next request
      // ("tool_call_id not found"). The runner sanitizes its input and every
      // appended message, but the post-budget array is the one on the wire, so it
      // gets the same guard here.
      //
      // Perf: orphans can only be introduced by the budgeter's Pass-2 turn
      // collapse, which runs ONLY when it actually trimmed. When `trimmed` is
      // false, `budgeted.messages` is an unmutated shallow copy of the already-
      // sanitized `msgs`, so it is provably paired — skip the O(n) re-scan.
      const sentMessages = budgeted.trimmed
        ? stripUnpairedToolCalls(budgeted.messages)
        : budgeted.messages;

      let result: {
        content: string;
        tool_calls: ToolCall[];
        prompt_eval_count?: number;
        eval_count?: number;
      };
      // Streaming contract (perf review 2026-06-09, finding C1): in-flight text
      // travels ONLY through `onAssistantDelta`; `onUpdate` fires on structural
      // changes (a canonical message landing in `msgs`), never per token. The
      // old in-place-mutated placeholder + per-flush `onUpdate([...msgs])` was
      // invisible anyway — the placeholder kept referential identity across
      // flushes, so the display layer's MessageRow memo never repainted it —
      // while still busting the history memo every frame. Display layers own
      // accumulation + frame coalescing of the delta stream; on transport retry
      // `onStreamReset` tells them to drop the half-streamed attempt's text.
      try {
        result = await streamAgentChat(
          opts,
          sentMessages,
          tools,
          signal,
          (delta) => {
            onAssistantDelta?.(delta);
          },
          () => {
            metrics.retries++;
            onStreamReset?.();
          },
        );
      } catch (e) {
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

      if (toolCalls.length === 0) {
        // Narrate-without-acting guard: a coding agent that returns ONLY a
        // "let me fix X:" / "I'll work on Y:" preamble with NO tool call — and
        // has made ZERO tool calls the whole run — is not finished, it's stuck
        // narrating. (Seen live on qwen3-coder:480b-cloud once a conversation
        // fills with its own no-op "I'm working on it" turns: the model
        // pattern-matches and keeps describing instead of calling tools, so
        // nothing ever changes.) Don't accept that as the final answer — keep
        // the text, inject one strong "ACT, don't narrate" nudge, and continue.
        // Bounded by MAX_NARRATION_NUDGES so a model that truly can't act still
        // exits. Only fires when the card CAN write and no tool has run yet, so
        // a genuine completion summary after real work is never interrupted.
        if (
          canWriteFile &&
          metrics.toolCalls === 0 &&
          narrationNudges < MAX_NARRATION_NUDGES &&
          looksLikeActionPreamble(preludeText)
        ) {
          narrationNudges++;
          msgs.push({
            _tmpKey: makeTmpKey(),
            conversation_id: opts.conversationId,
            role: "assistant",
            content: preludeText,
          });
          msgs.push({
            _tmpKey: makeTmpKey(),
            conversation_id: opts.conversationId,
            role: "system",
            content:
              "[agent-loop] You described what you intend to do but issued NO tool call, so nothing happened. " +
              "In agent mode, describing an action does NOT perform it — you MUST call the tool. " +
              "On THIS turn, call the actual tool to make the change (edit_file / write_file / apply_patch / multi_edit / read_file / run_shell) — no preamble, no “let me”, just the tool call. " +
              "If you are genuinely finished and nothing remains to change, reply with a final summary that does NOT promise further edits.",
          });
          onUpdate([...msgs]);
          onStatusChange("thinking");
          continue;
        }
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
      if (isDuplicateTurn(sigs, prevTurnSigsHistory)) {
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
        // Perf: suppress the per-call onUpdate; coalesce into ONE fan-out after
        // the loop (and the optional dropped-call reminder) so a multi-call
        // duplicate turn doesn't clone the whole msgs array once per call.
        for (const tc of toolCalls) {
          const dupParsed = parseArgs(tc.function?.arguments);
          pushToolResult(
            msgs,
            opts.conversationId,
            onUpdate,
            tc,
            dupBody,
            {
              approval: "auto",
              outcome: "duplicate",
              errorKind: "duplicate_call",
              args: dupParsed.ok ? dupParsed.args : {},
              skipUpdate: true,
            },
            opts.workflowRunId ?? null,
          );
        }
        // Audit A30: a cloud-route turn truncated to one call (the rest dropped)
        // that then hits the dedupe branch would lose the "calls were dropped"
        // reminder (emitted only after the serial loop the dedupe `continue`
        // skips). Surface it here too so the model still knows to reissue them.
        if (droppedParallelCount > 0) {
          msgs.push({
            _tmpKey: makeTmpKey(),
            conversation_id: opts.conversationId,
            role: "system",
            content:
              `[agent-loop] Cloud-route only executes ONE tool call per turn. ` +
              `${droppedParallelCount} additional tool call(s) you issued were dropped — ` +
              `reissue any that still matter on your next turn.`,
          });
        }
        // Single coalesced fan-out for the whole dedupe branch.
        onUpdate([...msgs]);
        // Record the dup turn too so an oscillation keeps matching history.
        pushTurnSigs(sigs);
        continue;
      }
      // Snapshot this turn's tool-call signatures for next iterations' compare.
      pushTurnSigs(sigs);

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

      // Parallel read-only prefetch (opt #1): when EVERY call this turn is a
      // cacheable read-only tool (and we are not on a cloud route, which has
      // already been truncated to a single call above), fire their backend IPC
      // concurrently with a bounded pool. The serial loop below consumes these
      // prefetched results IN ORDER, so result ordering, the read-only cache,
      // stall counters, audit rows and abort handling all stay identical to the
      // serial path — only the awaited IPC overlaps. `load_claude_skill` is
      // excluded because it narrows the run's allowlist as a side effect and
      // must run through the serial post-processing.
      const isCloudRoute =
        typeof opts.model === "string" && opts.model.endsWith(":cloud");
      const canParallelize =
        !isCloudRoute &&
        toolCalls.length > 1 &&
        toolCalls.every((tc) => {
          const fn = tc.function?.name ?? "";
          return (
            isReadOnlyTool(fn) &&
            fn !== "load_claude_skill" &&
            (!allowlistSet || allowlistSet.has(fn))
          );
        });
      const prefetched = new Map<
        ToolCall,
        { result: string; threw: boolean; durationMs: number }
      >();
      if (canParallelize) {
        const tasks = toolCalls.map((tc) => async () => {
          if (signal.aborted) return;
          const fnName = tc.function?.name ?? "";
          const parsed = parseArgs(tc.function?.arguments);
          if (!parsed.ok) return; // serial loop emits bad_arguments
          const args = parsed.args;
          const ckey = cacheKey(fnName, args);
          if (readOnlyCache.has(ckey)) return; // serial loop serves from cache
          const started = performance.now();
          try {
            const result = await abortableToolResult(
              executeTool(fnName, args, {
                dryRun,
                shellTrackKey: signal,
                signal,
                conversationId: opts.conversationId,
                workspaceRoot,
                workflowRunId: opts.workflowRunId ?? null,
              }),
              signal,
            );
            prefetched.set(tc, {
              result,
              threw: false,
              durationMs: performance.now() - started,
            });
          } catch (e) {
            prefetched.set(tc, {
              result: formatToolError(e),
              threw: true,
              durationMs: performance.now() - started,
            });
          }
        });
        await runWithConcurrency(tasks, PARALLEL_READ_CAP);
      }

      // Per-turn progress flag (audit A09): set true when any tool call this
      // turn actually executes (non-error outcome). After the loop, a turn that
      // issued calls but made zero progress bumps nonProgressTurns.
      let anyToolProgressThisTurn = false;
      // Audit A33: on abort mid-turn, pair EVERY not-yet-resulted tool call in
      // this assistant turn with an aborted result before returning. Otherwise a
      // multi-call turn is left partially paired; stripUnpairedToolCalls then
      // drops the whole turn (including completed results) at the next send.
      const abortedBody = rejectionBody(
        "permission_denied",
        DENY_MESSAGE_BY_REASON.aborted ?? DENY_MESSAGE_BY_REASON.user_deny,
      );
      const pairAbortedFrom = (start: number) => {
        // Perf: suppress the per-call onUpdate and fire a single coalesced one
        // after the loop, so pairing many remaining calls on abort doesn't clone
        // the whole msgs array once per call. Only fan out if anything was paired.
        for (let j = start; j < toolCalls.length; j++) {
          const t = toolCalls[j];
          const ap = parseArgs(t.function?.arguments);
          pushToolResult(
            msgs,
            opts.conversationId,
            onUpdate,
            t,
            abortedBody,
            {
              approval: "denied",
              outcome: "denied",
              errorKind: "aborted",
              args: ap.ok ? ap.args : {},
              skipUpdate: true,
            },
            opts.workflowRunId ?? null,
          );
        }
        if (start < toolCalls.length) onUpdate([...msgs]);
      };
      for (let ti = 0; ti < toolCalls.length; ti++) {
        const tc = toolCalls[ti];
        if (signal.aborted) {
          pairAbortedFrom(ti);
          return null;
        }

        const fnName = tc.function?.name ?? "";
        // Compute the MCP-name test once per call and reuse it in the
        // dangerous-tool gate below (opt: it was re-evaluated in the `||` guard
        // there). `classifyToolRisk` still calls isMcpToolName internally — that
        // redundancy lives in dispatch.ts and is left untouched here.
        const isMcp = isMcpToolName(fnName);

        // Allowlist gate — uses the precomputed Set (P0 #5).
        if (allowlistSet && !allowlistSet.has(fnName)) {
          const naParsed = parseArgs(tc.function?.arguments);
          pushToolResult(
            msgs,
            opts.conversationId,
            onUpdate,
            tc,
            rejectionBody(
              "tool_not_allowed",
              `Tool '${fnName}' is not enabled for this conversation.`,
            ),
            {
              approval: "denied",
              outcome: "denied",
              errorKind: "tool_not_allowed",
              args: naParsed.ok ? naParsed.args : {},
            },
            opts.workflowRunId ?? null,
          );
          continue;
        }

        const parsed = parseArgs(tc.function?.arguments);
        if (!parsed.ok) {
          pushToolResult(
            msgs,
            opts.conversationId,
            onUpdate,
            tc,
            rejectionBody("bad_arguments", parsed.err),
            { approval: "auto", outcome: "error", errorKind: "bad_arguments" },
            opts.workflowRunId ?? null,
          );
          continue;
        }
        const args = parsed.args;

        // Read-only cache key, computed ONCE per call and reused by the stall
        // check, the serial cache probe, and cacheStore (perf: cacheKey does a
        // sort+JSON.stringify and was previously recomputed 2-3× for the same
        // call within a turn). Null for non-cacheable tools so the cache paths
        // are skipped entirely.
        //
        // `load_claude_skill` is deliberately EXCLUDED even though it is in
        // READ_ONLY_TOOLS: loading a skill narrows the run's allowlist as a side
        // effect (see the executeTool branch below), so serving it from cache
        // would skip that re-narrowing. This mirrors its exclusion from the
        // parallel prefetch above (bug: cached-serve dropped the side effect).
        const isCacheable =
          isReadOnlyTool(fnName) && fnName !== "load_claude_skill";
        const ckey = isCacheable ? cacheKey(fnName, args) : null;

        // Stall guard: if the agent keeps re-reading the same file in chunks,
        // bail out with a hint instead of letting it eat the iteration budget.
        // Skip a re-read the read-only cache will serve instantly (no IPC) — only
        // genuine backend reads should count toward the stall limit, otherwise a
        // legitimately-cached re-read is penalized as if it were chunk-thrashing.
        const servedFromCache = ckey != null && readOnlyCache.has(ckey);
        if (!servedFromCache) {
          const stall = isToolStalling(fnName, args, readCounts);
          if (stall.stalling) {
            const stallMsg =
              stall.tool === "read_file"
                ? `read_file has been called ${stall.count} times for '${stall.key}'. Stop chunking — call read_file ONCE without 'limit' to read up to 65536 bytes, then continue only if total_bytes > 65536. If you have enough context, answer the user now.`
                : `search_files has been run ${stall.count} times for the same pattern ('${stall.key}'). You already have these results — stop repeating the search and act on what you found, or answer the user now.`;
            pushToolResult(
              msgs,
              opts.conversationId,
              onUpdate,
              tc,
              rejectionBody("stall_guard", stallMsg),
              {
                approval: "auto",
                outcome: "stall_guard",
                errorKind: "stall_guard",
                args,
              },
              opts.workflowRunId ?? null,
            );
            continue;
          }
        }

        // Track which approval branch authorised this call — used in the
        // audit row so we can later distinguish auto/session/user approvals.
        let auditApproval: AuditApproval = "auto";

        // Confirmation gate for dangerous tools. MCP-provided tools are
        // out-of-process and not in the built-in DANGEROUS_TOOLS list, so they
        // are gated explicitly here — classifyToolRisk returns a non-normal
        // risk for them, and a careless/malicious MCP tool must never auto-run.
        if (DANGEROUS_TOOLS.has(fnName) || isMcp) {
          const risk = await classifyToolRisk(fnName, args);

          // Policy wins over session approval state. A loaded policy can
          // either auto-approve (skip confirmation) or deny outright. Risk is
          // passed so a policy can never auto-approve a non-normal-risk call.
          const policyVerdict = policyDecisionFor(
            projectPolicy,
            fnName,
            args,
            risk,
          );
          if (policyVerdict === "denied") {
            pushToolResult(
              msgs,
              opts.conversationId,
              onUpdate,
              tc,
              rejectionBody(
                "policy_denied",
                `Tool call denied by project policy${projectPolicy?.source_path ? ` (${projectPolicy.source_path})` : ""}.`,
              ),
              {
                approval: "denied",
                outcome: "denied",
                errorKind: "policy_denied",
                args,
              },
              opts.workflowRunId ?? null,
            );
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
              (APPROVE_ALL_WRITE_FS.has(fnName) &&
                approveAllWrite &&
                risk === "normal"));
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
              const auditReason = VALID_DENY_REASONS.has(rawReason)
                ? rawReason
                : "user_deny";
              // Model-facing `kind`: collapse to a single learnable error
              // class ("permission_denied"). Models trained on standard
              // permission errors recognise this; the internal taxonomy
              // (user_deny / aborted / unattended_denied) lives ONLY in
              // the audit row so post-hoc reviewers retain full fidelity.
              pushToolResult(
                msgs,
                opts.conversationId,
                onUpdate,
                tc,
                rejectionBody(
                  "permission_denied",
                  DENY_MESSAGE_BY_REASON[auditReason] ??
                    DENY_MESSAGE_BY_REASON.user_deny,
                ),
                {
                  approval: "denied",
                  outcome: "denied",
                  errorKind: auditReason,
                  args,
                },
                opts.workflowRunId ?? null,
              );
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

        // Re-check abort AFTER the (possibly long) confirmation wait. If the user
        // hit Stop while the modal was open, do NOT execute the tool they tried
        // to cancel — even on a late "Allow" click. Pair THIS tool call with a
        // denied/aborted result before bailing so the assistant tool_calls
        // message is never left with an unpaired id (which would 400 the next
        // send). Round 6 HIGH (2026-05-30).
        if (signal.aborted) {
          pushToolResult(
            msgs,
            opts.conversationId,
            onUpdate,
            tc,
            rejectionBody(
              "permission_denied",
              DENY_MESSAGE_BY_REASON.aborted ??
                DENY_MESSAGE_BY_REASON.user_deny,
            ),
            {
              approval: "denied",
              outcome: "denied",
              errorKind: "aborted",
              args,
            },
            opts.workflowRunId ?? null,
          );
          pairAbortedFrom(ti + 1); // A33: pair the rest of the turn too
          return null;
        }

        const toolStart = performance.now();
        let result: string;
        let toolErrorKind: string | null = null;
        // Set when this call's backend IPC ran in the parallel prefetch above —
        // its measured duration replaces the (near-zero) serial-await timing.
        let prefetchDurationMs: number | null = null;
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
            const timeoutMs = Math.min(
              AWAIT_TIMEOUT_CAP_MS,
              Math.max(0, rawTimeoutSecs) * 1000,
            );
            result = await awaitSubagents(ids, timeoutMs);
          } else if (fnName === "list_subagents") {
            result = listSubagents();
          } else {
            // Read-only cache short-circuit: if the model just called the same
            // read-only tool with the same args (e.g. read_file the same path
            // twice across two iterations), return the cached payload instead
            // of round-tripping IPC. The cache is invalidated below whenever a
            // non-read-only tool succeeds. `ckey`/`isCacheable` were computed
            // once at the top of the call (load_claude_skill is excluded so its
            // allowlist-narrowing side effect always re-runs).
            if (ckey != null && readOnlyCache.has(ckey)) {
              result = readOnlyCache.get(ckey)!;
            } else if (prefetched.has(tc)) {
              // Consume the result the parallel prefetch already produced for
              // this call. Cache it exactly as the serial path would (skip
              // error bodies so a transient failure isn't memoized).
              const pf = prefetched.get(tc)!;
              result = pf.result;
              if (pf.threw) toolErrorKind = "tool_error";
              prefetchDurationMs = pf.durationMs;
              if (ckey != null && !pf.threw) {
                let cacheable = true;
                try {
                  const r = JSON.parse(result) as { ok?: boolean } | null;
                  if (r && r.ok === false) cacheable = false;
                } catch {
                  /* non-JSON read result — cache it */
                }
                if (cacheable) cacheStore(ckey, result);
              }
            } else {
              // `shellTrackKey: signal` keys this loop's active-shell entry
              // by its AbortSignal. Sibling loops (parent + subagent) get
              // distinct signals and therefore distinct map entries, so a
              // `run_shell` in one loop can't be overwritten or cancelled by
              // the other.
              // C1: race the tool against the abort signal so a Stop mid-tool
              // returns control to the loop promptly instead of blocking on the
              // tool's own timeout. `signal` is also passed into executeTool so
              // backend-cancellable long-running tools can terminate their op.
              result = await abortableToolResult(
                executeTool(fnName, args, {
                  dryRun,
                  shellTrackKey: signal,
                  signal,
                  // Surfaced for tools that tag their output to a conversation.
                  // The runner already carries the active conversation id in
                  // opts; pass it down unmodified.
                  conversationId: opts.conversationId,
                  // Project scope for the memory tools (remember/recall).
                  workspaceRoot,
                  // Thread the parent workflow_runs.id (if any) so that nested
                  // tools that emit their own audit rows (today: the skill
                  // invocation start/end markers) can correlate back to the
                  // run that produced them. L-A2 (2026-05-28).
                  workflowRunId: opts.workflowRunId ?? null,
                }),
                signal,
              );
              // Skill allowlist ENFORCEMENT (review finding 2026-06): when a
              // skill with a declared allowed_tools loads, narrow the run's tool
              // gate to that set, intersected with the existing grant (least
              // privilege). The hard gate above (`allowlistSet && !has`) then
              // blocks any call the skill didn't authorize. Skill meta-tools stay
              // callable so the model can still load/refresh skills.
              if (fnName === "load_claude_skill") {
                try {
                  const r = JSON.parse(result) as {
                    ok?: boolean;
                    allowed_tools?: unknown;
                  };
                  if (
                    r?.ok &&
                    Array.isArray(r.allowed_tools) &&
                    r.allowed_tools.length > 0
                  ) {
                    const skillSet = new Set<string>(
                      (r.allowed_tools as unknown[]).filter(
                        (t): t is string => typeof t === "string",
                      ),
                    );
                    skillSet.add("load_claude_skill");
                    skillSet.add("list_claude_skills");
                    allowlistSet = allowlistSet
                      ? new Set(
                          [...allowlistSet].filter((t) => skillSet.has(t)),
                        )
                      : skillSet;
                  }
                } catch {
                  /* malformed result — leave the gate unchanged */
                }
              }
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
        const durationMs = prefetchDurationMs ?? performance.now() - toolStart;
        // C1: if Stop fired during the tool, `abortableToolResult` returned the
        // aborted sentinel. Pair it and END the loop rather than feeding it back
        // to the model for another turn. Pairing a result before returning keeps
        // the assistant tool_calls message from carrying an unpaired id.
        if (signal.aborted) {
          pushToolResult(
            msgs,
            opts.conversationId,
            onUpdate,
            tc,
            result,
            {
              approval: auditApproval,
              outcome: "denied",
              errorKind: "aborted",
              args,
              durationMs,
            },
            opts.workflowRunId ?? null,
          );
          pairAbortedFrom(ti + 1); // A33: pair the rest of the turn too
          return null;
        }
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
            const parsedResult = JSON.parse(
              result,
            ) as Partial<ToolResult> | null;
            if (parsedResult && typeof parsedResult === "object") {
              // Dry-run results take precedence — they're recorded as `dry_run`
              // regardless of `ok` status so the suppressed call shows up
              // distinctly in the audit log.
              if (parsedResult.dry_run === true) {
                outcome = "dry_run";
                if (
                  parsedResult.ok === false &&
                  typeof parsedResult.blocked_by_safety === "string"
                ) {
                  toolErrorKind = "blocked_by_safety";
                } else if (
                  parsedResult.ok === false &&
                  typeof parsedResult.kind === "string"
                ) {
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

        pushToolResult(
          msgs,
          opts.conversationId,
          onUpdate,
          tc,
          result,
          {
            approval: auditApproval,
            outcome,
            errorKind: toolErrorKind,
            args,
            durationMs,
          },
          opts.workflowRunId ?? null,
        );

        // Track research-vs-write balance so the post-turn block below can
        // inject a "stop researching, write the file" nudge before the
        // iteration budget is exhausted. `outcome` of `error` is not
        // counted — only successful research calls accumulate. (Denied
        // calls short-circuited earlier via `continue` and never reach
        // this point in the loop.)
        if (outcome !== "error") {
          if (RESEARCH_TOOLS.has(fnName)) researchCallCount++;
          if (
            fnName === "write_file" ||
            fnName === "edit_file" ||
            fnName === "multi_edit"
          ) {
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
          // A real (non-error) execution = progress this turn (A09).
          anyToolProgressThisTurn = true;
        }

        // Invalidate the read-only cache whenever a non-read-only tool RAN —
        // regardless of ok status (audit A02). A multi-target write
        // (apply_patch / write_files / multi_edit) can fail PART WAY THROUGH and
        // return an error outcome while having already changed disk; gating the
        // clear on `outcome !== "error"` left the cache serving stale reads of
        // the just-mutated files. Conservative: nuke the whole map.
        if (!isReadOnlyTool(fnName)) {
          readOnlyCache.clear();
          // Audit A20: also drop the dedupe history. After a write the model
          // legitimately re-reads the changed file to verify; that read's
          // signature would otherwise match a pre-write read and be rejected as
          // a duplicate. Clearing here keeps re-read-after-write flowing.
          prevTurnSigsHistory.length = 0;
        }
      }

      // Turn-level non-progress guard (A09): a turn that issued tool calls but
      // executed none successfully (all denied/blocked/errored) counts as
      // non-progress; a streak trips the stop-and-report hint so an unattended
      // run can't burn its whole budget on a permission wall.
      if (toolCalls.length > 0 && !anyToolProgressThisTurn) {
        nonProgressTurns++;
        if (nonProgressTurns >= MAX_NONPROGRESS_TURNS) {
          stopAndReportHintPending = true;
        }
      } else if (anyToolProgressThisTurn) {
        nonProgressTurns = 0;
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

      // Item 4A: durable checkpoint. Coalesced (see flushCheckpoint) so it does
      // NOT re-serialise + full-rewrite every iteration — that was O(N²) over a
      // long run. Fires here after this turn's assistant + tool-result messages
      // have settled into `msgs`, gated by the new-turn / interval throttle. The
      // loop-exit `flushCheckpoint(true)` in `finally` guarantees the final
      // settled state is always persisted. ABSENT callback = no-op (byte-
      // identical to prior behaviour for subagents/flows/tests).
      flushCheckpoint(false);

      onStatusChange("thinking");
    }

    const limitMsg: Message = {
      _tmpKey: makeTmpKey(),
      conversation_id: opts.conversationId,
      role: "assistant",
      content:
        `[Agent reached its turn limit (${MAX_ITERATIONS}) without finishing. ` +
        `Its work so far is saved — reply "continue" to resume, or raise the ` +
        `turn limit in Agent settings for long multi-file builds.]`,
    };
    msgs.push(limitMsg);
    onUpdate([...msgs]);
    onStatusChange("done");
    return null;
  } finally {
    // Item 4A: always flush the final settled checkpoint on any exit
    // (completion, abort, exception, iteration cap) so the coalescing throttle
    // can never drop the last few turns. `flushCheckpoint` is a no-op when there
    // is nothing new since the last flush.
    try {
      flushCheckpoint(true);
    } catch (e) {
      logDiag({
        level: "warn",
        source: "agent-loop",
        message: "final checkpoint flush failed",
        detail: e,
      });
    }
    recordMetricsOnce();
  }
}
