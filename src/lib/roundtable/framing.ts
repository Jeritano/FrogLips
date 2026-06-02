/**
 * Speaker framing — the make-or-break mechanic. Each turn, the recipient model
 * gets (1) a SYSTEM message: its persona + table rules ("speak only as you,
 * one turn, don't write others' lines"), and (2) the prior transcript rendered
 * into ONE user message ("Conversation so far: …\nNow respond as <Name>.").
 * This transcript-in-one-user-message shape is the most robust across instruct
 * models — never role-swap others' turns to assistant (that causes identity
 * bleed). Plus a post-process guard that strips a leaked self-prefix and trims
 * a hijacked second speaker.
 */

import type { Message } from "../../types";
import type { RoundtableConfig, Seat, Turn } from "./types";

/** Render one transcript turn as `Speaker: text`. */
function renderTurn(t: Turn): string {
  const who = t.kind === "moderator" ? "Moderator" : t.kind === "director" ? "Director" : t.speaker;
  return `${who}: ${t.text.trim()}`;
}

/**
 * Select the slice of transcript a recipient sees. `full` = everything;
 * `recent` = the last `recentWindow` turns (shared across all seats so the
 * conversation stays coherent — see design v3-2). Summary of older turns is a
 * planned enhancement; v1 keeps it simple + honest (recent = a hard window).
 */
export function visibleTurns(config: RoundtableConfig, turns: Turn[]): Turn[] {
  const usable = turns.filter((t) => t.status === "done" && t.text.trim().length > 0);
  if (config.memoryMode === "full") return usable;
  const k = Math.max(1, config.recentWindow);
  return usable.slice(-k);
}

/** Build the system prompt for `seat` (persona + table rules). */
export function buildSystemPrompt(config: RoundtableConfig, seat: Seat): string {
  const others = config.seats
    .filter((s) => s.id !== seat.id)
    .map((s) => s.name)
    .join(", ");
  const self = seat.modelLabel && seat.modelLabel !== seat.name ? `${seat.name} (${seat.modelLabel})` : seat.name;
  const rules = [
    `You are ${self}, a participant in a live multi-model roundtable.`,
    others ? `Other participants: ${others}.` : `You are the sole participant.`,
    `Topic: ${config.topic.trim()}`,
    `Rules: Speak ONLY as ${seat.name}. Write exactly ONE turn — your own contribution to the discussion. Do NOT write other participants' lines, do NOT prefix your reply with your own name, do NOT narrate or stage-direct. Stay in character, be substantive and concise, and engage directly with what others actually said.`,
  ].join("\n");
  const persona = seat.system.trim();
  return persona ? `${rules}\n\n${persona}` : rules;
}

/**
 * Assemble the message array sent to `seat` for its next turn: a system
 * message + the visible transcript folded into one user message.
 * `conversationId` is a placeholder (the streaming clients require the field
 * on Message but only send role+content).
 */
export function buildMessages(
  config: RoundtableConfig,
  seat: Seat,
  turns: Turn[],
  conversationId = 0,
): Message[] {
  const visible = visibleTurns(config, turns);
  const transcript = visible.map(renderTurn).join("\n\n");
  const opener = visible.length === 0;
  const userBody = opener
    ? `You are opening the roundtable. Give your initial position on the topic, as ${seat.name}.`
    : `Conversation so far:\n\n${transcript}\n\nNow respond as ${seat.name}.`;
  return [
    { conversation_id: conversationId, role: "system", content: buildSystemPrompt(config, seat) },
    { conversation_id: conversationId, role: "user", content: userBody },
  ];
}

/** Escape a participant name for use in a RegExp character context. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clean a model's raw turn output:
 *  1. strip a leaked leading self-prefix (`Name:` at the very start),
 *  2. if the model rolled into ANOTHER participant's turn (`\nOther:` at a line
 *     start), trim from there — but only for a known participant name, and
 *     never the first line (so a model legitimately quoting "As X:" mid-content
 *     isn't truncated).
 * Conservative by design: when unsure, keep the text.
 */
export function sanitizeTurn(raw: string, seat: Seat, allSeats: Seat[]): string {
  let text = raw.trim();
  // 1. Strip a leading self-prefix the model added despite the rule.
  const selfRe = new RegExp(`^${escapeRe(seat.name)}\\s*:\\s*`, "i");
  text = text.replace(selfRe, "");

  // 2. Trim a hijacked second speaker. Build a name alternation of OTHER seats
  //    + the meta speakers, and cut at the first line that starts one.
  const names = [
    ...allSeats.filter((s) => s.id !== seat.id).map((s) => s.name),
    "Moderator",
    "Director",
  ].map(escapeRe);
  if (names.length === 0) return text.trim();
  const lines = text.split("\n");
  const speakerLine = new RegExp(`^\\s*(${names.join("|")})\\s*:`, "i");
  for (let i = 1; i < lines.length; i++) {
    if (speakerLine.test(lines[i])) {
      return lines.slice(0, i).join("\n").trim();
    }
  }
  return text.trim();
}
