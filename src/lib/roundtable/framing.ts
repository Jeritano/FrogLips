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
  const original = raw.trim();
  let text = original;
  // 1. Strip a leading self-prefix the model added despite the rule.
  const selfRe = new RegExp(`^${escapeRe(seat.name)}\\s*:\\s*`, "i");
  text = text.replace(selfRe, "");

  // 2. Trim a hijacked second speaker. Alternation of OTHER seats + the meta
  //    speakers, sorted LONGEST-first so a short name that is a prefix of a
  //    longer one ("Adversary" vs "Adversary X") can't match inside it. Only
  //    cut at a genuine TURN BOUNDARY — a speaker label that opens a paragraph
  //    (preceded by a blank line) — so a mid-sentence vocative addressing
  //    another participant ("The Proposer: you assume adoption is linear…") is
  //    NOT mistaken for a hijack and deleted.
  const names = [
    ...allSeats.filter((s) => s.id !== seat.id).map((s) => s.name),
    "Moderator",
    "Director",
  ]
    .filter((n) => n.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  if (names.length > 0) {
    const lines = text.split("\n");
    const speakerLine = new RegExp(`^\\s*(${names.join("|")})\\s*:`, "i");
    for (let i = 1; i < lines.length; i++) {
      if (!speakerLine.test(lines[i])) continue;
      const afterColon = lines[i].slice(lines[i].indexOf(":") + 1).trim();
      // A real hijack = the model writing ANOTHER speaker's turn: either a new
      // paragraph block (blank line before) or a fresh capitalized/quoted
      // sentence after the label ("Optimist: But consider…"). A mid-sentence
      // vocative that merely addresses a participant ("The Proposer: you
      // assume…") continues in lowercase/second-person → keep it.
      const boundary = lines[i - 1].trim() === "";
      const newSentence = /^["“(A-Z]/.test(afterColon);
      if (boundary || newSentence) {
        text = lines.slice(0, i).join("\n");
        break;
      }
    }
  }

  // Never let sanitization MANUFACTURE an empty turn. If our strips ate
  // everything, the model genuinely produced content — keep the original.
  // The engine's "empty response" must mean the MODEL returned nothing, not a
  // sanitize artifact (the cause of real replies showing as "empty response").
  const cleaned = text.trim();
  return cleaned.length > 0 ? cleaned : original;
}
