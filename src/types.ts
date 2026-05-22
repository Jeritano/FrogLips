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

/* ── GGUF file picker (Phase 3 of cross-platform Native rollout) ────── */

/**
 * One locally-cached `.gguf` quant. Returned by `native_list_gguf_files` and
 * surfaced in the "Installed (GGUF)" section of ModelBrowser. `path` is an
 * absolute filesystem path the user can feed to `nativeLoadModel`.
 */
export interface GgufFile {
  repo: string;
  filename: string;
  path: string;
  size_bytes: number;
  /** Unix mtime in seconds (newest-first sort in the UI). */
  mtime: number;
}

/**
 * Payload of the `gguf-download-progress` Tauri event. Emitted at ~10 Hz by
 * `native_download_gguf`. `total_bytes` is `0` until the first chunk lands
 * (HF sometimes doesn't surface Content-Length immediately on resume).
 */
export interface GgufDownloadProgress {
  repo: string;
  filename: string;
  bytes_downloaded: number;
  total_bytes: number;
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
  /** Source conversation id when this conv was forked from another. */
  parent_conv_id?: number | null;
  /** Cutoff message id from the parent — messages with id ≤ this were copied. */
  parent_message_id?: number | null;
  /**
   * Per-conversation model parameter overrides, stored as a raw JSON string
   * (the literal SQLite column). Parse with `parseConversationParams`.
   * Shape: `{ temperature, top_p, max_tokens, system_prompt }`.
   */
  params?: string | null;
  /** Pinned conversations sort to the top of the sidebar. */
  pinned?: boolean | null;
  /** User tags as a raw JSON array string (e.g. `["work","urgent"]`). */
  tags?: string | null;
}

/** One match returned by `search_messages` — a conversation id + snippet. */
export interface MessageSearchHit {
  conversation_id: number;
  snippet: string;
}

/**
 * Decoded per-conversation model parameters. Every field is nullable —
 * `null` means "use the backend default", matching today's behaviour.
 */
export interface ConversationParams {
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  system_prompt: string | null;
}

/** Direct-child branch summary, returned by `conversationListBranches`. */
export interface BranchInfo {
  id: number;
  title: string;
  created_at: number;
  parent_message_id?: number | null;
}

