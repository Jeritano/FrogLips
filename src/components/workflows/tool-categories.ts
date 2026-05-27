/**
 * Workflow card tool grouping. The CardForm tool picker is split into
 * collapsible categories so the user can grant whole capability buckets
 * (e.g. all Git, all Files-read) with one master checkbox click instead
 * of N individual checkbox clicks.
 *
 * Design contract:
 *   - `TOOL_CATEGORIES` is the single source of truth for groupings.
 *     Adding a tool to ALL_TOOLS in CardForm.tsx WITHOUT also placing
 *     it under a category here is a soft failure: the tool surfaces in
 *     the auto-generated "Other" bucket at the bottom of the picker
 *     instead of disappearing. Dev console warns so the contributor
 *     sees the categorize-me reminder.
 *   - A tool listed in two categories is a HARD failure at module
 *     init (throws in dev, console.error + first-wins in prod) — the
 *     master checkbox math is meaningless if a tool belongs to two
 *     groups.
 *   - A tool listed under a category but NOT in ALL_TOOLS (renamed +
 *     not updated) also asserts at module init.
 *
 * Stable category ids are used as localStorage keys for collapse-state
 * persistence; renaming a category id resets collapse state for users.
 */

/** Stable label + tool-list for one bucket. */
export interface ToolCategory {
  /** localStorage / collapse-state key. Don't rename without a migration. */
  id: string;
  /** User-facing group title. */
  label: string;
  /** Hover-tooltip explanation of what enabling the whole group means. */
  description: string;
  /** Tools that belong to this group. Order here is display order. */
  tools: readonly string[];
}

/**
 * The 10 explicit buckets. Order is render order — read-only-ish groups
 * first, then mutating, then exec/system, then ambient/interactive.
 * Within each group, tools are sorted to taste (most-used first when
 * obvious, otherwise alphabetical).
 */
export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    id: "fs-read",
    label: "Files (read)",
    description: "Inspect files and folders without modifying anything.",
    tools: [
      "read_file",
      "list_dir",
      "search_files",
      "file_exists",
      "diff_files",
      "hash_file",
      "read_pdf",
    ],
  },
  {
    id: "fs-write",
    label: "Files (write)",
    description: "Create, modify, move, and copy files.",
    tools: [
      "edit_file",
      "multi_edit",
      "write_file",
      "make_dir",
      "move_path",
      "copy_path",
    ],
  },
  {
    id: "git",
    label: "Git",
    description: "Read git state and create commits. Does NOT push.",
    tools: [
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "git_branches",
      "git_commit",
    ],
  },
  {
    id: "code-intel",
    label: "Code intel",
    description: "Navigate symbols, search project knowledge, format code.",
    tools: [
      "find_definition",
      "find_references",
      "format_code",
      "search_project_knowledge",
    ],
  },
  {
    id: "web",
    label: "Web",
    description: "Fetch URLs, run web searches, and make arbitrary HTTP requests.",
    tools: ["web_fetch", "web_search", "http_request"],
  },
  {
    id: "shell-system",
    label: "Shell + system",
    description:
      "Execute shell commands, AppleScript, launch apps, list processes, post notifications.",
    tools: [
      "run_shell",
      "applescript_run",
      "open_app",
      "show_notification",
      "list_processes",
    ],
  },
  {
    id: "watchers",
    label: "Watchers",
    description: "Watch the filesystem for changes and poll buffered events.",
    tools: ["watch_path", "poll_watch", "stop_watch", "list_watches"],
  },
  {
    id: "background-tasks",
    label: "Background tasks",
    description: "Fire-and-forget long shell jobs; poll status; list tasks.",
    tools: ["task_create", "task_status", "task_list"],
  },
  {
    id: "media",
    label: "Media",
    description: "Take screenshots, generate images, read/write clipboard.",
    tools: ["screenshot", "generate_image", "clipboard_get", "clipboard_set"],
  },
  {
    id: "interactive",
    label: "Interactive",
    description: "Round-trip to the human (ask_user dialog) mid-run.",
    tools: ["ask_user"],
  },
];

/** Stable id for the catch-all bucket. */
export const OTHER_CATEGORY_ID = "other";
export const OTHER_CATEGORY_LABEL = "Other";

/**
 * Derive `{ categorized: Set<string>, byTool: Map<string, categoryId> }`
 * once at module init so per-render lookups are O(1). Also runs the
 * duplicate + dangling-tool assertions.
 */
