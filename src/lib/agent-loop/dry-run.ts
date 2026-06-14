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
import { TOOL_REGISTRY } from "./tool-registry";
import { lazyDerivedSet } from "./lazy-set";

// ── Dry-run disposition Sets — DERIVED from TOOL_REGISTRY ────────────────────
//
// Both Sets are derived from each descriptor's `dryRun` field
// ("preview" | "run" | "suppress"), the single source of truth in
// tool-registry.ts. The registry-consistency test pins them against the
// original frozen literals so a wrong `dryRun` value fails CI.

/**
 * Tools with a rich dry-run PREVIEW (diff / would_run / would_navigate, …) —
 * `dryRunExecute` returns a structured `{ok:true, dry_run:true, would_*}`
 * payload instead of invoking the Tauri command.
 */
export const DRY_RUN_TOOLS = lazyDerivedSet(() =>
  TOOL_REGISTRY.filter((d) => d.dryRun === "preview").map((d) => d.name),
);

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
 * automatically until someone consciously decides it is read-only (descriptor
 * `dryRun: "run"`). A denylist would silently execute it.
 */
export const DRY_RUN_READ_ONLY = lazyDerivedSet(() =>
  TOOL_REGISTRY.filter((d) => d.dryRun === "run").map((d) => d.name),
);

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
      // [bug] Mirror the Rust executor (fs.rs): when replace_all is false and
      // old_string matches more than once, the real run REJECTS the call. A JS
      // first-match replace would show a misleading clean diff for an op that
      // would actually error out, defeating the purpose of the dry-run preview.
      let after: string;
      if (replaceAll) {
        after = before.split(oldStr).join(newStr);
      } else {
        const matchCount = oldStr === "" ? 0 : before.split(oldStr).length - 1;
        if (matchCount > 1) {
          return JSON.stringify({
            ok: false,
            dry_run: true,
            kind: "multiple_matches",
            message: `dry-run: old_string matches ${matchCount} times; pass replace_all=true to replace all`,
          });
        }
        after = before.replace(oldStr, newStr);
      }
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
          // [bug] Same multi-match guard as edit_file: the Rust executor rejects
          // a non-replace_all edit whose old_string matches >1 time, so the
          // preview must too rather than silently replacing the first match.
          const matchCount = oldStr === "" ? 0 : after.split(oldStr).length - 1;
          if (matchCount > 1) {
            return JSON.stringify({
              ok: false,
              dry_run: true,
              kind: "multiple_matches",
              message: `dry-run: old_string matches ${matchCount} times; pass replace_all=true to replace all`,
            });
          }
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
    case "apply_patch": {
      const patch = String(args.patch ?? "");
      // Light parse of the +++ headers to list the files the patch would touch
      // (strip git a//b/ prefixes; skip /dev/null). The real apply is suppressed.
      const files: string[] = [];
      for (const line of patch.split("\n")) {
        if (line.startsWith("+++ ")) {
          const p = line.slice(4).split("\t")[0].trim();
          if (p && p !== "/dev/null") files.push(p.replace(/^[ab]\//, ""));
        }
      }
      return JSON.stringify({
        ok: true,
        dry_run: true,
        would_apply_patch: {
          files,
          diff: truncForDryRun(patch, 4096),
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
