import { api } from "./tauri-api";
import { streamChat } from "./mlx-client";
import { streamNativeChat } from "./native-client";
import { logDiag } from "./diagnostics";
import { estimateMessagesTokens } from "./agent-loop/context-manager";
import { resolveContextTokens } from "./model-context-lookup";
import type { Conversation, Message, ServerStatus } from "../types";

/**
 * Auto-continue: when a conversation's context window fills up, summarize the
 * prior history into a single dense paragraph and seed a fresh conversation
 * with that summary so the dialogue can keep going without the model silently
 * dropping the head of the thread.
 *
 * Two pieces:
 *  - `shouldAutoContinue` — pure check the chat surface polls per render.
 *  - `runContinuation` — runs a one-shot summary call against the active
 *    backend, creates the new conversation, persists the summary as both a
 *    system message and the conv's `system_prompt` parameter.
 *
 * The summary uses the same model the user is already chatting with so we
 * don't need a second loaded model, and respects the active backend's
 * streaming pipeline.
 */

/** Fraction of the model context window we consider "near full". */
export const AUTO_CONTINUE_THRESHOLD = 0.85;

/** Fraction of context used by `messages` against the model's window (0..1+). */
export function usageFraction(
  messages: Message[],
  model: string | null,
  status: ServerStatus | null = null,
): number {
  const total = resolveContextTokens(model, status);
  if (total <= 0) return 0;
  return estimateMessagesTokens(messages) / total;
}

/** True when context use has hit `threshold` and the conv should roll over. */
export function shouldAutoContinue(
  messages: Message[],
  model: string | null,
  status: ServerStatus | null = null,
  threshold = AUTO_CONTINUE_THRESHOLD,
): boolean {
  // Need real content to summarize; a one-or-two-turn conv shouldn't roll
  // even if it somehow tripped the threshold via a giant single message.
  if (messages.length < 4) return false;
  return usageFraction(messages, model, status) >= threshold;
}

const SUMMARY_SYSTEM_PROMPT =
  "You are summarizing a chat so it can continue in a new thread without losing context. " +
  "Output ONLY the summary as plain prose — no preamble, no headings, no markdown. " +
  "Preserve: the user's goal, named entities, decisions taken, code and files referenced, " +
  "unresolved questions, and any data the user shared. " +
  "Use at most 400 words, written as one or two dense paragraphs, third-person.";

/** Render the chat history as a single user-block for the summarizer call. */
function flattenHistory(messages: Message[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`)
    .join("\n\n");
}

/** One-shot summary across the active backend. Returns the summary text. */
export async function summarizeConversation(
  messages: Message[],
  status: ServerStatus,
  signal: AbortSignal,
): Promise<string> {
  const summaryMessages: Message[] = [
    { conversation_id: 0, role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { conversation_id: 0, role: "user", content: flattenHistory(messages) },
  ];

  if (status.backend === "ollama") {
    const res = await fetch(`http://${status.host}:${status.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: status.model,
        stream: false,
        messages: summaryMessages.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ollama summary failed (${res.status}): ${detail}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return (json.message?.content ?? "").trim();
  }

  if (status.backend === "mlx") {
    let out = "";
    for await (const c of streamChat(status, summaryMessages, { maxTokens: 700, signal })) {
      out += c.delta;
      if (c.done) break;
    }
    return out.trim();
  }

  if (status.backend === "native") {
    let out = "";
    for await (const c of streamNativeChat(summaryMessages, { maxTokens: 700, signal })) {
      out += c.delta;
      if (c.done) break;
    }
    return out.trim();
  }

  throw new Error(`auto-continue: backend "${status.backend}" not supported`);
}

/**
 * Create a fresh conversation seeded with the summary so the dialogue keeps
 * its head when the user types into the new thread. The summary is persisted
 * as both (a) a system message in the new conv's history (so it shows in the
 * scrollback) and (b) the conv's `system_prompt` parameter (so it is
 * re-injected on every backend turn). Returns the new conversation id.
 */
export async function createContinuationConv(
  previous: Conversation,
  summary: string,
  model: string,
): Promise<number> {
  const baseTitle = previous.title?.trim() || "New chat";
  // Don't stack "Continued: Continued: …" prefixes forever.
  const title = baseTitle.startsWith("Continued: ")
    ? baseTitle
    : `Continued: ${baseTitle}`;
  const newId = await api.createConversation(title, model);
  await api.addMessage(newId, "system", summary, model);
  await api.updateConversationParams(
    newId,
    JSON.stringify({ system_prompt: `Earlier conversation summary:\n${summary}` }),
  );
  logDiag({
    level: "info",
    source: "auto-continue",
    message: `created continuation conv ${newId} from ${previous.id}`,
  });
  return newId;
}

/**
 * High-level "roll the conversation" entry point used by the banner UI.
 * Returns the id of the new conversation; callers switch the active
 * conversation to it.
 */
export async function runContinuation(
  previous: Conversation,
  messages: Message[],
  status: ServerStatus,
  signal: AbortSignal,
): Promise<number> {
  if (!status.model) {
    throw new Error("auto-continue: no active model");
  }
  const summary = await summarizeConversation(messages, status, signal);
  if (!summary || summary.length < 20) {
    throw new Error("auto-continue: empty / too-short summary from model");
  }
  return createContinuationConv(previous, summary, status.model);
}