const { categorizedSet, toolToCategory } = (() => {
  const set = new Set<string>();
  const map = new Map<string, string>();
  for (const cat of TOOL_CATEGORIES) {
    for (const t of cat.tools) {
      if (map.has(t)) {
        const prev = map.get(t)!;
        const msg =
          `[tool-categories] '${t}' appears in both '${prev}' and ` +
          `'${cat.id}'. Master-checkbox math is undefined; remove one.`;
        if (import.meta.env.DEV) throw new Error(msg);
        // Prod: log + first-wins (don't reassign so consumers stay stable).
        console.error(msg);
        continue;
      }
      set.add(t);
      map.set(t, cat.id);
    }
  }
  return { categorizedSet: set, toolToCategory: map };
})();

/**
 * Compute the displayable groups for a given ALL_TOOLS list. The "Other"
 * bucket is appended ONLY when there are uncategorized tools to surface.
 *
 * In dev, also asserts every category tool exists in `allTools` (catches
 * renamed/removed entries that haven't propagated to the categories file).
 */
export function resolveToolGroups(
  allTools: readonly string[],
): readonly ToolCategory[] {
  if (import.meta.env.DEV) {
    const allSet = new Set(allTools);
    for (const cat of TOOL_CATEGORIES) {
      for (const t of cat.tools) {
        if (!allSet.has(t)) {
          console.error(
            `[tool-categories] '${t}' is listed under category ` +
              `'${cat.id}' but is missing from ALL_TOOLS. Either add it ` +
              `back to ALL_TOOLS or remove it from the category.`,
          );
        }
      }
    }
  }

  const otherTools = allTools.filter((t) => !categorizedSet.has(t));
  if (import.meta.env.DEV && otherTools.length > 0) {
    console.warn(
      `[tool-categories] ${otherTools.length} tool(s) not yet in any category — ` +
        `appearing under "Other":`,
      otherTools,
      "→ add to src/components/workflows/tool-categories.ts",
    );
  }
  if (otherTools.length === 0) return TOOL_CATEGORIES;
  return [
    ...TOOL_CATEGORIES,
    {
      id: OTHER_CATEGORY_ID,
      label: OTHER_CATEGORY_LABEL,
      description:
        "Tools not yet categorized. If you see this, a contributor added " +
        "a new tool without updating the category map — file an issue.",
      tools: otherTools,
    },
  ];
}

/** Lookup the category a tool belongs to. Returns null for "Other". */
export function categoryOf(tool: string): string | null {
  return toolToCategory.get(tool) ?? null;
}

/* ── Collapse-state persistence ────────────────────────────────────────── */

const COLLAPSE_KEY = "wf-tool-cat-collapsed-v1";

/** Per-category boolean: true = collapsed, false = expanded, missing =
 *  use rule-based default. Returned by `loadCollapseState`. */
export type CollapseMap = Record<string, boolean>;

export function loadCollapseState(): CollapseMap {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: CollapseMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "boolean") out[k] = v;
      }
      return out;
    }
  } catch {
    /* corrupted entry — fall through to empty map */
  }
  return {};
}

export function saveCollapseState(state: CollapseMap): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state));
  } catch {
    /* quota / disabled storage — collapse is purely cosmetic */
  }
}

/**
 * Default collapse state for a group given its current selection counts.
 * - All selected (count=total) → collapsed (no decision needed)
 * - None selected (count=0)    → collapsed (no decision needed)
 * - Mixed                      → expanded (user is mid-configuration)
 */
export function defaultCollapsed(selected: number, total: number): boolean {
  return selected === 0 || selected === total;
}

/* ── Master-checkbox tri-state helper ──────────────────────────────────── */

export type MasterState = "none" | "some" | "all";

export function masterStateOf(
  selected: readonly string[],
  groupTools: readonly string[],
): MasterState {
  if (groupTools.length === 0) return "none";
  let hits = 0;
  const selectedSet = new Set(selected);
  for (const t of groupTools) if (selectedSet.has(t)) hits++;
  if (hits === 0) return "none";
  if (hits === groupTools.length) return "all";
  return "some";
}

/**
 * Compute the new `draft.tools` after the user clicks a group master.
 * State machine:
 *   none → all   (add every group tool)
 *   some → all   (fill in missing — sensible "select all" semantic)
 *   all  → none  (clear every group tool)
 *
 * Preserves entries in `current` that are OUTSIDE this group (e.g. tools
 * from a different category, or unknown tools set via direct DB edit).
 */
export function applyMasterToggle(
  current: readonly string[],
  groupTools: readonly string[],
): string[] {
  const state = masterStateOf(current, groupTools);
  const groupSet = new Set(groupTools);
  if (state === "all") {
    // all → none: drop only this group's tools, keep everything else.
    return current.filter((t) => !groupSet.has(t));
  }
  // none → all or some → all: union of current + groupTools.
  const out = current.slice();
  const have = new Set(current);
  for (const t of groupTools) {
    if (!have.has(t)) {
      out.push(t);
      have.add(t);
    }
  }
  return out;
}