/** Recursive fork tree, returned by `conversationForkTree`. */
export interface ForkTree {
  id: number;
  title: string;
  created_at: number;
  parent_conv_id?: number | null;
  parent_message_id?: number | null;
  children: ForkTree[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

/**
 * Image attachment carried alongside a user message for vision-capable models.
 *
 * - `base64` is the *raw* base64 payload (no `data:` URI prefix). Ollama wants
 *   the bare string in its `images: []` array; the OpenAI-style backends
 *   (MLX, mistralrs) wrap it back into a `data:` URL at send time.
 * - We re-encode every drop to PNG via Canvas to strip EXIF (privacy) before
 *   base64-ing, so `mime` is always `image/png` for newly attached images but
 *   may be other types for images round-tripped from older sessions.
 */
export interface ChatImage {
  base64: string;
  mime: string;
  filename?: string;
  size_bytes: number;
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
  /** Image attachments (vision-capable models only). Persisted as JSON. */
  images?: ChatImage[];
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
  /** First-run setup wizard completion flag. Absent on legacy installs. */
  setup_complete?: boolean | null;
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

/* ── Session metrics (one row per `runAgentLoop` execution) ── */

export interface AgentSessionMetricsEntry {
  ts?: number;
  conversation_id: string;
  iterations: number;
  tool_calls: number;
  total_tool_ms: number;
  total_llm_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface AgentSessionMetricsRow {
  id: number;
  ts: number;
  conversation_id: string;
  iterations: number;
  tool_calls: number;
  total_tool_ms: number;
  total_llm_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ToolLatencyRow {
  tool_name: string;
  count: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

export interface ApprovalCount {
  approval: string;
  count: number;
}

export interface DashboardSummary {
  window_since_ts: number;
  window_until_ts: number;
  tool_counts: Array<{ tool_name: string; count: number }>;
  tool_latency: ToolLatencyRow[];
  approval_counts: ApprovalCount[];
  session_metrics: AgentSessionMetricsRow[];
  total_prompt_tokens: number;
  total_completion_tokens: number;
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

/* ── Workflows (agent orchestration) ────────────────────────────────── */

/**
 * One agent card on the workflow canvas — a configured agent run. `preset`
 * resolves via `loadAllPresets`; `tools` is a tool allowlist (empty = preset
 * default); `backend` is null to inherit the app default. `x`/`y` are canvas
 * coordinates and carry no runtime meaning.
 */
export interface WorkflowCard {
  id: string;
  name: string;
  preset: string;
  prompt: string;
  tools: string[];
  schedule: string | null;
  backend: string | null;
  /**
   * When true, a scheduler-triggered run auto-approves this card's tool calls
   * — but only for tool names in its own `tools` allowlist. Manual runs and
   * non-listed tools always use the normal confirmation gate. Default false.
   */
  unattended?: boolean;
  x: number;
  y: number;
}

/** Directed link between two cards (card ids). Linear chains only in v1. */
export interface WorkflowEdge {
  from: string;
  to: string;
}

/** The canvas graph — the unit persisted as `graph_json`. */
export interface WorkflowGraph {
  cards: WorkflowCard[];
  edges: WorkflowEdge[];
}

/**
 * A saved workflow. The backend stores the graph as a JSON string column
 * (`graph_json`); `parseWorkflow`/`serializeWorkflowGraph` convert to/from the
 * typed `graph` shape used everywhere in the frontend.
 */
export interface Workflow {
  id: number;
  name: string;
  graph: WorkflowGraph;
  created_at: number;
  updated_at: number;
}

/** Raw workflow row as returned by the Tauri commands (graph still a string). */
export interface RawWorkflow {
  id: number;
  name: string;
  graph_json: string;
  created_at: number;
  updated_at: number;
}

/** One recorded execution of a workflow. `results_json` is a JSON summary. */
export interface WorkflowRun {
  id: number;
  workflow_id: number;
  status: "ok" | "failed";
  results_json: string;
  created_at: number;
}

/**
 * Validate and normalize one raw card. Returns a well-formed `WorkflowCard`,
 * or `null` if required string fields are missing — a malformed card is
 * dropped rather than allowed to crash the runner (e.g. `card.tools.length`).
 */
function normalizeWorkflowCard(raw: unknown): WorkflowCard | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.id !== "string" ||
    typeof c.name !== "string" ||
    typeof c.preset !== "string" ||
    typeof c.prompt !== "string"
  ) {
    return null;
  }
  const tools = Array.isArray(c.tools)
    ? c.tools.filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: c.id,
    name: c.name,
    preset: c.preset,
    prompt: c.prompt,
    tools,
    schedule: typeof c.schedule === "string" ? c.schedule : null,
    backend: typeof c.backend === "string" ? c.backend : null,
    unattended: c.unattended === true,
    x: typeof c.x === "number" ? c.x : 0,
    y: typeof c.y === "number" ? c.y : 0,
  };
}

/** Parse a backend `RawWorkflow` row into a typed `Workflow`. */
export function parseWorkflow(raw: RawWorkflow): Workflow {
  let graph: WorkflowGraph = { cards: [], edges: [] };
  try {
    const parsed = JSON.parse(raw.graph_json) as Partial<WorkflowGraph>;
    if (parsed && Array.isArray(parsed.cards) && Array.isArray(parsed.edges)) {
      // Drop or normalize malformed cards; drop edges to unknown card ids.
      const cards = parsed.cards
        .map(normalizeWorkflowCard)
        .filter((c): c is WorkflowCard => c !== null);
      const ids = new Set(cards.map((c) => c.id));
      const edges = parsed.edges.filter(
        (e): e is WorkflowEdge =>
          !!e &&
          typeof (e as WorkflowEdge).from === "string" &&
          typeof (e as WorkflowEdge).to === "string" &&
          ids.has((e as WorkflowEdge).from) &&
          ids.has((e as WorkflowEdge).to),
      );
      graph = { cards, edges };
    }
  } catch {/* malformed column → empty graph */}
  return {
    id: raw.id,
    name: raw.name,
    graph,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

/** Serialize a typed graph back to the `graph_json` string the backend stores. */
export function serializeWorkflowGraph(graph: WorkflowGraph): string {
  return JSON.stringify(graph);
}

/**
 * Single entry scraped from <https://ollama.com/library>. Returned by the
 * `ollama_library_fetch` Tauri command. Mirrors the Rust `OllamaLibraryEntry`
 * struct in `src-tauri/src/ollama_library.rs` — keep these in sync.
 */
export interface OllamaLibraryEntry {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: number;
  tag_count: number;
  updated_relative: string;
}
