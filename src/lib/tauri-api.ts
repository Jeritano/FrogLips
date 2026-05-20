import { invoke } from "@tauri-apps/api/core";
import type {
  AllModels,
  AppSettings,
  Conversation,
  DirListing,
  EditOp,
  EditResult,
  ExistsResult,
  GitResult,
  Memory,
  Message,
  MultiEditResult,
  ReadResult,
  SearchResult,
  ServerStatus,
  ShellOpts,
  ShellResult,
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
  agentClassifyShell: (command: string) =>
    invoke<string>("agent_classify_shell", { command }),
  agentSetWorkspace: (path: string | null) =>
    invoke<string | null>("agent_set_workspace", { path }),
  agentGetWorkspace: () =>
    invoke<string | null>("agent_get_workspace"),

  // Settings
  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsSet: (patch: Partial<AppSettings>) =>
    invoke<AppSettings>("settings_set", { patch }),
};
