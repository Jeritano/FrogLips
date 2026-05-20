import type { AuditApproval, AuditOutcome, Message, ProjectPolicy, ToolCall } from "../../types";
import type { AgentMetrics, AgentRunOptions } from "./types";
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
import { OLLAMA_BASE, RETRY_BACKOFF_MS, RETRY_MAX, streamOllamaChat, toOllamaMessages } from "./ollama-client";
import { awaitSubagents, listSubagents, runSubagent, spawnSubagentAsync } from "./subagent";
import { fetchMcpTools } from "./mcp-tools";
import { api } from "../tauri-api";

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
 * Consult the active project policy for a tool call. Returns:
 *   - "auto"          → skip the confirmation prompt entirely
 *   - "needs-confirm" → fall through to the existing gate
 *   - "denied"        → reject without executing
 *
 * Exported for unit tests; the runner uses it internally.
 */
export function policyDecisionFor(
  policy: ProjectPolicy | null | undefined,
  fnName: string,
  args: Record<string, unknown>,
): PolicyVerdict {
  if (!policy) return "needs-confirm";
  if (policy.auto_approve_dangerous_tools?.includes(fnName)) {
    return "auto";
  }
  if (fnName === SHELL_TOOL) {
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
const DEDUPE_WINDOW = 3;
// Stall detection: if agent reads the same path > this many times in
// monotonically-advancing tiny chunks, abort the loop with an explanatory msg.
const STALL_SAME_PATH_LIMIT = 6;

function makeTmpKey() {
  return `tmp:${crypto.randomUUID()}`;
}

/* ── Cited paths registry ──────────────────────────────────────────────────
 *
 * Session-scoped record of every path that successfully resolved via a
 * `read_file` tool call, keyed by conversation id. The chat UI's citation
 * post-processor uses this in a future iteration to chip-ify *plain-text*
 * mentions of paths that the agent just read (v1 only chip-ifies backticked
 * paths). Stored at module scope so multiple agent runs in the same session
 * share state; bounded to avoid unbounded growth across long sessions.
 */
const CITED_PATHS_LIMIT_PER_CONV = 256;
const citedPathsByConv: Map<number, Set<string>> = new Map();

function rememberCitedPath(conversationId: number, path: string): void {
  let set = citedPathsByConv.get(conversationId);
  if (!set) {
    set = new Set();
    citedPathsByConv.set(conversationId, set);
  }
  set.add(path);
  // Bound the set — FIFO drop. Worst case the post-processor loses
  // chip-ification for the oldest reads, no correctness impact.
  if (set.size > CITED_PATHS_LIMIT_PER_CONV) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

/** Read-only snapshot of cited paths for a given conversation. */
export function getCitedPaths(conversationId: number): string[] {
  const s = citedPathsByConv.get(conversationId);
  return s ? Array.from(s) : [];
}

/** Test helper — clears the cited-paths cache. */
export function _resetCitedPaths(): void {
  citedPathsByConv.clear();
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

export async function runAgentLoop(opts: AgentRunOptions): Promise<string | null> {
  const {
    model, onUpdate, onStatusChange, onMetrics, onAssistantDelta, requestConfirmation, signal,
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
  // Per-path read counter — guards against agents chunking the same file
  // into dozens of tiny reads and blowing the iteration budget.
  const readCounts = new Map<string, number>();

  onStatusChange("thinking");

  // Discover MCP-provided tools once per run. Failures are swallowed inside
  // fetchMcpTools so the loop never blocks on a broken server.
  const mcpTools = await fetchMcpTools();

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

    let result: { content: string; tool_calls: ToolCall[]; prompt_eval_count?: number; eval_count?: number };
    try {
      let lastErr: unknown = null;
      let finalResult:
        | { content: string; tool_calls: ToolCall[]; prompt_eval_count?: number; eval_count?: number }
        | null = null;
      for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
        if (signal.aborted) return null;
        try {
          // Reset the placeholder's content on retry so the bubble doesn't
          // duplicate partial text from a half-streamed previous attempt.
          streamingMsg.content = "";
          finalResult = await streamOllamaChat(
            `${OLLAMA_BASE}/api/chat`,
            {
              model,
              options: { temperature: 0.4 },
              messages: toOllamaMessages(msgs.filter((m) => m._tmpKey !== streamingKey)),
              tools,
            },
            signal,
            (delta) => {
              streamingMsg.content += delta;
              onAssistantDelta?.(delta);
              onUpdate([...msgs]);
            },
          );
          break;
        } catch (e) {
          lastErr = e;
          if (signal.aborted) throw e;
          const msgErr = e instanceof Error ? e.message : String(e);
          const isRetriable = /Ollama 5\d\d:/.test(msgErr) || !/Ollama \d{3}:/.test(msgErr);
          if (isRetriable && attempt < RETRY_MAX) {
            metrics.retries++;
            await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      if (!finalResult) throw lastErr ?? new Error("Ollama call failed");
      result = finalResult;
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
        const tcName = tc.function?.name ?? "";
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: dupBody,
          tool_call_id: tc.id,
          tool_name: tcName,
        });
        const dupParsed = parseArgs(tc.function?.arguments);
        recordAuditSafe({
          toolName: tcName,
          args: dupParsed.ok ? dupParsed.args : {},
          resultBody: dupBody,
          durationMs: 0,
          approval: "auto",
          outcome: "duplicate",
          errorKind: "duplicate_call",
          conversationId: opts.conversationId,
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
        const notAllowedBody = JSON.stringify({
          ok: false,
          kind: "tool_not_allowed",
          message: `Tool '${fnName}' is not enabled for this conversation.`,
        });
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: notAllowedBody,
          tool_call_id: tc.id,
          tool_name: fnName,
        });
        const naParsed = parseArgs(tc.function?.arguments);
        recordAuditSafe({
          toolName: fnName,
          args: naParsed.ok ? naParsed.args : {},
          resultBody: notAllowedBody,
          durationMs: 0,
          approval: "denied",
          outcome: "denied",
          errorKind: "tool_not_allowed",
          conversationId: opts.conversationId,
        });
        onUpdate([...msgs]);
        continue;
      }

      const parsed = parseArgs(tc.function?.arguments);
      if (!parsed.ok) {
        const badBody = JSON.stringify({ ok: false, kind: "bad_arguments", message: parsed.err });
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: badBody,
          tool_call_id: tc.id,
          tool_name: fnName,
        });
        recordAuditSafe({
          toolName: fnName,
          args: {},
          resultBody: badBody,
          durationMs: 0,
          approval: "auto",
          outcome: "error",
          errorKind: "bad_arguments",
          conversationId: opts.conversationId,
        });
        onUpdate([...msgs]);
        continue;
      }
      const args = parsed.args;

      // Stall guard: if the agent keeps re-reading the same file in chunks,
      // bail out with a hint instead of letting it eat the iteration budget.
      if (fnName === "read_file") {
        const p = String(args.path ?? "");
        const n = (readCounts.get(p) ?? 0) + 1;
        readCounts.set(p, n);
        if (n > STALL_SAME_PATH_LIMIT) {
          const stallBody = JSON.stringify({
            ok: false,
            kind: "stall_guard",
            message: `read_file has been called ${n} times for '${p}'. Stop chunking — call read_file ONCE without 'limit' to read up to 65536 bytes, then continue only if total_bytes > 65536. If you have enough context, answer the user now.`,
          });
          msgs.push({
            _tmpKey: makeTmpKey(),
            conversation_id: opts.conversationId,
            role: "tool",
            content: stallBody,
            tool_call_id: tc.id,
            tool_name: fnName,
          });
          recordAuditSafe({
            toolName: fnName,
            args,
            resultBody: stallBody,
            durationMs: 0,
            approval: "auto",
            outcome: "stall_guard",
            errorKind: "stall_guard",
            conversationId: opts.conversationId,
          });
          onUpdate([...msgs]);
          continue;
        }
      }

      // Track which approval branch authorised this call — used in the
      // audit row so we can later distinguish auto/session/user approvals.
      let auditApproval: AuditApproval = "auto";

      // Confirmation gate for dangerous tools
      if (DANGEROUS_TOOLS.has(fnName)) {
        const risk = await classifyToolRisk(fnName, args);

        // Policy wins over session approval state. A loaded policy can
        // either auto-approve (skip confirmation) or deny outright.
        const policyVerdict = policyDecisionFor(projectPolicy, fnName, args);
        if (policyVerdict === "denied") {
          const polBody = JSON.stringify({
            ok: false,
            kind: "policy_denied",
            message: `Tool call denied by project policy${projectPolicy?.source_path ? ` (${projectPolicy.source_path})` : ""}.`,
          });
          msgs.push({
            _tmpKey: makeTmpKey(),
            conversation_id: opts.conversationId,
            role: "tool",
            content: polBody,
            tool_call_id: tc.id,
            tool_name: fnName,
          });
          recordAuditSafe({
            toolName: fnName,
            args,
            resultBody: polBody,
            durationMs: 0,
            approval: "denied",
            outcome: "denied",
            errorKind: "policy_denied",
            conversationId: opts.conversationId,
          });
          onUpdate([...msgs]);
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
          (WRITE_TOOLS.has(fnName) && approveAllWrite);
        if (sessionApproved) {
          auditApproval = "session_allowed";
        }
        if (!sessionApproved) {
          const decision = await requestConfirmation(fnName, args, risk);
          if (!decision.approve) {
            const denBody = JSON.stringify({
              ok: false,
              kind: "user_denied",
              message: "User denied this tool call.",
            });
            msgs.push({
              _tmpKey: makeTmpKey(),
              conversation_id: opts.conversationId,
              role: "tool",
              content: denBody,
              tool_call_id: tc.id,
              tool_name: fnName,
            });
            recordAuditSafe({
              toolName: fnName,
              args,
              resultBody: denBody,
              durationMs: 0,
              approval: "denied",
              outcome: "denied",
              errorKind: "user_denied",
              conversationId: opts.conversationId,
            });
            onUpdate([...msgs]);
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
          const timeoutSecs = typeof args.timeout_seconds === "number" ? args.timeout_seconds : 600;
          result = await awaitSubagents(ids, Math.max(0, timeoutSecs) * 1000);
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
      // wrappers return `{ok:false, kind:...}` rather than throwing.
      let outcome: AuditOutcome = toolErrorKind ? "error" : "ok";
      if (!toolErrorKind) {
        try {
          const parsedResult = JSON.parse(result);
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

      recordAuditSafe({
        toolName: fnName,
        args,
        resultBody: result,
        durationMs,
        approval: auditApproval,
        outcome,
        errorKind: toolErrorKind,
        conversationId: opts.conversationId,
      });

      // Track cited paths for the citation post-processor. We only record
      // on a successful read_file — both because failed reads don't surface
      // a real path and because the chip would 404 on click.
      if (fnName === "read_file" && outcome === "ok") {
        const p = typeof args.path === "string" ? args.path : "";
        if (p) rememberCitedPath(opts.conversationId, p);
      }

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
  } finally {
    recordMetricsOnce();
  }
}
