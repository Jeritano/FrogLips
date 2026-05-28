import { invoke } from "@tauri-apps/api/core";

/**
 * Approval-payload shape — mirrors `ApprovalPayload` in
 * `src-tauri/src/commands/agent.rs`. Only the fields a given tool family
 * requires are set; everything else stays undefined.
 *
 * The Rust side recomputes the binding from these fields at consume time,
 * so a token issued for one payload cannot be silently reused for another
 * within the 60s TTL (a write-file token for `notes.md` can't clobber
 * `~/.bashrc`; a kill token for pid 12345 can't kill pid 1234; etc.).
 */
export interface ApprovalPayload {
  command?: string;
  path?: string;
  from?: string;
  to?: string;
  url?: string;
  pid?: number;
  signal?: string;
  text?: string;
  bundle_id?: string;
  script?: string;
  title?: string;
  body?: string;
  mcp_command?: string;
  mcp_args?: string[];
  mcp_env_keys?: string[];
  mcp_server?: string;
  mcp_tool?: string;
}

/**
 * Internal helper: mint a binding-aware approval token. Pre-mints into a
 * local before any further `await`, so a fast burst of dangerous calls
 * can't interleave their mint/consume across the renderer event loop.
 */
async function mintApproval(tool: string, payload?: ApprovalPayload): Promise<string> {
  return await invoke<string>("mint_tool_approval", {
    tool,
    command: payload?.command ?? null,
    payload: payload ?? null,
  });
}
import type {
  AgentAuditEntry,
  AgentAuditFilter,
  AgentAuditRow,
  AgentAuditStats,
  AgentSessionMetricsEntry,
  AgentSessionMetricsRow,
  AllModels,
  DashboardSummary,
  OllamaLibraryEntry,
  AppSettings,
  BranchInfo,
  ClaudeSkillRow,
  ClaudeSkillSummary,
  BrowserNavigateResult,
  BrowserOkResult,
  BrowserScreenshotResult,
  BrowserTextResult,
  ChatImage,
  Conversation,
  ForkTree,
  DirListing,
  GgufFile,
  ImageGenOpts,
  ImageMeta,
  ListImagesPage,
  EditOp,
  EditResult,
  ExistsResult,
  FormatResult,
  GitResult,
  HttpReqInput,
  HttpResp,
  LoraMergeRow,
  LoraMetadata,
  McpServerInfo,
  McpToolDescriptor,
  Memory,
  Message,
  MessageSearchHit,
  MultiEditResult,
  PdfResult,
  PolicyDecision,
  ProjectPolicy,
  RagCorpusInfo,
  RagHit,
  RagIngestReport,
  ReadResult,
  ScreenshotResult,
  SearchResult,
  RawWorkflow,
  ServerStatus,
  ShellOpts,
  ShellResult,
  SkillFull,
  SkillSummary,
  TaskInfo,
  WorkflowRun,
  WatchHandle,
  WatchInfo,
  WatchPoll,
  WebFetchResult,
  WebSearchResult,
} from "../types";

