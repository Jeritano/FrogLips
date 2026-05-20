export interface ModelEntry {
  id: string;
  size_bytes: number;
  backend: "mlx" | "ollama" | "native";
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

export interface WebFetchResult {
  url: string;
  status: number;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  hits: WebSearchHit[];
}

export interface PdfResult {
  content: string;
  bytes_read: number;
  total_bytes: number;
  truncated: boolean;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
}

export interface HttpReqInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_secs?: number;
}

export interface HttpResp {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  truncated: boolean;
}

export interface BrowserNavigateResult {
  status: number;
  title: string;
  url: string;
  screenshot_base64: string;
}

export interface BrowserOkResult {
  ok: boolean;
}

export interface BrowserScreenshotResult {
  base64: string;
}

export interface BrowserTextResult {
  text: string;
}

export interface FormatResult {
  formatter: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

export type TaskStatus = "pending" | "running" | "done" | "cancelled" | "failed";

export interface TaskInfo {
  id: string;
  command: string;
  status: TaskStatus;
  created_at: number;
  finished_at?: number | null;
  result?: ShellResult | null;
  error?: string | null;
}

export interface AskUserRequest {
  id: string;
  question: string;
  hint?: string | null;
}

export interface WindowGeometry {
  width: number;
  height: number;
  x?: number | null;
  y?: number | null;
}

export interface CustomBackend {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key?: string | null;
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
  theme?: "dark" | "light" | null;
  custom_backends?: CustomBackend[] | null;
  mcp_servers?: McpServerConfig[] | null;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  status: string;
  tool_count: number;
  last_error?: string | null;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
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

export type MemoryScope = "global" | "project" | "conversation";

export interface Memory {
  id: number;
  content: string;
  conversation_id: number | null;
  source_msg_id: number | null;
  tags: string;
  status: "active" | "pending" | "archived";
  created_at: number;
  last_used_at: number | null;
  scope: MemoryScope;
  project_root?: string | null;
  score?: number;
}

export type MemoryMode = "off" | "manual" | "queue" | "direct";

/** Mirror of `.froglips/policy.json` — see `src-tauri/src/policy.rs`. */
export interface ProjectPolicy {
  schema?: number | null;
  allowed_shell_prefixes?: string[] | null;
  allowed_write_paths?: string[] | null;
  denied_write_paths?: string[] | null;
  allowed_env_vars?: string[] | null;
  auto_approve_dangerous_tools?: string[] | null;
  max_iterations?: number | null;
  notes?: string | null;
  source_path?: string | null;
}

/** Tagged-decision returned by `policy_evaluate_*` Tauri commands. */
export type PolicyDecision = "auto" | "needs-confirm" | "denied";

/* ── Agent audit log ── */

export type AuditApproval = "auto" | "user_allowed" | "session_allowed" | "denied";
export type AuditOutcome = "ok" | "error" | "denied" | "stall_guard" | "duplicate" | "dry_run";

export interface AgentAuditEntry {
  ts?: number;
  conversation_id?: string | null;
  tool_name: string;
  args_json: string;
  result_body?: string;
  duration_ms: number;
  approval: AuditApproval;
  outcome: AuditOutcome;
  error_kind?: string | null;
}

export interface AgentAuditFilter {
  conversation_id?: string | null;
  tool_name?: string | null;
  since_ts?: number | null;
  until_ts?: number | null;
  limit?: number | null;
  offset?: number | null;
}

export interface AgentAuditRow {
  id: number;
  ts: number;
  conversation_id: string | null;
  tool_name: string;
  args_json: string;
  result_hash: string;
  result_size: number;
  duration_ms: number;
  approval: AuditApproval;
  outcome: AuditOutcome;
  error_kind: string | null;
}

export interface AgentAuditStats {
  total_calls_24h: number;
  top_tools_24h: Array<{ tool_name: string; count: number }>;
  avg_duration_ms_24h: Array<{ tool_name: string; avg_ms: number }>;
}

/* ── Filesystem watcher ─────────────────────────────────────────────────── */

export interface WatchHandle {
  watch_id: string;
  path: string;
  glob: string | null;
}

export interface WatchInfo {
  watch_id: string;
  path: string;
  glob: string | null;
  started_at: number;
  events_seen: number;
  buffered: number;
  dropped: number;
}

export interface WatchEvent {
  kind: "created" | "modified" | "deleted" | "renamed" | "other";
  path: string;
  ts: number;
}

export interface WatchPoll {
  events: WatchEvent[];
  next_ts: number;
  dropped: number;
}

/* ── RAG (project knowledge) ────────────────────────────────────────── */

export interface RagCorpusInfo {
  id: number;
  name: string;
  root_path: string;
  chunk_count: number;
  created_at: number;
  updated_at: number;
}

export interface RagIngestReport {
  corpus_id: number;
  files_seen: number;
  files_indexed: number;
  chunks_created: number;
  total_bytes: number;
  duration_ms: number;
}

export interface RagHit {
  path: string;
  snippet: string;
  score: number;
  start_byte: number;
  end_byte: number;
}
