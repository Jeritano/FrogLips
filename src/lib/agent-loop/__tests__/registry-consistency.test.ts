import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REGISTRY_BY_NAME,
  TOOL_REGISTRY,
  type ToolDescriptor,
} from "../tool-registry";
import { TOOLS } from "../tools";
import {
  DANGEROUS_TOOLS,
  IRREVERSIBLE_TOOLS,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from "../dispatch";
import { DRY_RUN_READ_ONLY, DRY_RUN_TOOLS } from "../dry-run";
import {
  ADVANCED_ALLOWED_TOOLS,
  ADVANCED_FORBIDDEN_TOOLS,
  CURATED_TOOLS_FOR_ROLE,
} from "../../workflow/create-flow";
import { TOOL_CATEGORIES } from "../../../components/workflows/tool-categories";

/**
 * PARITY / TRIPWIRE test for the tool-registry consolidation.
 *
 * The classifier Sets ARE the danger gate. They are now DERIVED from
 * TOOL_REGISTRY, so a wrong descriptor flag would silently change a security
 * boundary. Each Set is pinned below against a FROZEN literal snapshot copied
 * verbatim from the pre-refactor source (dispatch.ts / dry-run.ts). Order is
 * irrelevant for the Sets (compared as sorted arrays); for the wire `TOOLS`
 * array, ORDER is asserted exactly.
 *
 * Plus cross-language join-target assertions: every descriptor's rustCommand
 * must be a registered Tauri command, and every approval binding must have a
 * matching `binding_for` arm in commands/agent.rs.
 */

// ── Frozen literal snapshots (copied verbatim from the original files) ────────

// tools.ts — original TOOLS order (77 entries).
const FROZEN_TOOLS_ORDER = [
  "read_file",
  "read_files",
  "list_dir",
  "search_files",
  "multi_edit",
  "git_status",
  "git_diff",
  "file_exists",
  "run_shell",
  "run_code",
  "calculate",
  "remember",
  "recall_memory",
  "write_file",
  "write_files",
  "apply_patch",
  "update_plan",
  "edit_file",
  "git_log",
  "git_show",
  "git_branches",
  "git_commit",
  "web_fetch",
  "web_search",
  "read_pdf",
  "screenshot",
  "clipboard_get",
  "clipboard_set",
  "open_app",
  "show_notification",
  "applescript_run",
  "http_request",
  "call_api",
  "find_definition",
  "find_references",
  "format_code",
  "task_create",
  "task_status",
  "task_list",
  "task_cancel",
  "ask_user",
  "watch_path",
  "poll_watch",
  "stop_watch",
  "list_watches",
  "browser_navigate",
  "browser_click",
  "browser_fill",
  "browser_screenshot",
  "browser_get_text",
  "browser_close",
  "search_project_knowledge",
  "spawn_subagent",
  "await_subagents",
  "list_subagents",
  "move_path",
  "copy_path",
  "delete_path",
  "make_dir",
  "hash_file",
  "diff_files",
  "list_processes",
  "kill_process",
  "agent_undo",
  "list_undo",
  "create_flow",
  "workflow_set",
  "workflow_get",
  "workflow_keys",
  "workflow_get_prior_run",
  "workflow_save_skill",
  "workflow_list_skills",
  "workflow_get_skill",
  "workflow_invoke_skill",
  "workflow_delete_skill",
  "list_claude_skills",
  "load_claude_skill",
];

// dispatch.ts:19 — DANGEROUS_TOOLS.
const FROZEN_DANGEROUS_TOOLS = [
  "run_shell",
  "task_create",
  "write_file",
  "write_files",
  "apply_patch",
  "edit_file",
  "multi_edit",
  "git_commit",
  "clipboard_set",
  "open_app",
  "applescript_run",
  "http_request",
  "call_api",
  "run_code",
  "spawn_subagent",
  "browser_navigate",
  "browser_click",
  "browser_fill",
  "browser_screenshot",
  "browser_get_text",
  "browser_close",
  "move_path",
  "copy_path",
  "delete_path",
  "make_dir",
  "kill_process",
  "agent_undo",
  "format_code",
  "screenshot",
  "show_notification",
  "create_flow",
  "remember",
  "watch_path",
  "stop_watch",
  "task_cancel",
];

// dispatch.ts:95 — WRITE_TOOLS.
const FROZEN_WRITE_TOOLS = [
  "write_file",
  "edit_file",
  "multi_edit",
  "git_commit",
  "clipboard_set",
  "applescript_run",
  "http_request",
  "move_path",
  "copy_path",
  "make_dir",
  "format_code",
];

// dispatch.ts:123 — IRREVERSIBLE_TOOLS.
const FROZEN_IRREVERSIBLE_TOOLS = ["delete_path", "kill_process", "agent_undo"];

// dispatch.ts:2154 — READ_ONLY_TOOLS (cacheableRead).
const FROZEN_READ_ONLY_TOOLS = [
  "read_file",
  "read_files",
  "list_dir",
  "file_exists",
  "search_files",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branches",
  "hash_file",
  "diff_files",
  "find_definition",
  "find_references",
  "list_claude_skills",
  "load_claude_skill",
];

// dry-run.ts:19 — DRY_RUN_TOOLS.
const FROZEN_DRY_RUN_TOOLS = [
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "run_shell",
  "applescript_run",
  "browser_navigate",
  "browser_click",
  "browser_fill",
];

// dry-run.ts:45 — DRY_RUN_READ_ONLY.
const FROZEN_DRY_RUN_READ_ONLY = [
  "read_file",
  "read_files",
  "list_dir",
  "search_files",
  "file_exists",
  "update_plan",
  "hash_file",
  "diff_files",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branches",
  "web_fetch",
  "web_search",
  "read_pdf",
  "clipboard_get",
  "find_definition",
  "find_references",
  "calculate",
  "recall_memory",
  "search_project_knowledge",
  "list_processes",
  "list_undo",
  "task_status",
  "task_list",
  "list_watches",
  "poll_watch",
  "ask_user",
  "workflow_get",
  "workflow_keys",
  "workflow_get_prior_run",
  "workflow_list_skills",
  "workflow_get_skill",
  "list_claude_skills",
  "load_claude_skill",
];

const sorted = (xs: Iterable<string>) => [...xs].slice().sort();

describe("tool-registry: structural invariants", () => {
  it("has 77 descriptors with unique names", () => {
    expect(TOOL_REGISTRY.length).toBe(77);
    const names = TOOL_REGISTRY.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("REGISTRY_BY_NAME indexes every descriptor", () => {
    expect(REGISTRY_BY_NAME.size).toBe(TOOL_REGISTRY.length);
    for (const d of TOOL_REGISTRY) {
      expect(REGISTRY_BY_NAME.get(d.name)).toBe(d);
    }
  });

  it("every non-runner-special descriptor has a handler.run", () => {
    for (const d of TOOL_REGISTRY) {
      if (d.handler.kind === "runner-special") {
        expect(d.handler.run, `${d.name} should have no run`).toBeUndefined();
      } else {
        expect(typeof d.handler.run, `${d.name} missing run`).toBe("function");
      }
    }
  });

  it("runner-special tools are exactly the subagent trio", () => {
    const special = TOOL_REGISTRY.filter(
      (d) => d.handler.kind === "runner-special",
    ).map((d) => d.name);
    expect(special.slice().sort()).toEqual(
      ["await_subagents", "list_subagents", "spawn_subagent"].sort(),
    );
  });

  it("irreversible flag implies dangerous; writeTool excludes irreversible", () => {
    for (const d of TOOL_REGISTRY) {
      if (d.irreversible) expect(d.dangerous, `${d.name}`).toBe(true);
      if (d.writeTool) expect(d.irreversible, `${d.name}`).toBe(false);
    }
  });
});

describe("TOOLS wire array derives from the registry (order-exact)", () => {
  it("matches the frozen TOOLS order verbatim", () => {
    expect(TOOLS.map((t) => t.function.name)).toEqual(FROZEN_TOOLS_ORDER);
  });

  it("registry order equals frozen order", () => {
    expect(TOOL_REGISTRY.map((d) => d.name)).toEqual(FROZEN_TOOLS_ORDER);
  });

  it("each TOOLS entry mirrors its descriptor schema", () => {
    for (const t of TOOLS) {
      const d = REGISTRY_BY_NAME.get(t.function.name)!;
      expect(t.type).toBe("function");
      expect(t.function.description).toBe(d.schema.description);
      expect(t.function.parameters).toBe(d.schema.parameters);
    }
  });
});

describe("classifier Sets derive correctly (PARITY with frozen literals)", () => {
  it("DANGEROUS_TOOLS", () => {
    expect(sorted(DANGEROUS_TOOLS)).toEqual(sorted(FROZEN_DANGEROUS_TOOLS));
  });
  it("WRITE_TOOLS", () => {
    expect(sorted(WRITE_TOOLS)).toEqual(sorted(FROZEN_WRITE_TOOLS));
  });
  it("IRREVERSIBLE_TOOLS", () => {
    expect(sorted(IRREVERSIBLE_TOOLS)).toEqual(
      sorted(FROZEN_IRREVERSIBLE_TOOLS),
    );
  });
  it("READ_ONLY_TOOLS (cacheableRead)", () => {
    expect(sorted(READ_ONLY_TOOLS)).toEqual(sorted(FROZEN_READ_ONLY_TOOLS));
  });
  it("DRY_RUN_TOOLS", () => {
    expect(sorted(DRY_RUN_TOOLS)).toEqual(sorted(FROZEN_DRY_RUN_TOOLS));
  });
  it("DRY_RUN_READ_ONLY", () => {
    expect(sorted(DRY_RUN_READ_ONLY)).toEqual(sorted(FROZEN_DRY_RUN_READ_ONLY));
  });

  it("non-cacheable reads stay EXCLUDED from READ_ONLY_TOOLS", () => {
    // These are reads but deliberately NON-cacheable (real-time state).
    for (const t of [
      "list_processes",
      "list_undo",
      "recall_memory",
      "search_project_knowledge",
    ]) {
      expect(READ_ONLY_TOOLS.has(t), `${t} must not be cacheable`).toBe(false);
    }
  });
});

// ── Cross-language join-target assertions (Rust is a read-only join target) ──

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const libRs = readFileSync(
  resolve(repoRoot, "src-tauri/src/lib.rs"),
  "utf8",
);
const agentRs = readFileSync(
  resolve(repoRoot, "src-tauri/src/commands/agent.rs"),
  "utf8",
);

/** Registered Tauri command idents inside `generate_handler![ ... ]`. */
function registeredHandlers(): Set<string> {
  const m = libRs.indexOf("generate_handler![");
  const end = libRs.indexOf("])", m);
  const block = libRs.slice(m, end);
  const out = new Set<string>();
  for (const match of block.matchAll(/::([a-z0-9_]+)\s*,/g)) out.add(match[1]);
  return out;
}

/** Quoted command names inside `binding_for(...)`'s match body. */
function bindingForArms(): Set<string> {
  const start = agentRs.indexOf("pub(crate) fn binding_for");
  const end = agentRs.indexOf("_ => None,", start);
  const body = agentRs.slice(start, end);
  const out = new Set<string>();
  for (const match of body.matchAll(/"([a-z0-9_]+)"/g)) out.add(match[1]);
  return out;
}

describe("registry ↔ Rust join targets", () => {
  it("every non-null rustCommand is a registered Tauri command", () => {
    const handlers = registeredHandlers();
    const missing: string[] = [];
    for (const d of TOOL_REGISTRY) {
      if (d.handler.kind === "runner-special") continue;
      if (d.rustCommand == null) continue;
      // MCP is dynamic — never reaches the registry; nothing to assert here.
      if (d.rustCommand.startsWith("mcp__")) continue;
      if (!handlers.has(d.rustCommand)) missing.push(`${d.name}→${d.rustCommand}`);
    }
    expect(
      missing,
      `rustCommand(s) not in generate_handler!: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every approval.rustCommand has a binding_for arm", () => {
    const arms = bindingForArms();
    const missing: string[] = [];
    for (const d of TOOL_REGISTRY) {
      if (!d.approval) continue;
      const cmd = d.approval.rustCommand;
      if (cmd.startsWith("mcp__")) continue;
      if (!arms.has(cmd)) missing.push(`${d.name}→${cmd}`);
    }
    expect(
      missing,
      `approval rustCommand(s) without a binding_for arm: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every dangerous tool with an approval binding is backend-bound", () => {
    // A descriptor that mints an approval token MUST be dangerous (shows the
    // modal). The inverse (dangerous without binding) is the documented
    // client-side set: create_flow / remember / spawn_subagent.
    const CLIENT_SIDE = new Set(["create_flow", "remember", "spawn_subagent"]);
    for (const d of TOOL_REGISTRY) {
      if (d.approval) {
        expect(d.dangerous, `${d.name} binds a token but isn't dangerous`).toBe(
          true,
        );
      }
      if (d.dangerous && !d.approval) {
        expect(
          CLIENT_SIDE.has(d.name),
          `${d.name} is dangerous with no binding — classify it`,
        ).toBe(true);
      }
    }
  });
});

// ── create-flow.ts + tool-categories.ts curation flags (assert, don't derive) ─

describe("registry flow flags match create-flow.ts curation", () => {
  it("flowSafeRoles match CURATED_TOOLS_FOR_ROLE membership", () => {
    // Build role→tools from the registry's flowSafeRoles and compare per role.
    const fromRegistry: Record<string, Set<string>> = {};
    for (const role of Object.keys(CURATED_TOOLS_FOR_ROLE)) {
      fromRegistry[role] = new Set();
    }
    for (const d of TOOL_REGISTRY) {
      for (const role of d.flow.flowSafeRoles ?? []) {
        expect(
          fromRegistry[role],
          `${d.name} lists unknown safe role "${role}"`,
        ).toBeDefined();
        fromRegistry[role].add(d.name);
      }
    }
    for (const [role, tools] of Object.entries(CURATED_TOOLS_FOR_ROLE)) {
      expect(
        sorted(fromRegistry[role] ?? []),
        `curated tools for role "${role}" drifted`,
      ).toEqual(sorted(tools));
    }
  });

  it("advancedAllowed flag matches ADVANCED_ALLOWED_TOOLS", () => {
    const fromRegistry = TOOL_REGISTRY.filter(
      (d) => d.flow.advancedAllowed,
    ).map((d) => d.name);
    expect(sorted(fromRegistry)).toEqual(sorted(ADVANCED_ALLOWED_TOOLS));
  });

  it("advancedForbidden flag matches ADVANCED_FORBIDDEN_TOOLS", () => {
    const fromRegistry = TOOL_REGISTRY.filter(
      (d) => d.flow.advancedForbidden,
    ).map((d) => d.name);
    expect(sorted(fromRegistry)).toEqual(sorted(ADVANCED_FORBIDDEN_TOOLS));
  });
});

describe("registry presetCategory matches tool-categories.ts buckets", () => {
  it("every pickerExposed tool lands in its declared category bucket", () => {
    // Build name→bucket from TOOL_CATEGORIES.
    const bucketOf = new Map<string, string>();
    for (const cat of TOOL_CATEGORIES) {
      for (const t of cat.tools) bucketOf.set(t, cat.id);
    }
    for (const d of TOOL_REGISTRY) {
      if (!d.flow.pickerExposed) continue;
      expect(
        d.flow.presetCategory,
        `${d.name} pickerExposed but no presetCategory`,
      ).toBeDefined();
      expect(
        bucketOf.get(d.name),
        `${d.name} bucket drift (registry says ${d.flow.presetCategory})`,
      ).toBe(d.flow.presetCategory);
    }
  });

  it("every categorized tool is marked pickerExposed with the same bucket", () => {
    for (const cat of TOOL_CATEGORIES) {
      for (const t of cat.tools) {
        const d: ToolDescriptor | undefined = REGISTRY_BY_NAME.get(t);
        expect(d, `category tool "${t}" missing from registry`).toBeDefined();
        expect(d!.flow.pickerExposed, `${t} not pickerExposed`).toBe(true);
        expect(d!.flow.presetCategory, `${t} bucket mismatch`).toBe(cat.id);
      }
    }
  });
});
