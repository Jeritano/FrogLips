import { describe, expect, it } from "vitest";
import { DANGEROUS_TOOLS, IRREVERSIBLE_TOOLS } from "../dispatch";

/**
 * Cross-language tripwire (audit A27).
 *
 * `DANGEROUS_TOOLS` (this file's frontend set) is what makes the loop show a
 * confirmation modal. But the *real* enforcement is the Rust side: the matching
 * `agent_*` command must `verify_bound` a payload-bound approval token, or a
 * prompt-injected renderer can call the command WITHOUT the modal. That binding
 * lives in `src-tauri/src/commands/agent.rs::binding_for` and is symmetry-tested
 * there (`declared_tools_all_have_bindings`).
 *
 * The gap that motivated this test: `watch_path` / `stop_watch` / `task_cancel`
 * were in DANGEROUS_TOOLS but their Rust commands took no approval token — the
 * gate was renderer-only. Neither the Rust test (hand-typed list) nor any TS
 * test caught it.
 *
 * This pins the DANGEROUS_TOOLS membership so ADDING a dangerous tool fails here
 * until the author consciously records — in BACKEND_BOUND or CLIENT_SIDE_ONLY —
 * whether its Rust command enforces a bound token. That forces the binding
 * decision instead of letting it slip.
 */

// Tools whose Rust command MUST verify_bound an approval token (mutate host /
// OS / runtime state out-of-process). Keep in sync with binding_for arms.
const BACKEND_BOUND = new Set<string>([
  "run_shell",
  "task_create",
  "task_cancel",
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
  "watch_path",
  "stop_watch",
  // Computer Use — each cu_* action verify_bounds a canonical-string token.
  "cu_screenshot",
  "cu_click",
  "cu_move",
  "cu_drag",
  "cu_scroll",
  "cu_type",
  "cu_key",
]);

// Dangerous tools whose effect is enforced WITHOUT a payload-bound Rust token
// — either the work runs in the TS loop (no IPC crossing) or the backend has a
// different, documented guard. Each entry needs a reason.
const CLIENT_SIDE_OR_OTHER: Record<string, string> = {
  spawn_subagent: "runs a nested agent loop in TS; gated by the modal + allowlist",
  create_flow: "persists an inert Flow; builder forces non-unattended cards",
  remember: "writes the local memory store; DB-side, no payload-bound IPC token",
};

describe("DANGEROUS_TOOLS ↔ backend binding tripwire", () => {
  it("every dangerous tool is classified as backend-bound or explicitly client-side", () => {
    const unclassified = [...DANGEROUS_TOOLS].filter(
      (t) => !BACKEND_BOUND.has(t) && !(t in CLIENT_SIDE_OR_OTHER),
    );
    expect(
      unclassified,
      `New DANGEROUS_TOOLS entries with no binding decision: ${unclassified.join(", ")}. ` +
        `Add a binding_for arm + verify_bound in commands/agent.rs and list it in ` +
        `BACKEND_BOUND, OR document it in CLIENT_SIDE_OR_OTHER.`,
    ).toEqual([]);
  });

  it("the classifier sets only reference real dangerous tools", () => {
    for (const t of BACKEND_BOUND)
      expect(DANGEROUS_TOOLS.has(t), `${t} no longer dangerous?`).toBe(true);
    for (const t of Object.keys(CLIENT_SIDE_OR_OTHER))
      expect(DANGEROUS_TOOLS.has(t), `${t} no longer dangerous?`).toBe(true);
  });

  it("irreversible tools are a subset of dangerous tools", () => {
    for (const t of IRREVERSIBLE_TOOLS)
      expect(DANGEROUS_TOOLS.has(t)).toBe(true);
  });
});
