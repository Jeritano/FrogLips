import type { AuditApproval, AuditOutcome, Message, ProjectPolicy, ToolCall } from "../../types";
import type { AgentMetrics, AgentRunOptions, Risk, ToolResult } from "./types";
import { TOOLS } from "./tools";
import {
  DANGEROUS_TOOLS,
  SHELL_TOOL,
  WRITE_TOOLS,
  classifyToolRisk,
  executeTool,
  formatToolError,
  parseArgs,
  recordAuditSafe,
  toolCallSig,
} from "./dispatch";
import { buildSystemPrompt } from "./system-prompt";
import { applyContextBudget } from "./context-manager";
import { agentBackendUnsupportedReason, streamAgentChat } from "./agent-chat";
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

function policyShellVerdict(policy: ProjectPolicy, command: string): PolicyVerdict {
  const prefixes = policy.allowed_shell_prefixes;
  if (!prefixes || prefixes.length === 0) return "needs-confirm";
  const first = command.trim().split(/\s+/)[0] ?? "";
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
 * Tools whose risk is severe enough that NO policy may auto-approve them —
 * they always require an explicit per-call confirmation. A malicious repo
 * ships its own `.froglips/policy.json`, so policy auto-approve can never be
 * trusted to silently run a shell command or arbitrary AppleScript.
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
  const sp = policy.source_path ?? "";
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
    // policyShellVerdict can return "auto" via allowed_shell_prefixes — but
    // shell must always confirm, so downgrade any such auto to needs-confirm.
    const v = policyShellVerdict(policy, String(args.command ?? ""));
    return v === "auto" ? "needs-confirm" : v;
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
// Number of recent tool-call signatures retained for duplicate detection.
const DEDUPE_WINDOW = 6;
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
  });
  onUpdate([...msgs]);
}

/** True when every tool call this turn was already seen in the recent window. */
function isDuplicateTurn(sigs: string[], recentSigs: string[]): boolean {
  return recentSigs.length > 0 && sigs.every((s) => recentSigs.includes(s));
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

  // Fail loudly before the loop starts if the active backend can't do
  // tool-calling. Native (mistralrs) has no tool support — surface a clear
  // error rather than silently degrading to plain streaming.
  const backendReason = agentBackendUnsupportedReason(opts.backend ?? "ollama");
  if (backendReason) {
    onStatusChange("error");
    throw new Error(backendReason);
  }

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
  };
  const recentSigs: string[] = [];
  // Per-path read counter — guards against agents chunking the same file
  // into dozens of tiny reads and blowing the iteration budget.
  const readCounts = new Map<string, number>();
  // Consecutive tool-failure counter — bumped on every `ok:false` result,
  // reset on the first success. Once it crosses MAX_CONSECUTIVE_TOOL_ERRORS
  // the loop injects a stop-and-report hint.
  let consecutiveToolErrors = 0;
  let stopAndReportHintPending = false;

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
  const tools = toolAllowlist.length
    ? allTools.filter((t) => toolAllowlist.includes(t.function.name))
    : allTools;

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
    try {
      result = await streamAgentChat(
        opts,
        budgeted.messages,
        tools,
        signal,
        (delta) => {
          streamingMsg.content += delta;
          onAssistantDelta?.(delta);
          onUpdate([...msgs]);
        },
        () => {
          // Retry fired — bump the counter and reset the placeholder so the
          // bubble doesn't duplicate text from the half-streamed attempt.
          metrics.retries++;
          streamingMsg.content = "";
        },
      );
    } catch (e) {
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

    const toolCalls = result.tool_calls;
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
    if (isDuplicateTurn(sigs, recentSigs)) {
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
        });
      }
      continue;
    }
    for (const s of sigs) {
      recentSigs.push(s);
      while (recentSigs.length > DEDUPE_WINDOW) recentSigs.shift();
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
        const naParsed = parseArgs(tc.function?.arguments);
        pushToolResult(msgs, opts.conversationId, onUpdate, tc,
          rejectionBody("tool_not_allowed", `Tool '${fnName}' is not enabled for this conversation.`),
          {
            approval: "denied",
            outcome: "denied",
            errorKind: "tool_not_allowed",
            args: naParsed.ok ? naParsed.args : {},
          });
        continue;
      }

      const parsed = parseArgs(tc.function?.arguments);
      if (!parsed.ok) {
        pushToolResult(msgs, opts.conversationId, onUpdate, tc,
          rejectionBody("bad_arguments", parsed.err),
          { approval: "auto", outcome: "error", errorKind: "bad_arguments" });
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
          { approval: "auto", outcome: "stall_guard", errorKind: "stall_guard", args });
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
            { approval: "denied", outcome: "denied", errorKind: "policy_denied", args });
          continue;
        }

        const cmd = String(args.command ?? "");
        const firstWord = cmd.trim().split(/\s+/)[0] ?? "";
        const prefixApproved =
          fnName === SHELL_TOOL &&
          risk === "normal" &&
          firstWord !== "" &&
          approvedShellPrefixes.includes(firstWord);
        const sessionApproved =
          policyVerdict === "auto" ||
          prefixApproved ||
          (fnName === SHELL_TOOL && approveAllShell && risk === "normal") ||
          // Blanket write-approval only covers normal-risk writes — an
          // elevated call (e.g. an http_request carrying a body, or a
          // destructive method) always needs an explicit confirmation.
          (WRITE_TOOLS.has(fnName) && approveAllWrite && risk === "normal");
        if (sessionApproved) {
          auditApproval = "session_allowed";
        }
        if (!sessionApproved) {
          const decision = await requestConfirmation(fnName, args, risk);
          if (!decision.approve) {
            pushToolResult(msgs, opts.conversationId, onUpdate, tc,
              rejectionBody("user_denied", "User denied this tool call."),
              { approval: "denied", outcome: "denied", errorKind: "user_denied", args });
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
          // bogus huge value can't wedge the loop indefinitely.
          const AWAIT_TIMEOUT_CAP_MS = 600_000;
          const rawTimeoutSecs = typeof args.timeout_seconds === "number" ? args.timeout_seconds : 600;
          const timeoutMs = Math.min(AWAIT_TIMEOUT_CAP_MS, Math.max(0, rawTimeoutSecs) * 1000);
          result = await awaitSubagents(ids, timeoutMs);
        } else if (fnName === "list_subagents") {
          result = listSubagents();
        } else {
          result = await executeTool(fnName, args, { dryRun });
        }
      } catch (e) {
        result = formatToolError(e);
        toolErrorKind = "tool_error";
      }
      const durationMs = performance.now() - toolStart;
      metrics.totalToolMs += durationMs;
      metrics.toolCalls++;
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
      });

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
    }

    // After a run of consecutive tool failures, inject a system hint so the
    // model stops retrying and reports the blocker to the user. This is an
    // additional guard layered on top of the dedupe / stall / MAX_ITERATIONS
    // logic — the dedupe window only catches IDENTICAL repeated calls.
    if (stopAndReportHintPending) {
      stopAndReportHintPending = false;
      consecutiveToolErrors = 0;
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
