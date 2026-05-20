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
    description: "Code reading, search, editing + shell. Prefers edit_file over write_file.",
    allowedTools: [
      "read_file",
      "list_dir",
      "search_files",
      "file_exists",
      "edit_file",
      "write_file",
      "run_shell",
    ],
    systemPromptOverride:
      "You are a coding agent on the user's local machine. " +
      "When asked to fix bugs, implement features, or modify code: search the codebase, read relevant files, then prefer edit_file over write_file. " +
      "Always read existing code before editing. Use run_shell for builds/tests/linting. " +
      "After changes, run the project's test or typecheck command if discoverable. " +
      "Don't add comments unless they explain a non-obvious WHY. Don't over-engineer.",
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Read-only exploration. No shell, no writes.",
    allowedTools: ["read_file", "list_dir", "search_files", "file_exists"],
    systemPromptOverride:
      "You are a read-only research agent. " +
      "Investigate the user's question by reading files, listing directories, and searching for patterns. " +
      "You cannot run commands or modify anything — report findings as prose with file:line citations.",
  },
  {
    id: "shell",
    name: "Shell",
    description: "Command-line focused. Useful for sysadmin / build / git tasks.",
    allowedTools: ["run_shell", "list_dir", "file_exists", "read_file"],
    systemPromptOverride:
      "You are a shell agent on macOS. " +
      "Use run_shell for the user's requests — git, brew, find, curl, etc. " +
      "Use list_dir, read_file, file_exists for inspection when shell isn't ideal. " +
      "Prefer one composed shell command over many small ones when safe.",
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
        p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string" &&
        Array.isArray(p.allowedTools),
    );
  } catch { return []; }
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
