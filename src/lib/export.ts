import type { Conversation, Message } from "../types";

function ts(unix?: number | null): string {
  if (!unix) return "";
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function conversationToMarkdown(conv: Conversation, messages: Message[]): string {
  const header = [
    `# ${conv.title}`,
    "",
    `- Conversation ID: ${conv.id}`,
    `- Created: ${ts(conv.created_at)}`,
    conv.model ? `- Model: \`${conv.model}\`` : "",
    `- Exported: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    "",
    "---",
    "",
  ].filter(Boolean).join("\n");

  const body = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const time = m.created_at ? ` _(${ts(m.created_at)})_` : "";
      const modelTag = m.role === "assistant" && m.model ? ` _[${m.model}]_` : "";
      if (m.role === "tool") {
        return `### Tool result — \`${m.tool_name ?? ""}\`${time}\n\n\`\`\`json\n${m.content}\n\`\`\``;
      }
      if (m.tool_calls?.length) {
        const calls = m.tool_calls.map((tc) => {
          const args = typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}, null, 2);
          return `**${tc.function?.name}**\n\`\`\`json\n${args}\n\`\`\``;
        }).join("\n\n");
        const prelude = m.content ? `${m.content}\n\n` : "";
        return `### Assistant${modelTag}${time}\n\n${prelude}${calls}`;
      }
      const label = m.role === "user" ? "User" : "Assistant";
      return `### ${label}${modelTag}${time}\n\n${m.content}`;
    })
    .join("\n\n---\n\n");

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

export function safeFilename(s: string, ext: string): string {
  const base = s.trim().replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60) || "conversation";
  return `${base}.${ext}`;
}
