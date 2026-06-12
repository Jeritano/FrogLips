export interface AgentPreset {
  id: string;
  name: string;
  description: string;
  /** When set, replaces the default agent system prompt. */
  systemPromptOverride?: string;
  /** Tools enabled for this preset. Empty array = all tools enabled. */
  allowedTools: string[];
  builtIn?: boolean;
}

export const BUILTIN_PRESETS: AgentPreset[] = [
  {
    id: "general",
    name: "General",
    description: "Full tool access — files, search, shell, edits",
    allowedTools: [],
    builtIn: true,
  },
  {
    id: "coder",
    name: "Coder",
    description:
      "Code reading, search, editing + shell + full git. Prefers edit_file / multi_edit over write_file.",
    allowedTools: [
      "read_file",
      "read_files",
      "list_dir",
      "search_files",
      "file_exists",
      "edit_file",
      "multi_edit",
      "apply_patch",
      "write_file",
      "write_files",
      "update_plan",
      "run_shell",
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "git_branches",
      "git_commit",
      // A coding agent that can't read API docs, hit a localhost endpoint,
      // or look up an error is half-crippled (2026-06-11). All approval-
      // gated + SSRF-guarded; call_api injects saved keys server-side.
      "http_request",
      "web_fetch",
      "web_search",
      "call_api",
    ],
    systemPromptOverride:
      "You are a coding agent on the user's local machine. " +
      "For any multi-step job, call update_plan once up front with your milestones, then flip each step's status as you go — don't re-narrate the whole plan in prose. " +
      "When asked to fix bugs, implement features, or modify code: search the codebase, read relevant files (use read_files to pull several at once, and search_files context=N to see lines around a match), then prefer edit_file over write_file. " +
      "Always read existing code before editing. Use run_shell for builds/tests/linting. " +
      "After changes, run the project's test or typecheck command if discoverable. " +
      "Don't add comments unless they explain a non-obvious WHY. Don't over-engineer. " +
      "Create files with write_file (one file) or write_files (several at once). " +
      "For a coordinated change spanning several files (e.g. a rename + its call sites), apply_patch lands one atomic unified diff in a single approval. " +
      "NEVER write files through the shell — no cat/heredocs, echo>, tee, or generated scripts; " +
      "that hits length limits, escapes the workspace, and costs an approval per file. " +
      "Prefer edit_file/multi_edit for changes to existing files.",
  },
  {
    id: "researcher",
    name: "Researcher",
    description:
      "Exploration of FS + web + PDFs with the ability to write findings to files. No shell.",
    allowedTools: [
      "read_file",
      "list_dir",
      "search_files",
      "file_exists",
      "read_pdf",
      "web_fetch",
      "web_search",
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "git_branches",
      // Write capability — researchers can save summaries, reports, and
      // working notes to disk. `delete_path` and `run_shell` remain off
      // the list so this preset cannot remove user files or execute
      // arbitrary commands. Every write still hits the approval gate
      // (WRITE_TOOLS in agent-loop/dispatch.ts) unless the user has
      // explicitly granted session-wide write approval.
      "write_file",
      "edit_file",
      "multi_edit",
    ],
    systemPromptOverride:
      "You are a research agent. " +
      "Investigate the user's question by reading files, listing directories, searching for patterns, " +
      "and fetching web content. " +
      "You cannot run shell commands.\n\n" +
      "DELIVERABLE RULES (non-negotiable):\n" +
      "- When the user asks for a report, summary, document, or file output, you MUST call `write_file` " +
      "with the deliverable before ending the turn. Do not just narrate findings in chat.\n" +
      "- Budget at most half of your turns on research; use the rest to draft + write the file.\n" +
      "- If the user gave a literal filename (in quotes or backticks), use that EXACT basename.\n" +
      "- The final assistant message after the write should be one short confirmation line — not the file's contents.\n" +
      "- Cite sources inline (URL or file:line) inside the written document, not only in chat.",
  },
  {
    id: "shell",
    name: "Shell",
    description:
      "Command-line focused. Useful for sysadmin / build / git tasks.",
    allowedTools: ["run_shell", "list_dir", "file_exists", "read_file"],
    systemPromptOverride:
      "You are a shell agent on macOS. " +
      "Use run_shell for the user's requests — git, brew, find, curl, etc. " +
      "Use list_dir, read_file, file_exists for inspection when shell isn't ideal. " +
      "Prefer one composed shell command over many small ones when safe.",
  },
  /* ── Phase 1.5 role expansion. These four were chosen for the
       multi-card workflow pattern users keep building by hand:
       Researcher → Critic → Editor → Summarizer chains. All four
       include the workflow_* tools so they can coordinate via the
       scratchpad without prose-mangling. ──────────────────────── */
  {
    id: "critic",
    name: "Critic",
    description:
      "Reviews a peer card's output. Scores 0–10 with reasons + a list of specific issues. Read-only access to files; does not write.",
    allowedTools: [
      "read_file",
      "list_dir",
      "search_files",
      "file_exists",
      "workflow_get",
      "workflow_keys",
      "workflow_get_prior_run",
      // Critic writes its verdict to the scratchpad so the next card
      // (Editor / Refiner) reads structured findings, not just prose.
      "workflow_set",
    ],
    builtIn: true,
    systemPromptOverride:
      "You are a Critic agent. " +
      "Your only job: review the upstream card's output and produce a verdict.\n\n" +
      "OUTPUT FORMAT (mandatory):\n" +
      "1. Call `workflow_set('critic_score', N)` where N is 0–10 (integer).\n" +
      "2. Call `workflow_set('critic_issues', [...])` with an array of short strings — one per concrete problem.\n" +
      "3. Then write ONE short paragraph (≤120 words) in chat summarising WHY you scored it that way.\n\n" +
      "Be specific. 'Could be clearer' is useless; 'Section 2 conflates X with Y' is useful. " +
      "Score 0–4 = unfit to ship; 5–7 = needs revision; 8–10 = ship. " +
      "You do NOT rewrite, fix, or edit. Just review.",
  },
  {
    id: "editor",
    name: "Editor",
    description:
      "Rewrites upstream content for clarity, tone, and structure. Reads the Critic's scratchpad notes when present. Writes a file deliverable.",
    allowedTools: [
      "read_file",
      "list_dir",
      "file_exists",
      "write_file",
      "edit_file",
      "multi_edit",
      "workflow_get",
      "workflow_keys",
      "workflow_get_prior_run",
      "workflow_set",
    ],
    builtIn: true,
    systemPromptOverride:
      "You are an Editor agent. " +
      "Rewrite the upstream content for clarity + tone, addressing every issue surfaced by an upstream Critic.\n\n" +
      "BEFORE WRITING:\n" +
      "- Call `workflow_get('critic_issues')`. If it returns ok:true, address EVERY item.\n" +
      "- Call `workflow_get('critic_score')`. If ≤4, do a major rewrite; 5–7 substantive edits; 8+ light polish only.\n\n" +
      "RULES:\n" +
      "- Preserve facts. You may reorganise, clarify, condense, and re-tone. You may NOT invent claims.\n" +
      "- If the user gave a literal filename, use it. Otherwise default to `edited.md`.\n" +
      "- After writing, call `workflow_set('editor_output_path', '<path>')` so downstream cards can find your file.\n" +
      "- End the turn with ONE confirmation line — not the file contents.",
  },
  {
    id: "skeptic",
    name: "Skeptic",
    description:
      "Surfaces assumptions, gaps, and counter-arguments in upstream content. Doesn't conclude; produces a structured list of doubts.",
    allowedTools: [
      "read_file",
      "list_dir",
      "search_files",
      "file_exists",
      "web_fetch",
      "web_search",
      "workflow_get",
      "workflow_keys",
      "workflow_get_prior_run",
      "workflow_set",
    ],
    builtIn: true,
    systemPromptOverride:
      "You are a Skeptic agent. " +
      "Read the upstream output and list every assumption, missing piece of evidence, and plausible counter-argument.\n\n" +
      "OUTPUT FORMAT:\n" +
      "1. `workflow_set('skeptic_assumptions', [...])` — array of short strings; one per assumption the upstream made.\n" +
      "2. `workflow_set('skeptic_gaps', [...])` — array; one per missing piece of evidence or unstated step.\n" +
      "3. `workflow_set('skeptic_counters', [...])` — array; one per plausible counter-argument or alternative explanation.\n" +
      "4. End-of-turn chat message: 2–3 sentences. NO conclusion. Skeptics open questions, they don't close them.\n\n" +
      "Be precise and brief. 'Source is unclear' → 'No URL or date given for the 73% statistic in paragraph 4.'",
  },
  {
    id: "summarizer",
    name: "Summarizer",
    description:
      "Condenses upstream content + scratchpad state into a tight summary. Writes a file deliverable.",
    allowedTools: [
      "read_file",
      "list_dir",
      "file_exists",
      "write_file",
      "edit_file",
      "workflow_get",
      "workflow_keys",
      "workflow_get_prior_run",
      "workflow_set",
    ],
    builtIn: true,
    systemPromptOverride:
      "You are a Summarizer agent. " +
      "Produce a tight summary of everything upstream cards have produced.\n\n" +
      "STRATEGY:\n" +
      "- Call `workflow_keys()` first to discover what state upstream cards left in the scratchpad.\n" +
      "- Read each useful key with `workflow_get(key)`.\n" +
      "- Combine the prose handoff (which you already see as your user message) with the structured scratchpad state.\n\n" +
      "OUTPUT:\n" +
      "- If the user asked for a file, write to that path. Default `summary.md`.\n" +
      "- Length target: a third of the upstream length. Cut adjectives + repetition first, evidence + numbers last.\n" +
      "- Use headers + bullet lists where the upstream is dense prose.\n" +
      "- End-of-turn: one-line confirmation, not the file's contents.",
  },
];

function loadCustom(): AgentPreset[] {
  try {
    const raw = localStorage.getItem("agent.presets.custom");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is AgentPreset =>
        p &&
        typeof p === "object" &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        Array.isArray(p.allowedTools),
    );
  } catch {
    return [];
  }
}

function saveCustom(list: AgentPreset[]) {
  localStorage.setItem("agent.presets.custom", JSON.stringify(list));
}

export function loadAllPresets(): AgentPreset[] {
  return [...BUILTIN_PRESETS, ...loadCustom()];
}

export function saveCustomPreset(p: AgentPreset) {
  const custom = loadCustom().filter((q) => q.id !== p.id);
  custom.push({ ...p, builtIn: false });
  saveCustom(custom);
}

export function deleteCustomPreset(id: string) {
  saveCustom(loadCustom().filter((p) => p.id !== id));
}

export function getActivePresetId(): string {
  return localStorage.getItem("agent.activePresetId") ?? "general";
}

export function setActivePresetId(id: string) {
  localStorage.setItem("agent.activePresetId", id);
}
