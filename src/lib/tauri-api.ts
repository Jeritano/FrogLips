import { invoke } from "@tauri-apps/api/core";
import type {
  AgentAuditEntry,
  AgentAuditFilter,
  AgentAuditRow,
  AgentAuditStats,
  AllModels,
  AppSettings,
  Conversation,
  DirListing,
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
  MultiEditResult,
  PdfResult,
  PolicyDecision,
  ProjectPolicy,
  ReadResult,
  ScreenshotResult,
  SearchResult,
  ServerStatus,
  ShellOpts,
  ShellResult,
  TaskInfo,
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
  deleteOllamaModel: (name: string) => invoke<void>("delete_ollama_model", { name }),
  deleteMlxModel: (repoId: string) => invoke<void>("delete_mlx_model", { repoId }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  listConversations: () => invoke<Conversation[]>("list_conversations"),
  createConversation: (title: string, model: string | null) =>
    invoke<number>("create_conversation", { title, model }),
  deleteConversation: (id: number) =>
    invoke<void>("delete_conversation", { id }),
  renameConversation: (id: number, title: string) =>
    invoke<void>("rename_conversation", { id, title }),
  listMessages: (conversationId: number) =>
    invoke<Message[]>("list_messages", { conversationId }),
  addMessage: (
    conversationId: number,
    role: string,
    content: string,
    model?: string | null,
  ) => invoke<number>("add_message", {
    conversationId,
    role,
    content,
    model: model ?? null,
  }),
  deleteMessage: (id: number) => invoke<void>("delete_message", { id }),

  // Memory
  addMemory: (args: {
    content: string;
    conversationId?: number | null;
    sourceMsgId?: number | null;
    tags?: string;
    embedding?: number[];
    status?: "active" | "pending" | "archived";
  }) => invoke<number>("add_memory", {
    content: args.content,
    conversationId: args.conversationId ?? null,
    sourceMsgId: args.sourceMsgId ?? null,
    tags: args.tags ?? "",
    embedding: args.embedding ?? null,
    status: args.status ?? "active",
  }),
  listMemories: (status?: "active" | "pending" | "archived") =>
    invoke<Memory[]>("list_memories", { status: status ?? null }),
  deleteMemory: (id: number) => invoke<void>("delete_memory", { id }),
  updateMemoryStatus: (id: number, status: "active" | "pending" | "archived") =>
    invoke<void>("update_memory_status", { id, status }),
  touchMemory: (id: number) => invoke<void>("touch_memory", { id }),
  touchMemories: (ids: number[]) => invoke<void>("touch_memories", { ids }),
  searchMemoriesKeyword: (query: string, limit?: number) =>
    invoke<Memory[]>("search_memories_keyword", { query, limit: limit ?? 5 }),
  searchMemoriesVector: (embedding: number[], limit?: number, minScore?: number) =>
    invoke<Memory[]>("search_memories_vector", {
      embedding,
      limit: limit ?? 5,
      minScore: minScore ?? 0.55,
    }),
  findDuplicateMemory: (embedding: number[], threshold?: number) =>
    invoke<number | null>("find_duplicate_memory", { embedding, threshold: threshold ?? 0.85 }),

  // Agent tools
  agentReadFile: (path: string, offset?: number, limit?: number) =>
    invoke<ReadResult>("agent_read_file", { path, offset: offset ?? null, limit: limit ?? null }),
  agentListDir: (path: string) =>
    invoke<DirListing>("agent_list_dir", { path }),
  agentRunShell: (command: string, opts?: ShellOpts, opId?: string) =>
    invoke<ShellResult>("agent_run_shell", {
      command,
      opts: opts ?? null,
      opId: opId ?? null,
    }),
  agentCancelShell: (opId: string) =>
    invoke<void>("agent_cancel_shell", { opId }),
  agentWriteFile: (path: string, content: string) =>
    invoke<void>("agent_write_file", { path, content }),
  agentEditFile: (path: string, oldString: string, newString: string, replaceAll?: boolean) =>
    invoke<EditResult>("agent_edit_file", {
      path,
      oldString,
      newString,
      replaceAll: replaceAll ?? null,
    }),
  agentFileExists: (path: string) =>
    invoke<ExistsResult>("agent_file_exists", { path }),
  agentSearchFiles: (path: string, pattern: string, glob?: string, regex?: boolean) =>
    invoke<SearchResult>("agent_search_files", {
      path, pattern,
      glob: glob ?? null,
      regex: regex ?? null,
    }),
  agentMultiEdit: (path: string, edits: EditOp[]) =>
    invoke<MultiEditResult>("agent_multi_edit", { path, edits }),
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
  agentApplescriptRun: (script: string) =>
    invoke<ShellResult>("agent_applescript_run", { script }),
  agentHttpRequest: (input: HttpReqInput) =>
    invoke<HttpResp>("agent_http_request", { input }),
  agentFindDefinition: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_definition", { symbol, path: path ?? null }),
  agentFindReferences: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_references", { symbol, path: path ?? null }),
  agentFormatCode: (path: string) =>
    invoke<FormatResult>("agent_format_code", { path }),

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

  // Agent audit log
  agentAuditRecord: (entry: AgentAuditEntry) =>
    invoke<void>("agent_audit_record", { entry }),
  agentAuditList: (filter?: AgentAuditFilter) =>
    invoke<AgentAuditRow[]>("agent_audit_list", { filter: filter ?? null }),
  agentAuditPurge: (days: number) =>
    invoke<number>("agent_audit_purge", { days }),
  agentAuditStats: () => invoke<AgentAuditStats>("agent_audit_stats"),

  // Native inference (alpha)
  nativeSupported: () => invoke<boolean>("native_supported"),
  nativeLoadModel: (modelId: string) =>
    invoke<void>("native_load_model", { modelId }),
  nativeUnloadModel: () => invoke<void>("native_unload_model"),
  nativeCurrentModel: () => invoke<string | null>("native_current_model"),
  nativeChatStream: (args: {
    op_id: string;
    messages: { role: string; content: string }[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  }) => invoke<string>("native_chat_stream", { args }),
};
