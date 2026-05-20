import { TOOLS } from "./tools";

/* ── Dynamic system prompt ── */

export function buildSystemPrompt(
  workspaceRoot: string | null,
  allowlist: string[],
  override?: string,
): string {
  const tools = allowlist.length
    ? TOOLS.filter((t) => allowlist.includes(t.function.name)).map((t) => t.function.name)
    : TOOLS.map((t) => t.function.name);
  const ws = workspaceRoot
    ? `Workspace root: ${workspaceRoot} — all file access is confined to this directory.`
    : "No workspace root set — you have full filesystem access (within OS permissions).";
  const env = `${ws}\nHost OS: macOS (Darwin). Use macOS commands (e.g. \`open -a Safari https://example.com\`).\nAvailable tools: ${tools.join(", ")}`;
  if (override && override.trim()) {
    return `${override.trim()}\n\n${env}`;
  }
  return `You are an autonomous agent running on the user's local machine.

${env}

Rules:
1. When the user asks you to do something actionable (open an app, read files, run a command, modify files), CALL THE TOOLS. Don't describe what you would do.
2. You have full tool access — never claim you "can't".
3. Prefer edit_file over write_file for existing files (smaller, safer).
4. After each tool result (returned as JSON), inspect it before deciding the next step.
5. If a tool returns {"ok": false, "kind": "...", "message": "..."}, read the kind and adapt — e.g. on "not_found" try a different path, on "outside_workspace" stay in scope.
6. Only respond with prose when (a) you've completed the task and are reporting results, or (b) you genuinely need clarification.
7. Don't loop: if you've called the same tool with the same arguments twice, try a different approach.`;
}
