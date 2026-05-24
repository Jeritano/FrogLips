import { invoke } from "@tauri-apps/api/core";
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
  listMemories: (status?: "active" | "pending" | "archived") =>
    invoke<Memory[]>("list_memories", { status: status ?? null }),
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
  // 60s token bound to a Rust command name; the four dangerous commands below
  // require it. The wrappers mint immediately before invoking, so they must
  // only be called on the agent loop's post-confirmation path.
  // `command` is required for `agent_run_shell` (the token is SHA-256-bound
  // to that exact command on the Rust side so an approval for `ls` cannot be
  // silently reused for `rm -rf`). Other tools ignore the binding.
  mintToolApproval: (tool: string, command?: string) =>
    invoke<string>("mint_tool_approval", { tool, command: command ?? null }),

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
      // Token is bound to a SHA-256 of `command` on the Rust side; pass the
      // exact same command we are about to run.
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_run_shell",
        command,
      }),
    }),
  agentCancelShell: (opId: string) =>
    invoke<void>("agent_cancel_shell", { opId }),
  agentWriteFile: async (path: string, content: string) =>
    invoke<void>("agent_write_file", {
      path,
      content,
      approval: await invoke<string>("mint_tool_approval", { tool: "agent_write_file", command: null }),
    }),
  agentEditFile: async (path: string, oldString: string, newString: string, replaceAll?: boolean) =>
    invoke<EditResult>("agent_edit_file", {
      path,
      oldString,
      newString,
      replaceAll: replaceAll ?? null,
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_edit_file",
        command: null,
      }),
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
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_multi_edit",
        command: null,
      }),
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
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_move_path",
        command: null,
      }),
    }),
  agentCopyPath: async (from: string, to: string, overwrite?: boolean) =>
    invoke<{ from: string; to: string }>("agent_copy_path", {
      from,
      to,
      overwrite: overwrite ?? null,
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_copy_path",
        command: null,
      }),
    }),
  agentDeletePath: async (path: string, recursive?: boolean) =>
    invoke<{ path: string; was_dir: boolean }>("agent_delete_path", {
      path,
      recursive: recursive ?? null,
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_delete_path",
        command: null,
      }),
    }),
  agentMakeDir: async (path: string) =>
    invoke<{ path: string; created: boolean }>("agent_make_dir", {
      path,
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_make_dir",
        command: null,
      }),
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
      approval: await invoke<string>("mint_tool_approval", {
        tool: "agent_kill_process",
        command: null,
      }),
    }),
  agentListUndo: () =>
    invoke<
      Array<{ path: string; kind: string; taken_at_ms: number; size_bytes: number; was_absent: boolean }>
    >("agent_list_undo"),
  agentUndoLast: async () =>
    invoke<{ path: string; kind: string; restored_bytes: number; was_absent: boolean }>(
      "agent_undo_last",
      {
        approval: await invoke<string>("mint_tool_approval", {
          tool: "agent_undo_last",
          command: null,
        }),
      },
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
  agentScreenshot: (outPath?: string) =>
    invoke<ScreenshotResult>("agent_screenshot", { outPath: outPath ?? null }),
  agentClipboardGet: () =>
    invoke<string>("agent_clipboard_get"),
  agentClipboardSet: (text: string) =>
    invoke<void>("agent_clipboard_set", { text }),
  agentOpenApp: (name: string) =>
    invoke<void>("agent_open_app", { name }),
  agentShowNotification: (title: string, body: string) =>
    invoke<void>("agent_show_notification", { title, body }),
  agentOpenPathInEditor: (path: string, line?: number) =>
    invoke<string>("agent_open_path_in_editor", { path, line: line ?? null }),
  agentApplescriptRun: async (script: string) =>
    invoke<ShellResult>("agent_applescript_run", {
      script,
      approval: await invoke<string>("mint_tool_approval", { tool: "agent_applescript_run", command: null }),
    }),
  agentHttpRequest: async (input: HttpReqInput) =>
    invoke<HttpResp>("agent_http_request", {
      input,
      approval: await invoke<string>("mint_tool_approval", { tool: "agent_http_request", command: null }),
    }),
  agentFindDefinition: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_definition", { symbol, path: path ?? null }),
  agentFindReferences: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_references", { symbol, path: path ?? null }),
  agentFormatCode: (path: string) =>
    invoke<FormatResult>("agent_format_code", { path }),

  // Browser automation
  agentBrowserNavigate: (url: string) =>
    invoke<BrowserNavigateResult>("agent_browser_navigate", { url }),
  agentBrowserClick: (selector: string) =>
    invoke<BrowserOkResult>("agent_browser_click", { selector }),
  agentBrowserFill: (selector: string, value: string) =>
    invoke<BrowserOkResult>("agent_browser_fill", { selector, value }),
  agentBrowserScreenshot: () =>
    invoke<BrowserScreenshotResult>("agent_browser_screenshot"),
  agentBrowserGetText: (selector?: string) =>
    invoke<BrowserTextResult>("agent_browser_get_text", { selector: selector ?? null }),
  agentBrowserClose: () =>
    invoke<BrowserOkResult>("agent_browser_close"),

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
  taskPrune: (olderThanSecs?: number) =>
    invoke<number>("task_prune", { olderThanSecs: olderThanSecs ?? null }),

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
  listOpenConversationWindows: () =>
    invoke<string[]>("list_open_conversation_windows"),

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
  mcpStartServer: (
    name: string,
    command: string,
    args?: string[],
    env?: Record<string, string>,
  ) => invoke<McpToolDescriptor[]>("mcp_start_server", {
    name,
    command,
    args: args ?? null,
    env: env ?? null,
  }),
  mcpStopServer: (name: string) =>
    invoke<void>("mcp_stop_server", { name }),
  mcpListServers: () => invoke<McpServerInfo[]>("mcp_list_servers"),
  mcpListTools: (name: string) =>
    invoke<McpToolDescriptor[]>("mcp_list_tools", { name }),
  mcpCallTool: (server: string, tool: string, args: Record<string, unknown>) =>
    invoke<string>("mcp_call_tool", { server, tool, args }),
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
  imageSaveTo: (id: number, dest: string) =>
    invoke<string>("image_save_to", { id, dest }),
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
};
