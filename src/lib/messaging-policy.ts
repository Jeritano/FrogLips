/* ── Messaging gateway: remote-run safety policy ────────────────────────────
 *
 * Messages arriving over a chat platform are REMOTE, untrusted input driving the
 * local agent — and there is no desktop confirmation UI to gate a dangerous tool
 * mid-run. So remote runs are locked to a SAFE, read-only/compute-only tool set.
 * Anything that writes, executes, controls the desktop, or hits an external
 * mutating endpoint is excluded. The runner enforces this two ways:
 *   1. `toolAllowlist = SAFE_REMOTE_TOOLS` — only these are advertised + permitted
 *      (the allowlist gate denies every other tool, including all MCP tools).
 *   2. `requestConfirmation` denies unattended — so even a tool that slipped the
 *      allowlist can never be approved without a human at the desk.
 *
 * Deliberately EXCLUDED: write_file/edit_file/multi_edit/write_files/apply_patch,
 * run_shell/run_code, all cu_* (Computer Use), applescript_run/open_app/
 * clipboard_set/screenshot/show_notification, delete_path/move_path/copy_path/
 * make_dir, http_request/call_api (can mutate external state), format_code,
 * kill_process, remember (writes memory), the task and watch tool families,
 * spawn_subagent, and every MCP tool. To widen this for a trusted channel later,
 * do it explicitly —
 * never by default.
 */

/** The ONLY tools a remote (chat-platform) run may use. Read + compute only. */
export const SAFE_REMOTE_TOOLS: readonly string[] = [
  // filesystem reads
  "read_file",
  "read_files",
  "list_dir",
  "search_files",
  "file_exists",
  "hash_file",
  "diff_files",
  // code intel (read-only)
  "find_definition",
  "find_references",
  // git reads
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_branches",
  // research / knowledge (read-only; web tools are SSRF-guarded)
  "web_fetch",
  "web_search",
  "recall_memory",
  "search_project_knowledge",
  // pure compute
  "calculate",
];

/** System-prompt note prepended for remote runs so the model stays concise and
 *  knows it is operating over a chat platform with read-only tools. */
export const REMOTE_RUN_SYSTEM_NOTE =
  "You are answering a user over a chat messaging platform (e.g. Telegram), not in the desktop app. " +
  "Keep replies concise and plain-text friendly (no huge code dumps). " +
  "You have READ-ONLY tools only (file/git reads, web search/fetch, memory recall, knowledge search, calculate) — " +
  "you cannot write files, run shell/code, control the desktop, or take any action that changes state. " +
  "If the user asks for something requiring those, explain you can't do it over chat and suggest they use the Froglips app.";
