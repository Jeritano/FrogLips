import { TOOLS } from "./tools";
import type { OpenAIToolDef } from "./mcp-tools";
import type { ToolFitness } from "../model-capabilities";

/* ── Dynamic system prompt ── */

/** Max characters of an MCP tool description allowed into the system prompt. */
const MCP_DESC_MAX = 300;

// Bidi / zero-width / control characters an MCP description could use to hide
// injected instructions inside the most-trusted context (the system prompt).
const MCP_DESC_STRIP = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F" +
    "\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069" +
    // JS line terminators that survive a `[\r\n]+` collapse — without these,
    // an MCP-supplied description can embed a real newline-equivalent the
    // host parser treats as a line break, smuggling fake "system rules"
    // into the prompt.
    "\\u2028\\u2029" +
    "\\uFEFF]",
  "g",
);

/**
 * Sanitize an MCP-server-supplied tool description before it is embedded in
 * the system prompt: strip control/bidi/zero-width chars, collapse newlines
 * (so it cannot inject multi-line fake instructions), and length-cap it.
 */
function sanitizeMcpDescription(desc: string): string {
  const flat = desc
    .replace(MCP_DESC_STRIP, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > MCP_DESC_MAX ? `${flat.slice(0, MCP_DESC_MAX)}…` : flat;
}

export function buildSystemPrompt(
  workspaceRoot: string | null,
  allowlist: string[],
  override?: string,
  mcpTools: OpenAIToolDef[] = [],
  modelFitness?: ToolFitness,
): string {
  // Weak tool-callers (small/abliterated models) tend to narrate or emit
  // near-JSON. A short, explicit format reminder measurably lifts their
  // tool-call success rate without bloating the prompt for capable models.
  const weakBlock =
    modelFitness === "weak"
      ? "\n\nTOOL-CALL FORMAT (important for this model): when you act, CALL the tool — do not describe the call in prose. Emit `arguments` as ONE valid JSON object: double quotes on every key and string value, no trailing commas, no markdown ``` fences, no text before or after the JSON."
      : "";
  // Built-in tools the model may call, filtered by the active allowlist.
  const builtIn = allowlist.length
    ? TOOLS.filter((t) => allowlist.includes(t.function.name)).map((t) => t.function.name)
    : TOOLS.map((t) => t.function.name);
  // MCP tools are subject to the same allowlist; when one is callable the
  // model must be told it exists, with a one-line description so it knows
  // when to reach for it.
  const mcp = (allowlist.length
    ? mcpTools.filter((t) => allowlist.includes(t.function.name))
    : mcpTools
  ).map((t) => `${t.function.name} — ${sanitizeMcpDescription(t.function.description ?? "")}`);
  const ws = workspaceRoot
    ? `Workspace root: ${workspaceRoot} — all file access is confined to this directory.`
    : "No workspace root set — you have full filesystem access (within OS permissions).";
  const mcpBlock = mcp.length ? `\nMCP tools: ${mcp.join("; ")}` : "";
  // Inject the real wall-clock so the model doesn't fabricate dates from
  // its training-data cutoff. Without this an agent asked to write a
  // "summary for the last 48 hours" picks the year it saw most often in
  // training, names files `Summary_July2025.md` in 2026, and produces
  // queries scoped to the wrong window. ISO 8601 with timezone offset
  // keeps the format unambiguous; the locale string is added for
  // human-friendly natural-language references.
  const now = new Date();
  const isoNow = now.toISOString();
  const localeNow = now.toString();
  const dateBlock = `Current date/time: ${isoNow} (${localeNow}). Use THIS date for any filename, query, or relative-time reference — do not rely on your training-data cutoff.`;
  // Anchor common-shorthand locations so the model doesn't drop the prefix
  // and write to $HOME by accident. Same idea covers `Documents/`,
  // `Downloads/`, etc. — the model otherwise frequently strips path
  // prefixes when the user phrases the location in natural language
  // ("place a file on the desktop" → `~/Filename.md` instead of
  // `~/Desktop/Filename.md`).
  const paths =
    "Path conventions:\n" +
    "- \"desktop\" / \"on my desktop\" → write to `~/Desktop/`\n" +
    "- \"documents\" → write to `~/Documents/`\n" +
    "- \"downloads\" → write to `~/Downloads/`\n" +
    "- Honour an explicit file extension verbatim (`.txt` stays `.txt`, do not silently upgrade to `.md`).\n" +
    "- When the user gives a filename in quotes, backticks, or as a literal token (e.g. \"DemReport\", `report.txt`, file named X), use that EXACT name as the basename. Do NOT paraphrase, expand, prefix with dates, or rewrite it. Only add the extension if one wasn't supplied AND the format is implied.";
  const env = `${ws}\n${dateBlock}\nHost OS: macOS (Darwin). Use macOS commands (e.g. \`open -a Safari https://example.com\`).\n${paths}\nAvailable tools: ${builtIn.join(", ")}${mcpBlock}`;
  if (override && override.trim()) {
    return `${override.trim()}\n\n${env}${weakBlock}`;
  }
  return (
    `You are an autonomous agent running on the user's local machine.

${env}

Rules:
1. When the user asks you to do something actionable (open an app, read files, run a command, modify files), CALL THE TOOLS. Don't describe what you would do.
2. You have full tool access — never claim you "can't".
3. Prefer edit_file over write_file for existing files (smaller, safer).
4. After each tool result (returned as JSON), inspect it before deciding the next step.
5. If a tool returns {"ok": false, "kind": "...", "message": "..."}, read the kind and adapt — e.g. on "not_found" try a different path, on "outside_workspace" stay in scope.
6. Only respond with prose when (a) you've completed the task and are reporting results, or (b) you genuinely need clarification.
7. Don't loop: if you've called the same tool with the same arguments twice, try a different approach.
8. \`web_fetch\` returns raw HTML — it does NOT execute JavaScript. Modern sites (weather.com, twitter.com, reddit.com, most React/Next.js sites) render content client-side, so fetching them yields a near-empty SPA shell with no real data. Prefer JSON-emitting endpoints when they exist:
   • Weather (any city): \`https://wttr.in/<city>?format=j1\` (or \`?format=3\` for one-line).
   • US weather: \`https://api.weather.gov/points/<lat>,<lon>\` then the \`forecast\` URL from that response.
   • GitHub: \`https://api.github.com/...\`.
   • HackerNews: \`https://hacker-news.firebaseio.com/v0/...\`.
   • Most large sites publish an \`/api/...\` or \`/.well-known/...\` JSON endpoint — try it before scraping.
   If web_fetch returns a body dominated by nav links, script tags, or \`<div id="__next">\` boilerplate, the page is JS-rendered: switch to a JSON source, hit a different domain, or use \`web_search\` snippets for the actual data.` +
    weakBlock
  );
}