export const api = {
  listAllModels: () => invoke<AllModels>("list_all_models"),
  startServer: (model: string, backend: string) =>
    invoke<ServerStatus>("start_server", { model, backend }),
  stopServer: () => invoke<void>("stop_server"),
  serverStatus: () => invoke<ServerStatus>("server_status"),
  /** Append a single line to ~/.local-llm-app/diag.log. Best-effort —
   *  callers should `.catch(() => undefined)`. Used for on-disk
   *  diagnostic capture (in-memory ring is volatile across restart). */
  appendDiagLog: (line: string) => invoke<void>("append_diag_log", { line }),
  pullOllamaModel: (name: string) => invoke<string>("pull_ollama_model", { name }),
  pullHfModel: (repoId: string) => invoke<string>("pull_hf_model", { repoId }),
  // Scrape + parse <https://ollama.com/library>. Cached server-side for 10
  // minutes. Throws on network/parse failure so the caller can fall back to
  // the curated `OLLAMA` array.
  ollamaLibraryFetch: () => invoke<OllamaLibraryEntry[]>("ollama_library_fetch"),
  deleteOllamaModel: (name: string) => invoke<void>("delete_ollama_model", { name }),
  deleteMlxModel: (repoId: string) => invoke<void>("delete_mlx_model", { repoId }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  // Local crash log — returns the last ~64 KB of `~/.local-llm-app/crash.log`,
  // or an empty string when no crashes have been recorded.
  readCrashLog: () => invoke<string>("read_crash_log"),

  // Data backup / export / import. `backupDatabase` writes a single-file copy
  // of the SQLite DB; `exportData` serialises conversations + messages +
  // memory to JSON; `importData` additively merges such a JSON export back in
  // and throws on a schema mismatch.
  backupDatabase: (destPath: string) =>
    invoke<void>("backup_database", { destPath }),
  exportData: (destPath: string) =>
    invoke<void>("export_data", { destPath }),
  importData: (srcPath: string) =>
    invoke<void>("import_data", { srcPath }),
  exportDiagnosticsBundle: (destPath: string) =>
    invoke<void>("export_diagnostics_bundle", { destPath }),

  listConversations: () => invoke<Conversation[]>("list_conversations"),
  createConversation: (title: string, model: string | null) =>
    invoke<number>("create_conversation", { title, model }),
  deleteConversation: (id: number) =>
    invoke<void>("delete_conversation", { id }),
  renameConversation: (id: number, title: string) =>
    invoke<void>("rename_conversation", { id, title }),
  // Per-conversation model parameter overrides. `params` is a JSON string
  // (`{temperature,top_p,max_tokens,system_prompt}`) or null to clear.
  updateConversationParams: (id: number, params: string | null) =>
    invoke<void>("update_conversation_params", { id, params }),
  // Conversation organisation — pin, tags, and full-text message search.
  // `tags` is a raw JSON array string (or null to clear). `searchMessages`
  // returns the conversation ids whose messages match, with a snippet.
  setConversationPinned: (id: number, pinned: boolean) =>
    invoke<void>("set_conversation_pinned", { id, pinned }),
  setConversationTags: (id: number, tags: string | null) =>
    invoke<void>("set_conversation_tags", { id, tags }),
  searchMessages: (query: string) =>
    invoke<MessageSearchHit[]>("search_messages", { query }),
  listMessages: async (conversationId: number) => {
    // Backend returns `images` as a JSON-encoded string (the literal SQLite
    // column). Parse here so callers see the typed `ChatImage[]` shape
    // declared on `Message`. Bad JSON → drop the field rather than throw,
    // mirroring the way we treat other recoverable persistence quirks.
    type RawMsg = Omit<Message, "images"> & { images?: string | null };
    const raw = await invoke<RawMsg[]>("list_messages", { conversationId });
    return raw.map((m) => {
      if (typeof m.images !== "string" || m.images.length === 0) {
        const { images: _drop, ...rest } = m;
        return rest as Message;
      }
      try {
        const parsed = JSON.parse(m.images) as ChatImage[];
        if (Array.isArray(parsed)) {
          return { ...m, images: parsed } as Message;
        }
      } catch {/* fall through */}
      const { images: _drop, ...rest } = m;
      return rest as Message;
    });
  },
  addMessage: (
    conversationId: number,
    role: string,
    content: string,
    model?: string | null,
    images?: ChatImage[] | null,
  ) => invoke<number>("add_message", {
    conversationId,
    role,
    content,
    model: model ?? null,
    // Persist as a JSON string in the messages.images TEXT column. Skipping
    // when there are no attachments keeps the column NULL for the common case.
    imagesJson: images && images.length > 0 ? JSON.stringify(images) : null,
  }),
  deleteMessage: (id: number) => invoke<void>("delete_message", { id }),

  // Conversation branching — `conversationFork` deep-copies messages from
  // `sourceId` up to (and including) `atMessageId` into a fresh conversation
  // and records the parent ref on the new row. The two list APIs let callers
  // render branch trees in the sidebar / a dedicated visualizer.
  conversationFork: (sourceId: number, atMessageId: number) =>
    invoke<number>("conversation_fork", { sourceId, atMessageId }),
  conversationListBranches: (convId: number) =>
    invoke<BranchInfo[]>("conversation_list_branches", { convId }),
  conversationForkTree: (rootId: number) =>
    invoke<ForkTree>("conversation_fork_tree", { rootId }),

  // Memory
  addMemory: (args: {
    content: string;
    conversationId?: number | null;
    sourceMsgId?: number | null;
    tags?: string;
    embedding?: number[];
    status?: "active" | "pending" | "archived";
    scope?: "global" | "project" | "conversation";
    projectRoot?: string | null;
  }) => invoke<number>("add_memory", {
    content: args.content,
    conversationId: args.conversationId ?? null,
    sourceMsgId: args.sourceMsgId ?? null,
    tags: args.tags ?? "",
    embedding: args.embedding ?? null,
    status: args.status ?? "active",
    scope: args.scope ?? "global",
    projectRoot: args.projectRoot ?? null,
  }),
  listMemories: (
    status?: "active" | "pending" | "archived",
    cwd?: string | null,
    convId?: number | null,
  ) =>
    invoke<Memory[]>("list_memories", {
      status: status ?? null,
      cwd: cwd ?? null,
      convId: convId ?? null,
    }),
  deleteMemory: (id: number) => invoke<void>("delete_memory", { id }),
  updateMemoryStatus: (id: number, status: "active" | "pending" | "archived") =>
    invoke<void>("update_memory_status", { id, status }),
  touchMemory: (id: number) => invoke<void>("touch_memory", { id }),
  touchMemories: (ids: number[]) => invoke<void>("touch_memories", { ids }),
  searchMemoriesKeyword: (
    query: string,
    limit?: number,
    ctx?: { cwd?: string | null; convId?: number | null },
  ) =>
    invoke<Memory[]>("search_memories_keyword", {
      query,
      limit: limit ?? 5,
      cwd: ctx?.cwd ?? null,
      convId: ctx?.convId ?? null,
    }),
  searchMemoriesVector: (
    embedding: number[],
    limit?: number,
    minScore?: number,
    ctx?: { cwd?: string | null; convId?: number | null },
  ) =>
    invoke<Memory[]>("search_memories_vector", {
      embedding,
      limit: limit ?? 5,
      minScore: minScore ?? 0.55,
      cwd: ctx?.cwd ?? null,
      convId: ctx?.convId ?? null,
    }),
  findDuplicateMemory: (embedding: number[], threshold?: number) =>
    invoke<number | null>("find_duplicate_memory", { embedding, threshold: threshold ?? 0.85 }),
  // Scope mutators
  memoryPromote: (id: number) => invoke<void>("memory_promote", { id }),
  memoryDemote: (id: number) => invoke<void>("memory_demote", { id }),
  memorySetContext: (id: number, projectRoot?: string | null, convId?: number | null) =>
    invoke<void>("memory_set_context", {
      id,
      projectRoot: projectRoot ?? null,
      convId: convId ?? null,
    }),

  // Dangerous-tool capability gate. `mintToolApproval` mints a single-use,
  // 60s token bound to a Rust command name AND to a tool-family-specific
  // payload (path, pid+signal, url, etc.). Every dangerous wrapper passes
  // the same payload to both `mintToolApproval` and the IPC call so the
  // Rust side can recompute the SHA-256 binding from the live arguments
  // and refuse a token that was approved for a different payload.
  //
  // Payload shape mirrors `ApprovalPayload` in src-tauri/src/commands/agent.rs.
  // Only the fields the target tool requires need to be set; the rest stay
  // undefined (the canonical-string builder substitutes empty strings).
  mintToolApproval: (tool: string, payload?: ApprovalPayload) => mintApproval(tool, payload),

  // Agent tools
  agentReadFile: (path: string, offset?: number, limit?: number) =>
    invoke<ReadResult>("agent_read_file", { path, offset: offset ?? null, limit: limit ?? null }),
  agentListDir: (path: string) =>
    invoke<DirListing>("agent_list_dir", { path }),
  agentRunShell: async (command: string, opts?: ShellOpts, opId?: string) =>
    invoke<ShellResult>("agent_run_shell", {
      command,
      opts: opts ?? null,
      opId: opId ?? null,
      approval: await mintApproval("agent_run_shell", { command }),
    }),
  agentCancelShell: (opId: string) =>
    invoke<void>("agent_cancel_shell", { opId }),
  agentWriteFile: async (path: string, content: string) =>
    invoke<void>("agent_write_file", {
      path,
      content,
      approval: await mintApproval("agent_write_file", { path }),
    }),
  agentEditFile: async (path: string, oldString: string, newString: string, replaceAll?: boolean) =>
    invoke<EditResult>("agent_edit_file", {
      path,
      oldString,
      newString,
      replaceAll: replaceAll ?? null,
      approval: await mintApproval("agent_edit_file", { path }),
    }),
  agentFileExists: (path: string) =>
    invoke<ExistsResult>("agent_file_exists", { path }),
  agentSearchFiles: (path: string, pattern: string, glob?: string, regex?: boolean) =>
    invoke<SearchResult>("agent_search_files", {
      path, pattern,
      glob: glob ?? null,
      regex: regex ?? null,
    }),
  agentMultiEdit: async (path: string, edits: EditOp[]) =>
    invoke<MultiEditResult>("agent_multi_edit", {
      path,
      edits,
      approval: await mintApproval("agent_multi_edit", { path }),
    }),

  // ── Extras: file ops + hash + diff + processes + undo ─────────────────
  //
  // Mutating ops go through the same `mint_tool_approval` gate as the
  // existing dangerous tools. Read-only ones (hash_file, diff_files,
  // list_processes, list_undo) don't need a token.
  agentMovePath: async (from: string, to: string, overwrite?: boolean) =>
    invoke<{ from: string; to: string }>("agent_move_path", {
      from,
      to,
      overwrite: overwrite ?? null,
      approval: await mintApproval("agent_move_path", { from, to }),
    }),
  agentCopyPath: async (from: string, to: string, overwrite?: boolean) =>
    invoke<{ from: string; to: string }>("agent_copy_path", {
      from,
      to,
      overwrite: overwrite ?? null,
      approval: await mintApproval("agent_copy_path", { from, to }),
    }),
  agentDeletePath: async (path: string, recursive?: boolean) =>
    invoke<{ path: string; was_dir: boolean }>("agent_delete_path", {
      path,
      recursive: recursive ?? null,
      approval: await mintApproval("agent_delete_path", { path }),
    }),
  agentMakeDir: async (path: string) =>
    invoke<{ path: string; created: boolean }>("agent_make_dir", {
      path,
      approval: await mintApproval("agent_make_dir", { path }),
    }),
  agentHashFile: (path: string, algorithm?: "sha256" | "sha512") =>
    invoke<{ algorithm: string; hex: string; size_bytes: number }>("agent_hash_file", {
      path,
      algorithm: algorithm ?? null,
    }),
  agentDiffFiles: (left: string, right: string) =>
    invoke<{ diff: string; identical: boolean }>("agent_diff_files", { left, right }),
  agentListProcesses: (filter?: string) =>
    invoke<
      Array<{ pid: number; ppid: number; cpu_pct: number; mem_mib: number; command: string }>
    >("agent_list_processes", { filter: filter ?? null }),
  agentKillProcess: async (pid: number, signal?: string) =>
    invoke<{ pid: number; signal: string }>("agent_kill_process", {
      pid,
      signal: signal ?? null,
      approval: await mintApproval("agent_kill_process", { pid, signal }),
    }),
  agentListUndo: () =>
    invoke<
      Array<{ path: string; kind: string; taken_at_ms: number; size_bytes: number; was_absent: boolean }>
    >("agent_list_undo"),
  agentUndoLast: async () =>
    invoke<{ path: string; kind: string; restored_bytes: number; was_absent: boolean }>(
      "agent_undo_last",
      { approval: await mintApproval("agent_undo_last") },
    ),
  agentClearUndoStack: () => invoke<void>("agent_clear_undo_stack"),
  agentGitStatus: (path?: string) =>
    invoke<GitResult>("agent_git_status", { path: path ?? null }),
  agentGitDiff: (path?: string, staged?: boolean) =>
    invoke<GitResult>("agent_git_diff", { path: path ?? null, staged: staged ?? null }),
  agentGitLog: (path?: string, limit?: number) =>
    invoke<GitResult>("agent_git_log", { path: path ?? null, limit: limit ?? null }),
  agentGitShow: (reference: string, path?: string) =>
    invoke<GitResult>("agent_git_show", { reference, path: path ?? null }),
  agentGitBranches: (path?: string) =>
    invoke<GitResult>("agent_git_branches", { path: path ?? null }),
  agentGitCommit: (message: string, path?: string) =>
    invoke<GitResult>("agent_git_commit", { message, path: path ?? null }),
  agentWebFetch: (url: string) =>
    invoke<WebFetchResult>("agent_web_fetch", { url }),
  agentWebSearch: (query: string, n?: number) =>
    invoke<WebSearchResult>("agent_web_search", { query, n: n ?? null }),
  agentReadPdf: (path: string, limit?: number) =>
    invoke<PdfResult>("agent_read_pdf", { path, limit: limit ?? null }),
  agentScreenshot: async (outPath?: string) =>
    invoke<ScreenshotResult>("agent_screenshot", {
      outPath: outPath ?? null,
      approval: await mintApproval("agent_screenshot", { path: outPath }),
    }),
  agentClipboardGet: () =>
    invoke<string>("agent_clipboard_get"),
  agentClipboardSet: async (text: string) =>
    invoke<void>("agent_clipboard_set", {
      text,
      approval: await mintApproval("agent_clipboard_set", { text }),
    }),
  agentOpenApp: async (name: string) =>
    invoke<void>("agent_open_app", {
      name,
      approval: await mintApproval("agent_open_app", { bundle_id: name }),
    }),
  agentShowNotification: async (title: string, body: string) =>
    invoke<void>("agent_show_notification", {
      title,
      body,
      // Binding uses title + body as independent length-prefixed fields
      // (sec re-review M-NEW-1 — previous joined-string was collision-prone).
      approval: await mintApproval("agent_show_notification", { title, body }),
    }),
  agentOpenPathInEditor: async (path: string, line?: number) =>
    invoke<string>("agent_open_path_in_editor", {
      path,
      line: line ?? null,
      approval: await mintApproval("agent_open_path_in_editor", { path }),
    }),
  agentApplescriptRun: async (script: string) =>
    invoke<ShellResult>("agent_applescript_run", {
      script,
      // Sec re-review H-1: payload-bind the script body.
      approval: await mintApproval("agent_applescript_run", { script }),
    }),
  agentHttpRequest: async (input: HttpReqInput) =>
    invoke<HttpResp>("agent_http_request", {
      input,
      approval: await mintApproval("agent_http_request", { url: input.url }),
    }),
  agentFindDefinition: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_definition", { symbol, path: path ?? null }),
  agentFindReferences: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_references", { symbol, path: path ?? null }),
  agentFormatCode: async (path: string) =>
    invoke<FormatResult>("agent_format_code", {
      path,
      approval: await mintApproval("agent_format_code", { path }),
    }),

  // Browser automation
  agentBrowserNavigate: async (url: string) =>
    invoke<BrowserNavigateResult>("agent_browser_navigate", {
      url,
      approval: await mintApproval("agent_browser_navigate", { url }),
    }),
  // Sec re-review H-NEW-2: each interactive browser action is approval-
  // gated and bound to the target selector / value. Previously only
  // navigate gated; the rest rode the post-navigate session.
  agentBrowserClick: async (selector: string) =>
    invoke<BrowserOkResult>("agent_browser_click", {
      selector,
      approval: await mintApproval("agent_browser_click", { text: selector }),
    }),
  agentBrowserFill: async (selector: string, value: string) =>
    invoke<BrowserOkResult>("agent_browser_fill", {
      selector,
      value,
      approval: await mintApproval("agent_browser_fill", {
        text: selector,
        body: value,
      }),
    }),
  agentBrowserScreenshot: async () =>
    invoke<BrowserScreenshotResult>("agent_browser_screenshot", {
      approval: await mintApproval("agent_browser_screenshot"),
    }),
  agentBrowserGetText: async (selector?: string) =>
    invoke<BrowserTextResult>("agent_browser_get_text", {
      selector: selector ?? null,
      approval: await mintApproval("agent_browser_get_text", {
        text: selector ?? "",
      }),
    }),
  agentBrowserClose: async () =>
    invoke<BrowserOkResult>("agent_browser_close", {
      approval: await mintApproval("agent_browser_close"),
    }),

  // Filesystem watcher
  agentWatchPath: (path: string, glob?: string, debounceMs?: number) =>
    invoke<WatchHandle>("agent_watch_path", {
      path,
      glob: glob ?? null,
      debounceMs: debounceMs ?? null,
    }),
  agentListWatches: () => invoke<WatchInfo[]>("agent_list_watches"),
  agentPollWatch: (id: string, sinceMs?: number, maxEvents?: number) =>
    invoke<WatchPoll>("agent_poll_watch", {
      id,
      sinceMs: sinceMs ?? null,
      maxEvents: maxEvents ?? null,
    }),
  agentStopWatch: (id: string) => invoke<void>("agent_stop_watch", { id }),

  // Task queue
  taskCreate: (command: string, cwd?: string) =>
    invoke<TaskInfo>("task_create", { command, cwd: cwd ?? null }),
  taskStatus: (id: string) => invoke<TaskInfo>("task_status", { id }),
  taskList: () => invoke<TaskInfo[]>("task_list"),
  taskCancel: (id: string) => invoke<void>("task_cancel", { id }),
  // task_prune binding deleted 2026-05-26 SE review round 2 — no FE
  // consumer; opportunistic prune already runs inside task_queue::create.

  // ask_user
  agentAskUser: (question: string, hint?: string) =>
    invoke<string>("agent_ask_user", { question, hint: hint ?? null }),
  agentAskUserReply: (id: string, answer: string) =>
    invoke<void>("agent_ask_user_reply", { id, answer }),
  agentAskUserCancel: (id: string) =>
    invoke<void>("agent_ask_user_cancel", { id }),
  agentClassifyShell: (command: string) =>
    invoke<string>("agent_classify_shell", { command }),
  agentClassifyApplescript: (script: string) =>
    invoke<string>("agent_classify_applescript", { script }),
  agentClassifyHttp: (method: string, hasAuth: boolean) =>
    invoke<string>("agent_classify_http", { method, hasAuth }),
  agentSetWorkspace: (path: string | null) =>
    invoke<string | null>("agent_set_workspace", { path }),
  agentGetWorkspace: () =>
    invoke<string | null>("agent_get_workspace"),

  // Multi-window: detached per-conversation windows
  openConversationWindow: (conversationId: number, title?: string | null) =>
    invoke<string>("open_conversation_window", {
      conversationId,
      title: title ?? null,
    }),
  // listOpenConversationWindows binding deleted 2026-05-26 SE review
  // round 2 — no FE consumer. Rust IPC + handler removed in same wave.

  // Per-project policy (`.froglips/policy.json`)
  policyLoad: (cwd: string) =>
    invoke<ProjectPolicy | null>("policy_load", { cwd }),
  policyEvaluateShell: (cwd: string, command: string) =>
    invoke<PolicyDecision>("policy_evaluate_shell", { cwd, command }),
  policyEvaluateWrite: (cwd: string, path: string) =>
    invoke<PolicyDecision>("policy_evaluate_write", { cwd, path }),

  // Settings
  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsSet: (patch: Partial<AppSettings>) =>
    invoke<AppSettings>("settings_set", { patch }),

  // First-run setup wizard
  setupCompleteGet: () => invoke<boolean>("setup_complete_get"),
  setupCompleteSet: (value: boolean) =>
    invoke<void>("setup_complete_set", { value }),
  mlxProbe: () => invoke<boolean>("mlx_probe"),
  ollamaProbe: () => invoke<boolean>("ollama_probe"),

  // MCP (Model Context Protocol)
  mcpStartServer: async (
    name: string,
    command: string,
    args?: string[],
    env?: Record<string, string>,
  ) => {
    // Sec review S-C1: mcp_start_server spawns an arbitrary subprocess with
    // arbitrary args + env — full user-level RCE if abused. Bind the
    // approval to (command + sorted args + sorted env keys). The Rust side
    // recomputes the same canonical string and refuses a mismatched token.
    // Env VALUES are not in the binding (they may rotate session to session
    // for things like API keys) — the user is approving the program +
    // its argv + the SET of variables it will read.
    const mcpArgs = args ?? [];
    const envKeys = env ? Object.keys(env).slice().sort() : [];
    const approval = await mintApproval("mcp_start_server", {
      mcp_command: command,
      mcp_args: mcpArgs,
      mcp_env_keys: envKeys,
    });
    return invoke<McpToolDescriptor[]>("mcp_start_server", {
      name,
      command,
      args: args ?? null,
      env: env ?? null,
      approval,
    });
  },
  mcpStopServer: (name: string) =>
    invoke<void>("mcp_stop_server", { name }),
  mcpListServers: () => invoke<McpServerInfo[]>("mcp_list_servers"),
  mcpListTools: (name: string) =>
    invoke<McpToolDescriptor[]>("mcp_list_tools", { name }),
  mcpCallTool: async (server: string, tool: string, args: Record<string, unknown>) =>
    invoke<string>("mcp_call_tool", {
      server,
      tool,
      args,
      approval: await mintApproval("mcp_call_tool", { mcp_server: server, mcp_tool: tool }),
    }),
  mcpServerStderr: (name: string) =>
    invoke<string | null>("mcp_server_stderr", { name }),

  // RAG (project knowledge)
  ragIngestFolder: (name: string, root: string, glob?: string) =>
    invoke<RagIngestReport>("rag_ingest_folder", {
      name,
      root,
      glob: glob ?? null,
    }),
  ragSearch: (corpusName: string, query: string, topK?: number) =>
    invoke<RagHit[]>("rag_search", {
      corpusName,
      query,
      topK: topK ?? null,
    }),
  ragListCorpora: () => invoke<RagCorpusInfo[]>("rag_list_corpora"),
  ragDeleteCorpus: (name: string) =>
    invoke<void>("rag_delete_corpus", { name }),

  // Agent audit log
  agentAuditRecord: (entry: AgentAuditEntry) =>
    invoke<void>("agent_audit_record", { entry }),
  agentAuditList: (filter?: AgentAuditFilter) =>
    invoke<AgentAuditRow[]>("agent_audit_list", { filter: filter ?? null }),
  agentAuditPurge: (days: number) =>
    invoke<number>("agent_audit_purge", { days }),
  agentAuditStats: () => invoke<AgentAuditStats>("agent_audit_stats"),

  // Per-session metrics + dashboard summary
  agentSessionMetricsRecord: (entry: AgentSessionMetricsEntry) =>
    invoke<void>("agent_session_metrics_record", { entry }),
  agentSessionMetricsQuery: (filter?: AgentAuditFilter) =>
    invoke<AgentSessionMetricsRow[]>("agent_session_metrics_query", {
      filter: filter ?? null,
    }),
  agentDashboardSummary: (filter?: AgentAuditFilter) =>
    invoke<DashboardSummary>("agent_dashboard_summary", { filter: filter ?? null }),

  // Native inference (alpha)
  nativeSupported: () => invoke<boolean>("native_supported"),
  nativeLoadModel: (modelId: string) =>
    invoke<void>("native_load_model", { modelId }),
  nativeUnloadModel: () => invoke<void>("native_unload_model"),
  nativeCurrentModel: () => invoke<string | null>("native_current_model"),
  nativeChatStream: (args: {
    op_id: string;
    messages: {
      role: string;
      content: string;
      tool_calls?: unknown;
      tool_call_id?: string;
      name?: string;
    }[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    tools?: Record<string, unknown>[];
  }) => invoke<string>("native_chat_stream", { args }),

  // GGUF file picker (Phase 3 — see docs/research/llamacpp-backend.md).
  // `native_download_gguf` streams one quant from HF and emits
  // `gguf-download-progress` events while it runs; the caller wires up
  // those events via the Tauri `listen` API at call sites.
  agentNativeDownloadGguf: (repoId: string, filename: string) =>
    invoke<string>("native_download_gguf", { repo: repoId, filename }),
  nativeListGgufFiles: () => invoke<GgufFile[]>("native_list_gguf_files"),
  nativeDeleteGguf: (repoId: string, filename: string) =>
    invoke<void>("native_delete_gguf", { repo: repoId, filename }),

  // Workflows (agent orchestration). The backend stores the canvas graph as a
  // JSON string (`graph_json`); callers convert via `parseWorkflow` /
  // `serializeWorkflowGraph` from `../types`. `workflowSave` upserts — pass
  // `null` for `id` to create — and returns the row id. `workflowRunRecord`
  // persists one execution summary and returns its run id.
  workflowList: () => invoke<RawWorkflow[]>("workflow_list"),
  workflowGet: (id: number) => invoke<RawWorkflow | null>("workflow_get", { id }),
  workflowSave: (id: number | null, name: string, graphJson: string) =>
    invoke<number>("workflow_save", { id, name, graphJson }),
  workflowDelete: (id: number) => invoke<void>("workflow_delete", { id }),
  workflowRunRecord: (workflowId: number, status: string, resultsJson: string) =>
    invoke<number>("workflow_run_record", { workflowId, status, resultsJson }),
  workflowRunsList: (workflowId: number) =>
    invoke<WorkflowRun[]>("workflow_runs_list", { workflowId }),

  // Workflow skills (procedural memory). One skill = a named, replayable
  // sequence of tool calls scoped to a workflow. Save after a successful
  // run via `workflow_skill_save`; replay via the `workflow_invoke_skill`
  // agent tool. The Rust side enforces the same forbidden-tools list the
  // dispatch layer rejects at save time, so the round-trip is safe even
  // if a client forgets the client-side check.
  workflowSkillSave: (
    workflowId: number,
    name: string,
    description: string,
    stepsJson: string,
    overwrite = false,
  ) =>
    invoke<number>("workflow_skill_save", {
      workflowId,
      name,
      description,
      stepsJson,
      overwrite,
    }),
  workflowSkillList: (workflowId: number) =>
    invoke<SkillSummary[]>("workflow_skill_list", { workflowId }),
  workflowSkillGet: (workflowId: number, name: string) =>
    invoke<SkillFull | null>("workflow_skill_get", { workflowId, name }),
  workflowSkillDelete: (workflowId: number, name: string) =>
    invoke<void>("workflow_skill_delete", { workflowId, name }),
  workflowSkillRecordInvocation: (workflowId: number, name: string) =>
    invoke<void>("workflow_skill_record_invocation", { workflowId, name }),

  // Claude Skills (Anthropic-format imported skills). One Claude Skill =
  // a folder containing a SKILL.md file (Anthropic's published format).
  // Imported into the global library so chat-mode agents can mount it on
  // demand via `list_claude_skills()` / `load_claude_skill(name)`. The
  // Rust side handles folder-walking, SKILL.md parsing, and storage in
  // the `claude_skills` SQLite table.
  //
  // Feature-detected: `"claudeSkillList" in api` should return true once
  // the Rust commands ship. Until then the panel renders an unavailable
  // hint instead of crashing on an invoke that resolves to a missing
  // handler. `claudeSkillImport` returns the full row so the caller can
  // refresh local state; on `kind: name_collision` it throws an error
  // whose string contains the marker the panel parses to trigger the
  // overwrite confirm flow.
  claudeSkillImport: (folderPath: string, overwrite?: boolean) =>
    invoke<ClaudeSkillRow>("claude_skill_import", {
      folderPath,
      overwrite: overwrite ?? false,
    }),
  claudeSkillList: (enabledOnly?: boolean) =>
    invoke<ClaudeSkillSummary[]>("claude_skill_list", {
      enabledOnly: enabledOnly ?? null,
    }),
  claudeSkillGet: (name: string) =>
    invoke<ClaudeSkillRow | null>("claude_skill_get", { name }),
  claudeSkillSetEnabled: (name: string, enabled: boolean) =>
    invoke<void>("claude_skill_set_enabled", { name, enabled }),
  claudeSkillSetPinned: (name: string, pinned: boolean) =>
    invoke<void>("claude_skill_set_pinned", { name, pinned }),
  claudeSkillDelete: (name: string) =>
    invoke<void>("claude_skill_delete", { name }),

  // Image generation (mistralrs FLUX). `imageGenerate` returns the **op_id**
  // immediately — the actual diffusion + PNG write runs async on the Rust
  // side and emits `image-progress` / `image-done` / `image-error` events
  // keyed by op_id. The terminal row id arrives via the `image-done` event's
  // `image_id` field.
  //
  // IMPORTANT (H3): register your `listen("image-progress")` /
  // `listen("image-done")` / `listen("image-error")` BEFORE calling this —
  // the Rust engine waits ~50 ms before emitting its first event to give the
  // listener time to attach, but a racing call may still miss the warmup.
  imageGenerate: (
    prompt: string,
    model: string,
    opts: ImageGenOpts,
    convId: number | null,
    opId: string | null,
  ) => invoke<string>("image_generate", {
    prompt,
    model,
    opts,
    convId,
    opId,
  }),
  /**
   * Paginated `images` listing. `limit` caps at 200/page; `offset` skips
   * the first N rows. Returns `{ rows, total }` so the frontend can render
   * a pager without a second round-trip.
   */
  imageList: (convId: number | null, limit?: number, offset?: number) =>
    invoke<ListImagesPage>("image_list", {
      convId,
      limit: typeof limit === "number" ? limit : null,
      offset: typeof offset === "number" ? offset : null,
    }),
  imageGet: (id: number) => invoke<ImageMeta | null>("image_get", { id }),
  imageDelete: (id: number) => invoke<void>("image_delete", { id }),
  /**
   * Cancel an in-flight generation. Pre-dispatch cancels are reliable now
   * (C3 — `CancellationToken`). Mid-diffusion cancel remains best-effort
   * against mistralrs 0.8.1: the engine drops its response receiver and
   * stops emitting events, but the underlying GPU work runs to completion.
   */
  imageCancel: (opId: string) => invoke<void>("image_cancel", { opId }),
  /**
   * Unload the currently-resident FLUX pipeline (~14-28 GiB). Returns
   * `true` when a slot was actually dropped, `false` when nothing was
   * loaded. Calling during a generation queues behind it.
   */
  imageUnload: () => invoke<boolean>("image_unload"),
  /**
   * Copy a previously-generated image (by row id) to `dest`. The Rust side
   * validates `dest` against the same path-safety denylist as other write
   * IPCs (rejects `~/.ssh/`, system dirs, credential filenames, etc).
   * Returns the resolved canonical destination path.
   */
  imageSaveTo: async (id: number, dest: string) =>
    invoke<string>("image_save_to", {
      id,
      dest,
      approval: await mintApproval("image_save_to", { path: dest }),
    }),
  /**
   * Open the on-disk PNG in the user's default image viewer (Preview on
   * macOS) via `/usr/bin/open <path>`. Provided because WebKit's native
   * "Open image in new window" context-menu action fails on `asset://`
   * URLs (Tauri 2 blocks new-window creation by default).
   */
  imageOpenExternal: (id: number) =>
    invoke<void>("image_open_external", { id }),
  /**
   * Reveal the on-disk PNG in Finder via `/usr/bin/open -R <path>`.
   * Equivalent to right-click → Show in Finder; no WebKit equivalent.
   */
  imageRevealInFinder: (id: number) =>
    invoke<void>("image_reveal_in_finder", { id }),

  // ── LoRA merging (Flux.1 [dev] + LoRA) ─────────────────────────────────
  //
  // The Rust merger reads the LoRA + base safetensors, applies the deltas at
  // the user-supplied weight, and writes a content-addressed merged variant
  // under the app's cache dir. `lora_merge` blocks the IPC until the write
  // completes — long-running but fire-and-await — while emitting progress
  // events out of band:
  //   - `lora-merge-progress { op_id, stage, progress }`
  //   - `lora-merge-evicted  { sha }` (LRU drop notice for the cached merges)
  //   - `lora-merge-done     { op_id, row }`
  //   - `lora-merge-error    { op_id, message }`
  //
  // After a successful merge the renderer sets the next image_generate
  // call's `model` field to `"<base>+lora:<sha>"` and the dispatcher routes
  // it to the merged variant. Feature-detected via `"loraInspect" in api`
  // — until the Rust side ships these handlers, the LoRA UI surface
  // renders an "Unavailable" hint instead.
  loraInspect: (loraPath: string) =>
    invoke<LoraMetadata>("lora_inspect", { loraPath }),
  loraMerge: (
    baseRepo: string,
    loraPath: string,
    weight: number,
    opId: string,
  ) =>
    invoke<LoraMergeRow>("lora_merge", {
      baseRepo,
      loraPath,
      weight,
      opId,
    }),
  loraListMerges: () => invoke<LoraMergeRow[]>("lora_list_merges"),
  loraDeleteMerge: (sha: string) =>
    invoke<void>("lora_delete_merge", { sha }),
  loraRecordUsed: (sha: string) =>
    invoke<void>("lora_record_used", { sha }),
};
