/* ── OpenAI chat-completions message serializer ─────────────────────────────
 *
 * Shared by every OpenAI-compatible backend client (MLX `/v1/chat/completions`
 * AND the custom/OpenRouter cloud backend). Extracted from `mlx-client.ts` so
 * the two agent paths serialize messages identically — vision multi-content,
 * assistant tool_calls (with the string-arguments normalization the spec
 * requires), and `tool` role results all round-trip the same way.
 */

import type { Message } from "../types";

/** One message in the OpenAI chat-completions wire format. */
export type OpenAiMessage =
  | { role: string; content: string }
  | {
      role: "user";
      content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
    }
  | {
      role: "assistant";
      content: string;
      tool_calls: Array<{
        id?: string;
        type?: string;
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; content: string; tool_call_id?: string };

/** Serialise app messages into the OpenAI chat-completions wire format. */
export function toOpenAiMessages(messages: Message[]): OpenAiMessage[] {
  return messages.map((m): OpenAiMessage => {
    // Vision: OpenAI-compat endpoints accept the multi-content form. Use it
    // only when the user message actually carries images.
    if (m.role === "user" && m.images && m.images.length > 0) {
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const img of m.images) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${img.mime};base64,${img.base64}` },
        });
      }
      return { role: "user", content: parts };
    }
    // Assistant turn that issued tool calls — forward them so the server
    // can match the following `tool` messages to their requests. Normalize
    // `arguments` to a string: the OpenAI spec (which MLX's OpenAI-compatible
    // server enforces) defines it as string, and some models round-trip the
    // field as a parsed object which the server then rejects.
    if (m.tool_calls?.length) {
      const normalized = m.tool_calls.map((tc) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
        },
      }));
      return {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: normalized,
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
    }
    return { role: m.role, content: m.content };
  });
}
