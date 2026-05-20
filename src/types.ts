export interface ModelEntry {
  id: string;
  size_bytes: number;
  backend: "mlx" | "ollama";
}

export interface AllModels {
  mlx: ModelEntry[];
  ollama: ModelEntry[];
  mlx_error?: string | null;
  ollama_error?: string | null;
}

export interface ServerStatus {
  running: boolean;
  ready: boolean;
  model: string | null;
  backend: string | null;
  host: string;
  port: number;
  last_error?: string | null;
}

export interface Conversation {
  id: number;
  title: string;
  model: string | null;
  created_at: number;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface Message {
  id?: number;
  conversation_id: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  created_at?: number;
  model?: string | null;
  /** Client-side stable key for messages not yet persisted. Set on creation. */
  _tmpKey?: string;
  /** Tool calls emitted by the model (agent mode only). */
  tool_calls?: ToolCall[];
  /** Matches the tool_call id this result is for (agent mode only). */
  tool_call_id?: string;
  /** Display name of the tool that produced this result (agent mode only). */
  tool_name?: string;
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size?: number;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface Memory {
  id: number;
  content: string;
  conversation_id: number | null;
  source_msg_id: number | null;
  tags: string;
  status: "active" | "pending" | "archived";
  created_at: number;
  last_used_at: number | null;
  score?: number;
}

export type MemoryMode = "off" | "manual" | "queue" | "direct";
