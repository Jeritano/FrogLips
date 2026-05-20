import { invoke } from "@tauri-apps/api/core";
import type {
  AllModels,
  Conversation,
  DirEntry,
  Memory,
  Message,
  ServerStatus,
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
  agentReadFile: (path: string) =>
    invoke<string>("agent_read_file", { path }),
  agentListDir: (path: string) =>
    invoke<DirEntry[]>("agent_list_dir", { path }),
  agentRunShell: (command: string) =>
    invoke<ShellResult>("agent_run_shell", { command }),
  agentWriteFile: (path: string, content: string) =>
    invoke<void>("agent_write_file", { path, content }),
};
