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

/** Live progress for an `ollama pull`, emitted as `ollama-pull-progress`. */
export interface OllamaPullProgress {
  /** Model id being pulled (matches the pull arg). */
  name: string;
  /** ANSI-stripped status line, e.g. "pulling f5ee… 24% · 5.7 GB/23 GB · 126 MB/s · 2m24s". */
  status: string;
  /** Parsed percent 0–100, or null for non-percentage frames (manifest, verify…). */
  percent: number | null;
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

/** Status of the managed `llmpm serve` process (OpenAI-compatible local API). */
export interface LlmpmServeStatus {
  serving: boolean;
  repo: string | null;
  port: number | null;
  /** `http://localhost:<port>/v1` when serving — register as a custom backend. */
  base_url: string | null;
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
  /** User-authored "About You" profile. Absent on legacy installs. */
  user_profile?: UserProfile | null;
}

/**
 * Explicit, user-edited identity facts injected into chat + workflow system
 * prompts so the model knows who the user is. Never auto-populated.
 */
export interface UserProfile {
  /** Master switch — when false the profile is ignored even if filled. */
  enabled: boolean;
  name?: string | null;
  occupation?: string | null;
  location?: string | null;
  /** Free-text "anything else the AI should know about you". */
  about?: string | null;
  /** Free-text "how the AI should respond" (tone, format, length). */
  response_style?: string | null;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  /** Remote (streamable-HTTP) endpoint. When set, this is a remote server and
   *  command/args/env are ignored; the token lives in the Keychain. */
  url?: string;
}

export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  status: string;
  tool_count: number;
  last_error?: string | null;
  /** "stdio" or "remote". */
  transport?: string;
}

