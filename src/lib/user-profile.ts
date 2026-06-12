import type { UserProfile } from "../types";

/**
 * "About You" — the explicit, user-authored identity profile.
 *
 * `formatUserProfile` turns a {@link UserProfile} into a single system-prompt
 * block injected into every chat and workflow-agent run, so the model knows
 * who it is talking to. It is the only consumer-facing entry point: both the
 * chat path (`useChatSend`) and the workflow runner call it.
 */

/** Per-field display caps — a second belt to the Rust-side byte caps. */
const SHORT_MAX = 200;
const LONG_MAX = 2048;

function clean(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

/**
 * Render the profile as a system-prompt block, or `null` when there is
 * nothing usable to inject (disabled, or every field blank).
 *
 * The block is explicitly framed as user-supplied context and tells the model
 * not to parrot it back — matching how ChatGPT/Claude surface custom
 * instructions.
 */
export function formatUserProfile(
  profile: UserProfile | null | undefined,
): string | null {
  if (!profile || !profile.enabled) return null;

  const name = clean(profile.name, SHORT_MAX);
  const occupation = clean(profile.occupation, SHORT_MAX);
  const location = clean(profile.location, SHORT_MAX);
  // `about` / `response_style` may legitimately contain newlines; only cap.
  const about = (profile.about ?? "").trim().slice(0, LONG_MAX);
  const responseStyle = (profile.response_style ?? "")
    .trim()
    .slice(0, LONG_MAX);

  const facts: string[] = [];
  if (name) facts.push(`- Name: ${name}`);
  if (occupation) facts.push(`- Occupation: ${occupation}`);
  if (location) facts.push(`- Location: ${location}`);
  if (about) facts.push(`- About them: ${about}`);

  if (facts.length === 0 && !responseStyle) return null;

  const lines = [
    "The person using this app has provided the following profile about themselves. " +
      "Use it to tailor your responses; do not repeat it back to them unprompted.",
  ];
  if (facts.length > 0) lines.push("", ...facts);
  if (responseStyle) {
    lines.push("", `How they want you to respond: ${responseStyle}`);
  }
  return lines.join("\n");
}
