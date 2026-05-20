import type { Message, ToolCall } from "../../types";
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
  toolCallSig,
} from "./dispatch";
import { buildSystemPrompt } from "./system-prompt";
import { OLLAMA_BASE, RETRY_BACKOFF_MS, RETRY_MAX, streamOllamaChat, toOllamaMessages } from "./ollama-client";
import { runSubagent } from "./subagent";
import { fetchMcpTools } from "./mcp-tools";

const MAX_ITERATIONS = 40;
const DEDUPE_WINDOW = 3;
// Stall detection: if agent reads the same path > this many times in
// monotonically-advancing tiny chunks, abort the loop with an explanatory msg.
const STALL_SAME_PATH_LIMIT = 6;

function makeTmpKey() {
  return `tmp:${crypto.randomUUID()}`;
}

/* ── Main loop ── */

export async function runAgentLoop(opts: AgentRunOptions): Promise<string | null> {
  const {
    model, onUpdate, onStatusChange, onMetrics, onAssistantDelta, requestConfirmation, signal,
    workspaceRoot, systemPromptOverride,
    toolAllowlist = [], approveAllShell, approveAllWrite,
    approvedShellPrefixes = [], onApproveShellPrefix,
  } = opts;
  const msgs: Message[] = [...opts.messages];

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
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: dupBody,
          tool_call_id: tc.id,
          tool_name: tc.function?.name ?? "",
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
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: JSON.stringify({
            ok: false,
            kind: "tool_not_allowed",
            message: `Tool '${fnName}' is not enabled for this conversation.`,
          }),
          tool_call_id: tc.id,
          tool_name: fnName,
        });
        onUpdate([...msgs]);
        continue;
      }

      const parsed = parseArgs(tc.function?.arguments);
      if (!parsed.ok) {
        msgs.push({
          _tmpKey: makeTmpKey(),
          conversation_id: opts.conversationId,
          role: "tool",
          content: JSON.stringify({ ok: false, kind: "bad_arguments", message: parsed.err }),
          tool_call_id: tc.id,
          tool_name: fnName,
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
          msgs.push({
            _tmpKey: makeTmpKey(),
            conversation_id: opts.conversationId,
            role: "tool",
            content: JSON.stringify({
              ok: false,
              kind: "stall_guard",
              message: `read_file has been called ${n} times for '${p}'. Stop chunking — call read_file ONCE without 'limit' to read up to 65536 bytes, then continue only if total_bytes > 65536. If you have enough context, answer the user now.`,
            }),
            tool_call_id: tc.id,
            tool_name: fnName,
          });
          onUpdate([...msgs]);
          continue;
        }
      }

      // Confirmation gate for dangerous tools
      if (DANGEROUS_TOOLS.has(fnName)) {
        const risk = await classifyToolRisk(fnName, args);
        const cmd = String(args.command ?? "");
        const firstWord = cmd.trim().split(/\s+/)[0] ?? "";
        const prefixApproved =
          fnName === SHELL_TOOL &&
          risk === "normal" &&
          firstWord !== "" &&
          approvedShellPrefixes.includes(firstWord);
        const sessionApproved =
          prefixApproved ||
          (fnName === SHELL_TOOL && approveAllShell && risk === "normal") ||
          (WRITE_TOOLS.has(fnName) && approveAllWrite);
        if (!sessionApproved) {
          const decision = await requestConfirmation(fnName, args, risk);
          if (!decision.approve) {
            msgs.push({
              _tmpKey: makeTmpKey(),
              conversation_id: opts.conversationId,
              role: "tool",
              content: JSON.stringify({
                ok: false,
                kind: "user_denied",
                message: "User denied this tool call.",
              }),
              tool_call_id: tc.id,
              tool_name: fnName,
            });
            onUpdate([...msgs]);
            continue;
          }
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
      try {
        if (fnName === "spawn_subagent") {
          result = await runSubagent(args, opts);
        } else {
          result = await executeTool(fnName, args);
        }
      } catch (e) {
        result = formatToolError(e);
      }
      metrics.totalToolMs += performance.now() - toolStart;
      metrics.toolCalls++;
      onMetrics?.({ ...metrics });

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
}