/** A normalized MCP registry listing (official registry or PulseMCP). */
export interface McpRegistryEntry {
  id: string;
  name: string;
  title: string;
  description: string;
  transport: "remote" | "package" | "unknown";
  remote_url: string | null;
  package_registry: string | null; // "npm" | "pypi" | …
  package_name: string | null;
  stars: number | null;
  homepage: string | null;
  source: string; // "official" | "pulse"
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

export interface ShellOpts {
  cwd?: string;
  env?: [string, string][];
  /** Per-call wall-clock budget in seconds. Clamped to [1, 600] server-side;
   * `undefined` falls back to the 30s default. */
  timeout_secs?: number;
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
  /** Optional workflow_runs.id — populated by the workflow runner so audit
   * rows produced inside a workflow can be filtered out of the per-chat
   * view and linked back to the run that created them. */
  workflow_run_id?: number | null;
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
  workflow_run_id: number | null;
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
  /**
   * Per-card system prompt override. When non-empty, this REPLACES the
   * `preset.systemPromptOverride` value when the card runs — so a card can
   * customize behavior without forcing the user to create a brand-new preset.
   * Null/absent/empty = fall back to the preset's system prompt (legacy
   * behavior). The env block (workspace + date + tools) is always appended
   * after this string by `buildSystemPrompt`.
   */
  systemPrompt?: string | null;
  tools: string[];
  schedule: string | null;
  backend: string | null;
  /**
   * When true, this card auto-approves its own tool calls without prompting —
   * on BOTH manual and scheduled runs (the CardForm UI states this) — but only
   * for tool names in its `tools` allowlist. Non-listed tools are always
   * refused, and irreversible tools (delete_path/kill_process/agent_undo) are
   * never auto-approved even when unattended. When false, the card uses the
   * normal deny-all/confirmation gate. Default false.
   */
  unattended?: boolean;
  /**
   * Specific model id this agent runs on. Null/absent = fall back to the
   * backend's current model.
   */
  model?: string | null;
  /**
   * False/absent = the card sits in the "deck" (created but not on the
   * canvas); true = placed on the workflow canvas at its x/y.
   */
  placed?: boolean;
  x: number;
  y: number;
  /**
   * Phase 1.6 retry policy. When set, the runner re-invokes the agent
   * loop up to `max` additional times if the card returns `status:
   * error`. Each retry sleeps `backoff_ms` (default 1000) — backoff is
   * NOT exponential by default to keep the UX predictable.
   *
   * Null/absent = no retries (default; matches v1 behavior).
   */
  retry?: { max: number; backoff_ms?: number } | null;
  /**
   * Phase 1.3 per-card model parameters. Threaded through to the
   * agent-loop `params` field which the backend client honors.
   * Null/absent fields fall back to the backend default.
   */
  params?: { temperature?: number | null; top_p?: number | null; max_tokens?: number | null } | null;
  /**
   * Optional accent color for the card's canvas node — a hex string from
   * {@link WORKFLOW_CARD_COLORS}. Null/absent = the default neutral
   * surface. Purely cosmetic: lets the user colour-code agents on a
   * busy canvas (e.g. all researchers blue, all writers green).
   */
  color?: string | null;
}

/**
 * Curated accent palette for workflow card nodes. Hand-picked, readable on
 * the dark canvas, and distinct from each other + from the run-state badge
 * colours (idle grey / running amber / done green / failed red). `value` is
 * stored verbatim in `WorkflowCard.color`; `null` is the neutral default.
 */
export const WORKFLOW_CARD_COLORS: ReadonlyArray<{ name: string; value: string | null }> = [
  { name: "Default", value: null },
  { name: "Indigo", value: "#6366f1" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Emerald", value: "#10b981" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Rose", value: "#f43f5e" },
  { name: "Violet", value: "#a855f7" },
  { name: "Slate", value: "#64748b" },
];

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

/**
 * A persisted roundtable OUTCOME (a completed run's transcript), stored in
 * db.sqlite so it survives restart. `RoundtableRunSummary` is the cheap list
 * row; `RoundtableRun` adds the full `transcript_json` blob (a JSON-encoded
 * {config, turns, totals, endReason, completedAt}).
 */
export interface RoundtableRunSummary {
  id: number;
  /** The frontend SavedTable id this outcome came from (null = ad-hoc run). */
  table_id: string | null;
  name: string;
  topic: string;
  turns: number;
  created_at: number;
}

export interface RoundtableRun extends RoundtableRunSummary {
  transcript_json: string;
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
 * Procedural-memory skill saved by an agent during a workflow run.
 * Skills are agent-authored sequences of tool calls — see the
 * `workflow_save_skill` tool on the Rust side. The renderer surfaces
 * them in `SkillsPanel` so the user can inspect or remove them.
 *
 * `last_used_at` is null until an agent re-invokes the skill via the
 * `workflow_use_skill` tool; `invocation_count` is the lifetime count.
 */
export interface SkillSummary {
  id: number;
  name: string;
  description: string;
  last_used_at: number | null;
  invocation_count: number;
}

/** Full skill row including the `steps_json` payload for inspection. */
export interface SkillFull extends SkillSummary {
  workflow_id: number;
  /** JSON-encoded `[{tool, args}, ...]` — pretty-printed for display. */
  steps_json: string;
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
  // Per-card system prompt override. Hard-cap at 16 KB so a corrupt or
  // adversarial graph_json blob can't push a runaway-size string into every
  // run's context window. Anything past the cap is truncated rather than
  // dropping the card entirely.
  const SYSTEM_PROMPT_MAX = 16_384;
  const rawSys = typeof c.systemPrompt === "string" ? c.systemPrompt : null;
  const systemPrompt =
    rawSys && rawSys.length > SYSTEM_PROMPT_MAX ? rawSys.slice(0, SYSTEM_PROMPT_MAX) : rawSys;
  // Card accent color: only accept a value that's in the curated palette
  // (or null). A corrupt/adversarial blob can't inject an arbitrary CSS
  // string into the node's inline `style` this way.
  const color =
    typeof c.color === "string" && WORKFLOW_CARD_COLORS.some((p) => p.value === c.color)
      ? c.color
      : null;
  return {
    id: c.id,
    name: c.name,
    preset: c.preset,
    prompt: c.prompt,
    systemPrompt,
    color,
    tools,
    schedule: typeof c.schedule === "string" ? c.schedule : null,
    backend: typeof c.backend === "string" ? c.backend : null,
    unattended: c.unattended === true,
    model: typeof c.model === "string" ? c.model : null,
    // Legacy workflows pre-date the deck/canvas split — every card was on the
    // canvas. Missing `placed` therefore defaults to `true` so old workflows
    // don't load with their cards stranded in the deck. Only an explicit
    // `placed: false` puts a card in the deck.
    placed: c.placed === false ? false : true,
    // Reject NaN, ±Infinity, and absurd magnitudes — `typeof NaN === "number"`
    // and React Flow's viewport math goes off the rails if a node lands at
    // 1e308. A finite range of ±1e6 covers every reasonable canvas position.
    x: typeof c.x === "number" && Number.isFinite(c.x) && Math.abs(c.x) <= 1e6 ? c.x : 0,
    y: typeof c.y === "number" && Number.isFinite(c.y) && Math.abs(c.y) <= 1e6 ? c.y : 0,
    // Phase 1.6 retry policy. Caps: max ≤ 5 retries (anything higher
    // is almost always a config mistake), backoff_ms ≤ 60s.
    retry: (() => {
      const r = c.retry as Record<string, unknown> | null | undefined;
      if (!r || typeof r !== "object") return null;
      const max = typeof r.max === "number" && Number.isFinite(r.max) ? Math.max(0, Math.min(5, Math.floor(r.max))) : null;
      if (max === null || max === 0) return null;
      const rawBackoff = typeof r.backoff_ms === "number" && Number.isFinite(r.backoff_ms) ? r.backoff_ms : 1000;
      const backoff = Math.max(0, Math.min(60_000, Math.floor(rawBackoff)));
      return { max, backoff_ms: backoff };
    })(),
    // Phase 1.3 per-card model params. Each field independently
    // clamped; null/absent falls through to backend defaults.
    params: (() => {
      const p = c.params as Record<string, unknown> | null | undefined;
      if (!p || typeof p !== "object") return null;
      const clamp = (v: unknown, lo: number, hi: number): number | null => {
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        return Math.max(lo, Math.min(hi, v));
      };
      const temperature = clamp(p.temperature, 0, 2);
      const top_p = clamp(p.top_p, 0, 1);
      const max_tokens = (() => {
        if (typeof p.max_tokens !== "number" || !Number.isFinite(p.max_tokens)) return null;
        if (p.max_tokens <= 0) return null;
        return Math.max(1, Math.min(131072, Math.floor(p.max_tokens)));
      })();
      if (temperature == null && top_p == null && max_tokens == null) return null;
      return { temperature, top_p, max_tokens };
    })(),
  };
}

/** Parse a backend `RawWorkflow` row into a typed `Workflow`. */
export function parseWorkflow(raw: RawWorkflow): Workflow {
  let graph: WorkflowGraph = { cards: [], edges: [] };
  try {
    const parsed = JSON.parse(raw.graph_json) as Partial<WorkflowGraph>;
    if (parsed && Array.isArray(parsed.cards) && Array.isArray(parsed.edges)) {
      // Drop or normalize malformed cards; drop edges to unknown card ids.
      // Duplicate ids would collide in React's key map and silently drop
      // one card from the runner's `byId` Map — keep the first occurrence
      // and discard the rest with a one-line audit signal.
      const seen = new Set<string>();
      const cards: WorkflowCard[] = [];
      for (const raw of parsed.cards) {
        const c = normalizeWorkflowCard(raw);
        if (c === null) continue;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        cards.push(c);
      }
      const ids = seen;
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

/* ── Workflow skills (procedural memory) ─────────────────────────────── */

/**
 * Summary row returned by `workflow_skill_list`. `last_used_at` and
 * `invocation_count` reflect how often the skill has been replayed via
 * `workflow_invoke_skill` — useful for ranking the picker.
 */
export interface SkillSummary {
  id: number;
  name: string;
  description: string;
  last_used_at: number | null;
  invocation_count: number;
}

/**
 * Full skill row returned by `workflow_skill_get`. `steps_json` is the
 * literal SQLite column — a JSON-encoded array of `{tool, args}` step
 * descriptors that the invoker replays through `executeTool`.
 */
export interface SkillFull extends SkillSummary {
  workflow_id: number;
  steps_json: string;
  created_at: number;
}

/* ── Claude Skills (Anthropic-format imported skills) ─────────────────── */

/**
 * Summary row for a Claude Skill — a user-imported Anthropic SKILL.md
 * folder living in the global library. Distinct from `SkillSummary`,
 * which is a per-workflow procedural memory. Claude Skills are mounted
 * by chat-mode agents on demand via `list_claude_skills()` and
 * `load_claude_skill(name)`.
 *
 * `enabled` controls whether the chat agent can see the skill;
 * `pinned` is purely a UI hint for ordering / starring favorites.
 */
export interface ClaudeSkillSummary {
  id: number;
  name: string;
  description: string;
  source_path: string;
  enabled: boolean;
  pinned: boolean;
}

/**
 * Full Claude Skill row returned by `claude_skill_get`. Carries the
 * imported SKILL.md body and the JSON-encoded `allowed_tools` field
 * Anthropic skills declare in their frontmatter. The body is rendered
 * verbatim in the View-Body sub-modal; `allowed_tools_json` is parsed
 * client-side into chips so the user can see what the skill expects.
 *
 * Per the spec, Froglips translates those declared tool names to its
 * own dispatch table at runtime; the chips are informational only.
 */
export interface ClaudeSkillRow extends ClaudeSkillSummary {
  body_md: string;
  allowed_tools_json: string | null;
  imported_at: number;
}

