import type { Conversation, Message, ToolCall } from "../types";

export type ExportMode = "plain" | "detailed";

const TOOL_RESULT_LIMIT = 500;

function ts(unix?: number | null): string {
  if (!unix) return "";
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function truncate(s: string, limit = TOOL_RESULT_LIMIT): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + "... (truncated)";
}

function formatArgs(args: Record<string, unknown> | string | undefined): string {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") {
    // Try to pretty-print if it's valid JSON.
    try {
      const parsed = JSON.parse(args);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

/**
 * Pick a code fence (≥3 backticks) strictly longer than any backtick run in
 * `body`. Tool args/results routinely contain ``` (code, shell transcripts,
 * nested markdown); a fixed "```" fence would terminate early, spilling the
 * rest of the body as live markdown — a format-corruption / injection bug when
 * the export is rendered. A CommonMark fence longer than every inner run can't
 * be closed by the content.
 */
function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function renderToolDetails(call: ToolCall, result: Message | undefined): string {
  const name = call.function?.name ?? "tool";
  const args = formatArgs(call.function?.arguments);
  const resultBody = result?.content ?? "";
  const truncated = truncate(resultBody);
  // Accurate byte count (UTF-8), not UTF-16 code-unit length.
  const bytes = new TextEncoder().encode(resultBody).length;
  const resultLine = result
    ? `**Result** (${bytes} bytes):`
    : `**Result**: _(no response captured)_`;
  const argFence = fenceFor(args);
  const resFence = fenceFor(truncated);

  return [
    `<details>`,
    `<summary>🔧 ${name}</summary>`,
    ``,
    `**Args:**`,
    `${argFence}json`,
    args,
    argFence,
    ``,
    resultLine,
    resFence,
    truncated,
    resFence,
    ``,
    `</details>`,
  ].join("\n");
}

function renderPlain(messages: Message[]): string {
  return messages
    .filter((m) => m.role !== "system" && m.role !== "tool")
    .filter((m) => {
      // Drop assistant messages that are pure tool-call envelopes (no visible text)
      // in plain mode — keeps the output to user + assistant prose only.
      if (m.role === "assistant" && m.tool_calls?.length && !m.content?.trim()) {
        return false;
      }
      return true;
    })
    .map((m) => {
      const time = m.created_at ? ` _(${ts(m.created_at)})_` : "";
      const modelTag = m.role === "assistant" && m.model ? ` _[${m.model}]_` : "";
      const label = m.role === "user" ? "User" : "Assistant";
      return `### ${label}${modelTag}${time}\n\n${m.content}`;
    })
    .join("\n\n---\n\n");
}

function renderDetailed(messages: Message[]): string {
  // Build a quick lookup from tool_call_id -> tool message.
  const toolResultById = new Map<string, Message>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      toolResultById.set(m.tool_call_id, m);
    }
  }

  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") continue; // rendered inline inside the assistant turn

    const time = m.created_at ? ` _(${ts(m.created_at)})_` : "";

    if (m.role === "user") {
      blocks.push(`### User${time}\n\n${m.content}`);
      continue;
    }

    // assistant
    const modelTag = m.model ? ` _[${m.model}]_` : "";
    const parts: string[] = [`### Assistant${modelTag}${time}`];
    if (m.content && m.content.trim()) {
      parts.push("");
      parts.push(m.content);
    }
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const result = tc.id ? toolResultById.get(tc.id) : undefined;
        parts.push("");
        parts.push(renderToolDetails(tc, result));
      }
    }
    blocks.push(parts.join("\n"));
  }
  return blocks.join("\n\n---\n\n");
}

export function conversationToMarkdown(
  conv: Conversation,
  messages: Message[],
  mode: ExportMode = "plain",
): string {
  const header = [
    `# ${conv.title}`,
    "",
    `- Conversation ID: ${conv.id}`,
    `- Created: ${ts(conv.created_at)}`,
    conv.model ? `- Model: \`${conv.model}\`` : "",
    `- Exported: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    `- Mode: ${mode}`,
    "",
    "---",
    "",
  ].filter(Boolean).join("\n");

  const body = mode === "detailed" ? renderDetailed(messages) : renderPlain(messages);

  return `${header}${body}\n`;
}

export function downloadText(content: string, filename: string, mime = "text/markdown") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(s: string, ext: string, suffix?: string): string {
  const base = s.trim().replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60) || "conversation";
  const tail = suffix ? `-${suffix}` : "";
  return `${base}${tail}.${ext}`;
}
