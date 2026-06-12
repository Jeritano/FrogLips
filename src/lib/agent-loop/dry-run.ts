/* ── Dry-run mode ──────────────────────────────────────────────────────────
 *
 * Frontend-only short-circuit for side-effectful tools. When the dispatcher
 * is invoked with `dryRun=true`, the targeted tools return a structured
 * `{ok:true, dry_run:true, would_*:...}` payload instead of invoking the
 * Tauri command. Read-only tools (read_file, list_dir, ...) are unaffected.
 *
 * Audit log still records the suppressed call with `outcome: "dry_run"` so
 * the user can review what the agent intended to do.
 *
 * NOTE: this is intentionally a frontend-only concept. The Rust commands
 * are unchanged — the shim lives entirely here.
 */

import { api } from "../tauri-api";
import { makeUnifiedDiff } from "./diff";
import { dryRunValidateUrl } from "./url-safety";

export const DRY_RUN_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "run_shell",
  "applescript_run",
  "browser_navigate",
  "browser_click",
  "browser_fill",
]);

/**
 * Tools that are safe to ACTUALLY EXECUTE under dry-run: read-only / no
 * persistent side effect (reads, lookups, pure compute, network GETs).
 *
 * Sec audit round 4: dry-run suppression is DEFAULT-DENY and keys on the
 * COMPLEMENT of this set — anything NOT listed here (and not given a rich
 * preview by DRY_RUN_TOOLS above) is suppressed, INCLUDING unknown/future
 * tools and all MCP tools. This is deliberately an allowlist of safe tools,
 * not a denylist of dangerous ones: when a new side-effectful tool is added
 * (e.g. format_code, screenshot, remember, workflow_set, task_cancel — all of
 * which mutate state yet are NOT in DANGEROUS_TOOLS), it is suppressed
 * automatically until someone consciously decides it is read-only and adds it
 * here. A denylist would silently execute it.
 */
export const DRY_RUN_READ_ONLY = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "file_exists",
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
]);

function truncForDryRun(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Best-effort SHA-256 → first 16 hex chars. Returns "" on environments
 * lacking SubtleCrypto (test runner, etc.). */
async function sha256First16(text: string): Promise<string> {
  try {
    const subtle: SubtleCrypto | undefined = (
      globalThis as { crypto?: { subtle?: SubtleCrypto } }
    ).crypto?.subtle;
    if (!subtle) return "";
    const buf = new TextEncoder().encode(text);
    const digest = await subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, 16);
  } catch {
    return "";
  }
}

export async function dryRunExecute(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "write_file": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const sha = await sha256First16(content);
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_write: {
          path,
          size_bytes: new TextEncoder().encode(content).length,
          sha256_first16: sha,
        },
      });
    }
    case "edit_file": {
      const path = String(args.path ?? "");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const replaceAll = args.replace_all === true;
      let before = "";
      try {
        const r = await api.agentReadFile(path);
        if (r && typeof r === "object" && "content" in r) {
          before = String((r as { content?: unknown }).content ?? "");
        }
      } catch (e) {
        return JSON.stringify({
          ok: false,
          dry_run: true,
          kind: "read_failed",
          message: `dry-run: could not read '${path}' for diff: ${(e as Error).message ?? e}`,
        });
      }
      const after = replaceAll
        ? before.split(oldStr).join(newStr)
        : before.replace(oldStr, newStr);
      const diff = makeUnifiedDiff(path, before, after);
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_change: truncForDryRun(diff, 4096),
      });
    }
    case "multi_edit": {
      const path = String(args.path ?? "");
      const edits = Array.isArray(args.edits)
        ? (args.edits as Array<{
            old_string?: unknown;
            new_string?: unknown;
            replace_all?: unknown;
          }>)
        : [];
      let before = "";
      try {
        const r = await api.agentReadFile(path);
        if (r && typeof r === "object" && "content" in r) {
          before = String((r as { content?: unknown }).content ?? "");
        }
      } catch (e) {
        return JSON.stringify({
          ok: false,
          dry_run: true,
          kind: "read_failed",
          message: `dry-run: could not read '${path}' for diff: ${(e as Error).message ?? e}`,
        });
      }
      let after = before;
      for (const ed of edits) {
        const oldStr = String(ed.old_string ?? "");
        const newStr = String(ed.new_string ?? "");
        if (ed.replace_all === true) {
          after = after.split(oldStr).join(newStr);
        } else {
          after = after.replace(oldStr, newStr);
        }
      }
      const diff = makeUnifiedDiff(path, before, after);
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_change: truncForDryRun(diff, 4096),
      });
    }
    case "run_shell": {
      const command = String(args.command ?? "");
      const cwd = args.cwd ? String(args.cwd) : null;
      // NOTE: `env` is intentionally absent — run_shell has no env parameter in
      // its schema and the executor never forwarded one, so echoing it here
      // would misrepresent what the approved command actually runs.
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_run: command,
        cwd,
      });
    }
    case "applescript_run": {
      const script = String(args.script ?? "");
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_run_applescript: truncForDryRun(script, 2048),
      });
    }
    case "browser_navigate": {
      const urlStr = String(args.url ?? "");
      const v = dryRunValidateUrl(urlStr);
      if (!v.ok) {
        return JSON.stringify({
          ok: false,
          dry_run: true,
          blocked_by_safety: v.reason,
        });
      }
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_navigate: urlStr,
      });
    }
    case "browser_click": {
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_click: String(args.selector ?? ""),
      });
    }
    case "browser_fill": {
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_fill: {
          selector: String(args.selector ?? ""),
          value: String(args.value ?? ""),
        },
      });
    }
    default:
      // Should never hit — DRY_RUN_TOOLS is the gate.
      return JSON.stringify({
        ok: false,
        kind: "unknown_dry_run_tool",
        message: name,
      });
  }
}
