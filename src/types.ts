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

export interface DirListing {
  entries: DirEntry[];
  truncated: boolean;
}

export interface ReadResult {
  content: string;
  bytes_read: number;
  total_bytes: number;
  truncated: boolean;
  binary: boolean;
}

export interface EditOp {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface MultiEditResult {
  edits_applied: number;
  total_replacements: number;
  new_size: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  cwd: string;
}

export interface WindowGeometry {
  width: number;
  height: number;
  x?: number | null;
  y?: number | null;
}

export interface AppSettings {
  workspace_root?: string | null;
  last_model?: string | null;
  last_backend?: string | null;
  memory_mode?: string | null;
  active_preset_id?: string | null;
  embedding_model?: string | null;
  recall_threshold?: number | null;
  window?: WindowGeometry | null;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
}

export interface EditResult {
  replacements: number;
  new_size: number;
}

export interface ExistsResult {
  exists: boolean;
  kind?: "file" | "dir" | "symlink";
  size?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  files_scanned: number;
  truncated_hits: boolean;
  truncated_scan: boolean;
}

export type ShellRisk = "normal" | "destructive" | "pipe-from-network" | "privileged";

export interface ShellOpts {
  cwd?: string;
  env?: [string, string][];
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
