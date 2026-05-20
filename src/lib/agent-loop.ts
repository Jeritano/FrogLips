import { api } from "./tauri-api";
import type { Message, ToolCall } from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
   Agentic loop for locally-running tool-calling models (e.g. Hermes 3, Qwen3,
   Mistral-Nemo) via Ollama's /api/chat endpoint.

   Flow per iteration:
   1. POST messages + tool defs to Ollama (non-streaming)
   2. If response has tool_calls → confirm dangerous ones → execute → inject results → loop
   3. If no tool_calls → that's the final text answer → return it
   ──────────────────────────────────────────────────────────────────────────── */

const OLLAMA_BASE = "http://127.0.0.1:11434";
const MAX_ITERATIONS = 20;

const AGENT_SYSTEM_PROMPT = `You are an autonomous agent running on the user's local machine with direct access to their filesystem and shell via tools.

Available tools:
- read_file(path): read a file's contents
- list_dir(path): list directory entries
- run_shell(command): execute a shell command via sh -c (e.g. "open -a Safari https://example.com" on macOS)
- write_file(path, content): write a file

Rules:
1. When the user asks you to do something actionable on the system (open an app, read files, run a command, modify files), CALL THE TOOLS. Do not just describe what you would do.
2. Never claim you "don't have access" or "can't" perform an action — you have full tool access. Use it.
3. Chain tool calls as needed. After each result, decide the next step.
4. Only respond with prose when (a) you've completed the task and are reporting results, or (b) you genuinely need clarification from the user.
5. The host OS is macOS (Darwin). Use macOS-native commands (e.g. \`open\` to launch apps/URLs).`;

export type AgentStatus = "idle" | "thinking" | "tool" | "done" | "error";

export interface AgentRunOptions {
  model: string;
  messages: Message[];
  conversationId: number;
  onUpdate: (msgs: Message[]) => void;
  onStatusChange: (status: AgentStatus) => void;
  requestConfirmation: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  signal: AbortSignal;
}

/* ── Tool definitions (OpenAI function format) ── */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the text contents of a file. Returns the content, truncated at 64 KB for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path or ~/relative path to the file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the contents of a directory. Returns an array of entries with name, kind (file/dir/symlink), and size in bytes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path or ~/relative path to the directory." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Execute a shell command via sh -c. Returns stdout, stderr, and exit_code. Times out after 30 s. ALWAYS requires explicit user approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string (passed verbatim to sh -c)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write text content to a file, creating parent directories as needed. ALWAYS requires explicit user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path or ~/relative path to write to." },
          content: { type: "string", description: "Text content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
] as const;

const DANGEROUS_TOOLS = new Set(["run_shell", "write_file"]);

/* ── Tool execution ── */

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (raw != null && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file":
      return api.agentReadFile(String(args.path ?? ""));

    case "list_dir": {
      const entries = await api.agentListDir(String(args.path ?? ""));
      return JSON.stringify(entries, null, 2);
    }

    case "run_shell": {
      const r = await api.agentRunShell(String(args.command ?? ""));
      const parts: string[] = [];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      parts.push(`exit_code: ${r.exit_code}`);
      return parts.join("\n\n") || "(no output)";
    }

    case "write_file":
      await api.agentWriteFile(String(args.path ?? ""), String(args.content ?? ""));
      return `Successfully wrote to ${args.path}`;

    default:
      return `Unknown tool: ${name}`;
  }
}

/* ── Ollama message serialisation ── */

function toOllamaMessages(msgs: Message[]) {
  return msgs.map((m) => {
    if (m.role === "tool") {
      // Ollama tool result format
      return { role: "tool" as const, content: m.content };
    }
    if (m.tool_calls?.length) {
      return { role: "assistant" as const, content: m.content ?? "", tool_calls: m.tool_calls };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });
}

function makeTmpKey() {
  return `tmp:${crypto.randomUUID()}`;
}

/* ── Main loop ── */

/**
 * Runs the agentic tool-calling loop.
 * Returns the final assistant response text, or null if aborted / limit hit.
 */
export async function runAgentLoop(opts: AgentRunOptions): Promise<string | null> {
  const { model, onUpdate, onStatusChange, requestConfirmation, signal } = opts;
  const msgs: Message[] = [...opts.messages];

  // Inject agent system prompt at the front. If a system message already
  // exists (e.g. memory recall block), prepend so the agent prompt is read first.
  const sysMsg: Message = {
    conversation_id: opts.conversationId,
    role: "system",
    content: AGENT_SYSTEM_PROMPT,
  };
  msgs.unshift(sysMsg);

  onStatusChange("thinking");

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) return null;

    let data: Record<string, unknown>;
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: 0.4 },
          messages: toOllamaMessages(msgs),
          tools: TOOLS,
        }),
        signal,
      });
      if (!res.ok) {
        throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
      }
      data = await res.json() as Record<string, unknown>;
    } catch (e) {
      if (signal.aborted) return null;
      throw e;
    }

    const message = data?.message as Record<string, unknown> | undefined;
    if (!message) throw new Error("No message in Ollama response");

    const toolCalls = (message.tool_calls as ToolCall[] | undefined) ?? [];

    if (toolCalls.length === 0) {
      // Final text response
      const content = String(message.content ?? "");
      const finalMsg: Message = {
        _tmpKey: makeTmpKey(),
        conversation_id: opts.conversationId,
        role: "assistant",
        content,
      };
      msgs.push(finalMsg);
      onUpdate([...msgs]);
      onStatusChange("done");
      return content;
    }

    // Assistant turn with tool calls
    const asstMsg: Message = {
      _tmpKey: makeTmpKey(),
      conversation_id: opts.conversationId,
      role: "assistant",
      content: String(message.content ?? ""),
      tool_calls: toolCalls,
    };
    msgs.push(asstMsg);
    onUpdate([...msgs]);
    onStatusChange("tool");

    // Execute each tool call
    for (const tc of toolCalls) {
      if (signal.aborted) return null;

      const fnName = tc.function?.name ?? "";
      const args = parseArgs(tc.function?.arguments);

      if (DANGEROUS_TOOLS.has(fnName)) {
        const approved = await requestConfirmation(fnName, args);
        if (!approved) {
          msgs.push({
            _tmpKey: makeTmpKey(),
            conversation_id: opts.conversationId,
            role: "tool",
            content: "User denied this tool call.",
            tool_call_id: tc.id,
            tool_name: fnName,
          });
          onUpdate([...msgs]);
          continue;
        }
      }

      let result: string;
      try {
        result = await executeTool(fnName, args);
      } catch (e) {
        result = `Error: ${e}`;
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

  // Hit iteration cap
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
