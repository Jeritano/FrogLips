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
 * One subsystem's recorded health — mirrors `Subsystem` in
 * `src-tauri/src/health.rs`. `state` is the coarse classification; `since` is
 * unix-seconds when the current state began.
 */
export interface HealthSubsystem {
  name: string;
  state: "ok" | "degraded" | "failed";
  reason: string;
  since: number;
}

/**
 * One agent-run checkpoint turn (item 4A) — mirrors `CheckpointTurn` in
 * `src-tauri/src/history.rs`. `turnIndex` is the position within the run; the
 * optional `tool*` fields are set for tool-result / tool-call turns.
 */
export interface CheckpointTurn {
  turn_index: number;
  role: string;
  content: string;
  tool_call_id?: string | null;
  tool_name?: string | null;
  model?: string | null;
}

/**
 * One rehydrated turn from an unfinished run's durable checkpoint (RESUME) —
 * mirrors `RunCheckpointTurn` in `src-tauri/src/history.rs`. `content` is the
 * lossless shadow the runner wrote; an assistant turn that carried tool_calls
 * holds a JSON `{ content, tool_calls }` envelope (the caller parses it back).
 */
export interface RunCheckpointTurn {
  turn_index: number;
  role: string;
  content: string;
  created_at: number;
  tool_call_id?: string | null;
  tool_name?: string | null;
  model?: string | null;
}

/**
 * The most-recent UNFINISHED agent run for a conversation (RESUME) — mirrors
 * `RunCheckpoint` in `src-tauri/src/history.rs`. Returned by
 * `agentRunLatestCheckpoint`; the frontend shows a review-before-continue
 * "Resume run" affordance from it and NEVER auto-resumes.
 */
export interface RunCheckpoint {
  run_id: string;
  started_at: number;
  updated_at: number;
  turns: RunCheckpointTurn[];
}

/**
 * Internal helper: mint a binding-aware approval token. Pre-mints into a
 * local before any further `await`, so a fast burst of dangerous calls
 * can't interleave their mint/consume across the renderer event loop.
 */
async function mintApproval(
  tool: string,
  payload?: ApprovalPayload,
): Promise<string> {
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
  EditOp,
  EditResult,
  ExistsResult,
  FormatResult,
  GitResult,
  HttpReqInput,
  HttpResp,
  McpServerInfo,
  McpToolDescriptor,
  McpRegistryEntry,
  Memory,
  Message,
  MessageSearchHit,
  MultiEditResult,
  ApplyPatchResult,
  MultiReadResult,
  PdfResult,
  PolicyDecision,
  ProjectPolicy,
  RagCorpusInfo,
  RagHit,
  RagIngestReport,
  ReadResult,
  ScreenshotResult,
  CuScreenshotResult,
  GatewayStatus,
  SearchResult,
  RawWorkflow,
  RoundtableRunSummary,
  RoundtableRun,
  ServerStatus,
  LlmpmServeStatus,
  ShellOpts,
  ShellResult,
  SystemInfo,
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

/**
 * One persisted workflow run — mirrors the `WorkflowRun` struct serialized by
 * `src-tauri/src/workflows.rs` (NOT the stale `WorkflowRun` in `types.ts`,
 * which predates this and carries the wrong field names). `started_at` is unix
 * seconds; `results_json` is the JSON-encoded {@link WorkflowRunResultRecord}
 * summary, or null for an older/empty run.
 */
export interface WorkflowRunRecord {
  id: number;
  workflow_id: number;
  started_at: number;
  status: string;
  results_json: string | null;
}

/**
 * Parsed shape of a run's `results_json` — the persisted form of the runner's
 * `WorkflowRunResult` (see `src/lib/workflow/runner.ts`). Only the fields the
 * Run History view reads are declared; unknown fields are tolerated.
 */
export interface WorkflowRunResultRecord {
  status: "ok" | "failed";
  cards: Array<{
    cardId: string;
    name: string;
    status: "ok" | "error" | "skipped" | "aborted";
    output: string;
    error?: string;
  }>;
  halted?: {
    cardId: string;
    cardName: string;
    key: string;
    value: string;
  } | null;
}

/** Read-only storage stats from the DB maintenance agent (WS4). */
export interface MaintenanceStats {
  db_bytes: number;
  wal_bytes: number;
  archive_bytes: number;
  conversations: number;
  messages: number;
  messages_archived: number;
  agent_audit_rows: number;
  model_perf_rows: number;
  agent_session_metrics_rows: number;
}

/** Outcome of one maintenance phase. */
export interface MaintenancePhaseResult {
  ran: boolean;
  skipped_reason: string | null;
  rows: number;
}

/** Full report from a maintenance pass. */
export interface MaintenanceReport {
  trigger: "scheduled" | "boot" | "manual" | "vacuum";
  started_at: number;
  duration_ms: number;
  bytes_before: number;
  bytes_after: number;
  caps: MaintenancePhaseResult;
  archive: MaintenancePhaseResult;
  reclaim: MaintenancePhaseResult;
  vacuumed: boolean;
}

/**
 * Authoritative per-model facts (item 2) returned by `model_metadata` —
 * mirrors `ModelMetadata` in `src-tauri/src/models.rs`. All fields are
 * best-effort: `null` means the backend didn't expose the value and the
 * caller should keep its name-based heuristic.
 */
export interface ModelMetadata {
  /** Real context window in tokens, or null when unknown. */
  context_length: number | null;
  /** Whether the model accepts images, or null when undeterminable. */
  vision: boolean | null;
  /** Which authority answered: "ollama" | "mlx-config" | "native-config" | "none". */
  source: string;
}

export const api = {
  listAllModels: () => invoke<AllModels>("list_all_models"),
  /**
   * Authoritative context window + vision capability for one model, sourced
   * from the backend itself (Ollama `/api/show`, or the MLX/native HF
   * `config.json`) instead of a name regex. `backend` is "ollama" | "mlx" |
   * "native". Never throws meaningfully — returns all-null on an unreachable
   * daemon / missing config so callers fall back to the heuristic.
   */
  modelMetadata: (model: string, backend: string) =>
    invoke<ModelMetadata>("model_metadata", { model, backend }),
  startServer: (model: string, backend: string) =>
    invoke<ServerStatus>("start_server", { model, backend }),
  stopServer: () => invoke<void>("stop_server"),
  serverStatus: () => invoke<ServerStatus>("server_status"),

  /** Live host-machine facts (RAM / cores / CPU) for hardware-aware model sizing. */
  systemInfo: () => invoke<SystemInfo>("system_info"),

  // ── llmpm (LLM package manager: install + serve HF models locally) ─────
  /** Whether the `llmpm` CLI is on the machine + its resolved path. */
  llmpmAvailable: () =>
    invoke<{ available: boolean; bin: string | null }>("llmpm_available"),
  /** Installed llmpm models (scanned from ~/.llmpm/models). */
  llmpmInstalledModels: () =>
    invoke<{ repo: string; backend: string }[]>("llmpm_installed_models"),
  /** Install a model. Emits `llmpm-install-progress {repo,line}`; resolves on
   *  completion. `quant` (e.g. "Q4_K_M") makes a GGUF install non-interactive. */
  llmpmInstall: (repo: string, quant?: string) =>
    invoke<void>("llmpm_install", { repo, quant: quant ?? null }),
  /** Serve a model; resolves once the OpenAI endpoint is ready. Returns the
   *  base_url to register as a custom backend. */
  llmpmServe: (repo: string) =>
    invoke<LlmpmServeStatus>("llmpm_serve", { repo }),
  /** Stop the managed llmpm serve process. */
  llmpmStop: () => invoke<void>("llmpm_stop"),
  /** Current serve status. */
  llmpmServeStatus: () => invoke<LlmpmServeStatus>("llmpm_serve_status"),

  /** Search the ModelScope text-gen catalog (proxied through Rust — their API
   *  sends no CORS headers so the webview can't fetch it directly). */
  modelscopeSearch: (query?: string) =>
    invoke<
      {
        repo: string;
        name: string;
        org: string;
        downloads: number;
        stars: number;
        last_updated: number;
        task: string | null;
        support_api_inference: boolean;
        avatar: string | null;
        cover: string | null;
      }[]
    >("modelscope_search", { query: query ?? null }),

  /** Append a single line to ~/.local-llm-app/diag.log. Best-effort —
   *  callers should `.catch(() => undefined)`. Used for on-disk
   *  diagnostic capture (in-memory ring is volatile across restart). */
  appendDiagLog: (line: string) => invoke<void>("append_diag_log", { line }),
  pullOllamaModel: (name: string) =>
    invoke<string>("pull_ollama_model", { name }),
  pullHfModel: (repoId: string) => invoke<string>("pull_hf_model", { repoId }),
  // True while a HuggingFace pull is in flight for this repo. Used to refuse
  // auto-starting a model that is still downloading (which would spawn a second
  // racing downloader and corrupt the pull).
  modelDownloadActive: (repoId: string) =>
    invoke<boolean>("model_download_active", { repoId }),
  // Scrape + parse <https://ollama.com/library>. Cached server-side for 10
  // minutes. Throws on network/parse failure so the caller can fall back to
  // the curated `OLLAMA` array.
  ollamaLibraryFetch: () =>
    invoke<OllamaLibraryEntry[]>("ollama_library_fetch"),
  deleteOllamaModel: (name: string) =>
    invoke<void>("delete_ollama_model", { name }),
  deleteMlxModel: (repoId: string) =>
    invoke<void>("delete_mlx_model", { repoId }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),

  // Local crash log — returns the last ~64 KB of `~/.local-llm-app/crash.log`,
  // or an empty string when no crashes have been recorded.
  readCrashLog: () => invoke<string>("read_crash_log"),

  // Reveal the log/data directory (`~/.local-llm-app`, home of app.log /
  // crash.log / diag.log / the DB) in Finder. Backend-driven LaunchServices
  // open — no path crosses from the caller.
  revealLogDir: () => invoke<void>("reveal_log_dir"),

  // Subsystem health/degradation registry snapshot. Observational only — the
  // UI renders a "Degraded" pill from any non-`ok` entry and opens the
  // Diagnostics panel. Empty array = nothing degraded.
  healthSnapshot: () => invoke<HealthSubsystem[]>("health_snapshot"),

  // DB recovery / availability notices for the startup banner. `dbRecoveryNotice`
  // returns the quarantine path of a corrupt DB found + moved aside on boot (a
  // fresh DB was recreated in its place); `dbUnavailableNotice` returns the
  // pool-build failure string (disk full, permission denied, …) so the UI can
  // surface the cause instead of a cascade of generic IPC errors. Both `null`
  // when the DB is healthy.
  dbRecoveryNotice: () => invoke<string | null>("db_recovery_notice"),
  dbUnavailableNotice: () => invoke<string | null>("db_unavailable_notice"),

  // Data backup / export / import. `backupDatabase` writes a single-file copy
  // of the SQLite DB; `exportData` serialises conversations + messages +
  // memory to JSON; `importData` additively merges such a JSON export back in
  // and throws on a schema mismatch.
  backupDatabase: (destPath: string) =>
    invoke<void>("backup_database", { destPath }),
  exportData: (destPath: string) => invoke<void>("export_data", { destPath }),
  importData: (srcPath: string) => invoke<void>("import_data", { srcPath }),
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
  /** [level (1=ok,2=warn,4=critical), total_ram_gb] */
  ramPressure: () => invoke<[number, number]>("ram_pressure"),
  /**
   * Native dictation (2026-06-11). webkitSpeechRecognition is default-denied
   * inside WKWebView (no wry speech permission delegate), so recognition
   * runs app-side: AVAudioEngine → SFSpeechRecognizer, transcripts arrive
   * via "dictation-partial" / "dictation-end" / "dictation-error" events.
   * The first start blocks on the macOS mic + speech TCC prompts.
   */
  dictationStart: () => invoke<void>("dictation_start"),
  dictationStop: () => invoke<void>("dictation_stop"),
  /** Record one per-reply perf sample into the durable ledger. */
  modelPerfRecord: (sample: {
    model: string;
    backend: string;
    ttft_ms: number;
    tok_per_sec: number;
    completion_tokens: number;
    cold_load: boolean;
  }) => invoke<void>("model_perf_record", { sample }),
  /** Per-model perf aggregates (warm-only TTFT; pure-decode tok/s). */
  modelPerfSummary: () =>
    invoke<
      Array<{
        model: string;
        backend: string;
        samples: number;
        avg_tok_per_sec: number;
        avg_ttft_ms: number;
        last_ts: number;
      }>
    >("model_perf_summary"),
  /** Message-level FTS5 search (BM25-ranked, snippeted). */
  searchMessagesFts: (query: string, limit: number) =>
    invoke<import("../types").FtsMessageHit[]>("search_messages_fts", {
      query,
      limit,
    }),
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
      } catch {
        /* fall through */
      }
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
  ) =>
    invoke<number>("add_message", {
      conversationId,
      role,
      content,
      model: model ?? null,
      // Persist as a JSON string in the messages.images TEXT column. Skipping
      // when there are no attachments keeps the column NULL for the common case.
      imagesJson: images && images.length > 0 ? JSON.stringify(images) : null,
    }),
  /** Durable per-iteration agent checkpoint (item 4A). Writes the run's turns
   *  atomically; idempotent on (runId, turnIndex). Checkpoint rows are invisible
   *  to listMessages — this persists a shadow record for a future recovery
   *  feature. Returns the number of turn rows written. */
  agentRunCheckpoint: (
    runId: string,
    convId: number,
    turns: CheckpointTurn[],
  ) => invoke<number>("agent_run_checkpoint", { runId, convId, turns }),
  /** RESUME: fetch the most-recent UNFINISHED run checkpoint for a conversation,
   *  or null when nothing is resumable. A pure read — performs no resume side
   *  effect. The caller shows a review-before-continue affordance and never
   *  auto-resumes. */
  agentRunLatestCheckpoint: (convId: number) =>
    invoke<RunCheckpoint | null>("agent_run_latest_checkpoint", { convId }),
  /** RESUME: mark a run's checkpoint set FINISHED so it's never re-offered for
   *  resume (on completion, dismissal, or after a successful resume). Idempotent;
   *  returns the number of shadow rows flipped. */
  agentRunClose: (runId: string, convId: number) =>
    invoke<number>("agent_run_close", { runId, convId }),
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
  }) =>
    invoke<number>("add_memory", {
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
    invoke<number | null>("find_duplicate_memory", {
      embedding,
      threshold: threshold ?? 0.85,
    }),
  /** Drop the Rust embedding cache (call on embedding-model change). */
  memoryInvalidateEmbeddingCache: () =>
    invoke<void>("memory_invalidate_embedding_cache"),
  // Scope mutators
  memoryPromote: (id: number) => invoke<void>("memory_promote", { id }),
  memoryDemote: (id: number) => invoke<void>("memory_demote", { id }),
  memorySetContext: (
    id: number,
    projectRoot?: string | null,
    convId?: number | null,
  ) =>
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
  mintToolApproval: (tool: string, payload?: ApprovalPayload) =>
    mintApproval(tool, payload),

  // Agent tools
  agentReadFile: (path: string, offset?: number, limit?: number) =>
    invoke<ReadResult>("agent_read_file", {
      path,
      offset: offset ?? null,
      limit: limit ?? null,
    }),
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
  agentRunCode: async (
    language: string,
    code: string,
    timeoutSecs?: number,
    opId?: string,
  ) =>
    invoke<ShellResult>("agent_run_code", {
      language,
      code,
      timeoutSecs: timeoutSecs ?? null,
      opId: opId ?? null,
      // Approval bound to language+code (same fields the Rust side hashes).
      approval: await mintApproval("agent_run_code", {
        command: code,
        text: language,
      }),
    }),
  agentWriteFile: async (path: string, content: string) =>
    invoke<void>("agent_write_file", {
      path,
      content,
      approval: await mintApproval("agent_write_file", { path }),
    }),
  // Multi-file write in a single call + single approval. The approval token is
  // bound to the sorted file paths joined by newline — the SAME string the
  // Rust `agent_write_files` binding recomputes and hashes (carried as the
  // `path` field of the approval payload). Sorting client-side makes the
  // binding order-independent so {a.ts, b.ts} and {b.ts, a.ts} mint/consume
  // the same token.
  agentWriteFiles: async (files: { path: string; content: string }[]) => {
    const joinedPaths = files
      .map((f) => f.path)
      .slice()
      .sort()
      .join("\n");
    return invoke<void>("agent_write_files", {
      files,
      approval: await mintApproval("agent_write_files", { path: joinedPaths }),
    });
  },
  agentEditFile: async (
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ) =>
    invoke<EditResult>("agent_edit_file", {
      path,
      oldString,
      newString,
      replaceAll: replaceAll ?? null,
      approval: await mintApproval("agent_edit_file", { path }),
    }),
  agentFileExists: (path: string) =>
    invoke<ExistsResult>("agent_file_exists", { path }),
  // Read-only multi-read — no approval (same gate as agentReadFile, per file).
  agentReadFiles: (paths: string[]) =>
    invoke<MultiReadResult>("agent_read_files", { paths }),
  agentSearchFiles: (
    path: string,
    pattern: string,
    glob?: string,
    regex?: boolean,
    context?: number,
  ) =>
    invoke<SearchResult>("agent_search_files", {
      path,
      pattern,
      glob: glob ?? null,
      regex: regex ?? null,
      context: context ?? null,
    }),
  // Multi-file unified-diff apply. The approval token is bound to the exact
  // patch text (the same string the Rust `agent_apply_patch` binding hashes,
  // carried as the `text` payload field) so a swapped diff can't reuse it.
  agentApplyPatch: async (patch: string) =>
    invoke<ApplyPatchResult>("agent_apply_patch", {
      patch,
      approval: await mintApproval("agent_apply_patch", { text: patch }),
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
    invoke<{ algorithm: string; hex: string; size_bytes: number }>(
      "agent_hash_file",
      {
        path,
        algorithm: algorithm ?? null,
      },
    ),
  agentDiffFiles: (left: string, right: string) =>
    invoke<{ diff: string; identical: boolean }>("agent_diff_files", {
      left,
      right,
    }),
  agentListProcesses: (filter?: string) =>
    invoke<{
      rows: Array<{
        pid: number;
        ppid: number;
        cpu_pct: number;
        mem_mib: number;
        command: string;
      }>;
      injection_warning?: string;
    }>("agent_list_processes", { filter: filter ?? null }),
  agentKillProcess: async (pid: number, signal?: string) =>
    invoke<{ pid: number; signal: string }>("agent_kill_process", {
      pid,
      signal: signal ?? null,
      approval: await mintApproval("agent_kill_process", { pid, signal }),
    }),
  agentListUndo: () =>
    invoke<
      Array<{
        path: string;
        kind: string;
        taken_at_ms: number;
        size_bytes: number;
        was_absent: boolean;
      }>
    >("agent_list_undo"),
  agentUndoLast: async () =>
    invoke<{
      path: string;
      kind: string;
      restored_bytes: number;
      was_absent: boolean;
    }>("agent_undo_last", { approval: await mintApproval("agent_undo_last") }),
  agentClearUndoStack: () => invoke<void>("agent_clear_undo_stack"),
  agentGitStatus: (path?: string) =>
    invoke<GitResult>("agent_git_status", { path: path ?? null }),
  agentGitDiff: (path?: string, staged?: boolean) =>
    invoke<GitResult>("agent_git_diff", {
      path: path ?? null,
      staged: staged ?? null,
    }),
  agentGitLog: (path?: string, limit?: number) =>
    invoke<GitResult>("agent_git_log", {
      path: path ?? null,
      limit: limit ?? null,
    }),
  agentGitShow: (reference: string, path?: string) =>
    invoke<GitResult>("agent_git_show", { reference, path: path ?? null }),
  agentGitBranches: (path?: string) =>
    invoke<GitResult>("agent_git_branches", { path: path ?? null }),
  agentGitCommit: async (message: string, path?: string) =>
    invoke<GitResult>("agent_git_commit", {
      message,
      path: path ?? null,
      approval: await mintApproval("agent_git_commit", { text: message, path }),
    }),
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

  /* ── Computer Use (gated macOS desktop control) ──────────────────────────
   * Each action mints an approval token bound to a canonical string the Rust
   * command reproduces verbatim (commands/agent.rs). Coordinates are ROUNDED
   * here so the same integers feed both the token binding and the invoke arg —
   * a float mismatch would otherwise reject the token. */

  /** Read-only Accessibility status. `prompt=true` triggers the macOS
   *  "open Accessibility settings" dialog when not yet granted. No approval. */
  agentCuCheckPermission: (prompt: boolean) =>
    invoke<boolean>("agent_cu_check_permission", { prompt }),
  agentCuScreenshot: async () =>
    invoke<CuScreenshotResult>("agent_cu_screenshot", {
      approval: await mintApproval("agent_cu_screenshot", {}),
    }),
  agentCuMove: async (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return invoke<unknown>("agent_cu_move", {
      x: xi,
      y: yi,
      approval: await mintApproval("agent_cu_move", { text: `${xi}|${yi}` }),
    });
  },
  agentCuClick: async (x: number, y: number, button: string, count: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    const b = button === "right" || button === "middle" ? button : "left";
    const c = count === 2 ? 2 : 1;
    return invoke<unknown>("agent_cu_click", {
      x: xi,
      y: yi,
      button: b,
      count: c,
      approval: await mintApproval("agent_cu_click", {
        text: `${xi}|${yi}|${b}|${c}`,
      }),
    });
  },
  agentCuDrag: async (x1: number, y1: number, x2: number, y2: number) => {
    const a = Math.round(x1);
    const b = Math.round(y1);
    const c = Math.round(x2);
    const d = Math.round(y2);
    return invoke<unknown>("agent_cu_drag", {
      x1: a,
      y1: b,
      x2: c,
      y2: d,
      approval: await mintApproval("agent_cu_drag", { text: `${a}|${b}|${c}|${d}` }),
    });
  },
  agentCuScroll: async (x: number, y: number, dx: number, dy: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    const dxi = Math.round(dx);
    const dyi = Math.round(dy);
    return invoke<unknown>("agent_cu_scroll", {
      x: xi,
      y: yi,
      dx: dxi,
      dy: dyi,
      approval: await mintApproval("agent_cu_scroll", {
        text: `${xi}|${yi}|${dxi}|${dyi}`,
      }),
    });
  },
  agentCuType: async (text: string) =>
    invoke<unknown>("agent_cu_type", {
      text,
      approval: await mintApproval("agent_cu_type", { text }),
    }),
  agentCuKey: async (keys: string) =>
    invoke<unknown>("agent_cu_key", {
      keys,
      approval: await mintApproval("agent_cu_key", { text: keys }),
    }),
  agentCuCursorPosition: () =>
    invoke<unknown>("agent_cu_cursor_position"),

  /* ── Messaging gateway (run the agent over chat platforms; v1 Telegram) ──
   * Bot token stored Keychain-side via messagingSetToken; the renderer never
   * holds it. The gateway long-polls in Rust + emits "messaging://inbound";
   * the frontend hook runs the agent (safe-tools-only) + replies via
   * messagingSend. */
  messagingSetToken: (channel: string, token: string) =>
    invoke<void>("messaging_set_token", { channel, token }),
  messagingHasToken: (channel: string) =>
    invoke<boolean>("messaging_has_token", { channel }),
  messagingValidate: (channel: string) =>
    invoke<string>("messaging_validate", { channel }),
  messagingStart: (channel: string) =>
    invoke<void>("messaging_start", { channel }),
  messagingStop: (channel: string) =>
    invoke<void>("messaging_stop", { channel }),
  messagingStatus: () => invoke<GatewayStatus[]>("messaging_status"),
  messagingSend: (channel: string, target: string, text: string) =>
    invoke<void>("messaging_send", { channel, target, text }),

  agentClipboardGet: () => invoke<string>("agent_clipboard_get"),
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
  agentCallApi: async (input: {
    api: string;
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: string;
    timeout_secs?: number;
  }) =>
    invoke<HttpResp>("agent_call_api", {
      input,
      // Bound to api|method|path — matches the Rust verify_bound payload.
      approval: await mintApproval("agent_call_api", {
        url: `${input.api}|${input.method}|${input.path}`,
      }),
    }),
  agentHttpRequest: async (input: HttpReqInput) =>
    invoke<HttpResp>("agent_http_request", {
      input,
      approval: await mintApproval("agent_http_request", { url: input.url }),
    }),
  agentFindDefinition: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_definition", {
      symbol,
      path: path ?? null,
    }),
  agentFindReferences: (symbol: string, path?: string) =>
    invoke<SearchResult>("agent_find_references", {
      symbol,
      path: path ?? null,
    }),
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
  agentWatchPath: async (path: string, glob?: string, debounceMs?: number) =>
    invoke<WatchHandle>("agent_watch_path", {
      path,
      glob: glob ?? null,
      debounceMs: debounceMs ?? null,
      approval: await mintApproval("agent_watch_path", { path }),
    }),
  agentListWatches: () => invoke<WatchInfo[]>("agent_list_watches"),
  agentPollWatch: (id: string, sinceMs?: number, maxEvents?: number) =>
    invoke<WatchPoll>("agent_poll_watch", {
      id,
      sinceMs: sinceMs ?? null,
      maxEvents: maxEvents ?? null,
    }),
  agentStopWatch: async (id: string) =>
    invoke<void>("agent_stop_watch", {
      id,
      approval: await mintApproval("agent_stop_watch", { text: id }),
    }),

  // Task queue. task_create runs `sh -c` like agent_run_shell, so it goes
  // through the same command-bound approval gate (SEC-HIGH 2026-05-30).
  taskCreate: async (command: string, cwd?: string) =>
    invoke<TaskInfo>("task_create", {
      command,
      cwd: cwd ?? null,
      approval: await mintApproval("task_create", { command }),
    }),
  taskStatus: (id: string) => invoke<TaskInfo>("task_status", { id }),
  taskList: () => invoke<TaskInfo[]>("task_list"),
  taskCancel: async (id: string) =>
    invoke<void>("task_cancel", {
      id,
      approval: await mintApproval("task_cancel", { text: id }),
    }),
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
  agentGetWorkspace: () => invoke<string | null>("agent_get_workspace"),
  /** Item 3: bracket an interactive agent run so a divergent workspace change
   *  mid-run is rejected. Returns the active-run count. Best-effort — callers
   *  should `.catch()` and proceed (the guard degrades gracefully if absent). */
  agentRunBegin: () => invoke<number>("agent_run_begin"),
  agentRunEnd: () => invoke<number>("agent_run_end"),
  /** Recovery hook: drain a leaked active-run counter from a previous page
   *  lifetime (renderer reload / crash). Safe to call once on startup; returns
   *  the number of leaked runs cleared (0 in the balanced case). */
  agentRunReset: () => invoke<number>("agent_run_reset"),

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
  ollamaStatus: () => invoke<"running" | "stopped" | "absent">("ollama_status"),

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
  // Connect a remote (streamable-HTTP) MCP server. Reuses the
  // `mcp_start_server` approval binding with the endpoint URL standing in for
  // the command (empty args/env). The token is stored in the Keychain by Rust.
  mcpStartRemoteServer: async (name: string, url: string, token?: string) => {
    const approval = await mintApproval("mcp_start_server", {
      mcp_command: url,
      mcp_args: [],
      mcp_env_keys: [],
    });
    return invoke<McpToolDescriptor[]>("mcp_start_remote_server", {
      name,
      url,
      token: token && token.trim() ? token.trim() : null,
      approval,
    });
  },
  // One-click OAuth: opens the system browser, runs discovery + PKCE, persists
  // the token, and starts the server. Same approval binding as the remote start.
  mcpOauthConnect: async (name: string, url: string) => {
    const approval = await mintApproval("mcp_start_server", {
      mcp_command: url,
      mcp_args: [],
      mcp_env_keys: [],
    });
    return invoke<McpToolDescriptor[]>("mcp_oauth_connect", {
      name,
      url,
      approval,
    });
  },
  mcpOauthRefresh: (name: string) =>
    invoke<boolean>("mcp_oauth_refresh", { name }),
  mcpRemoteHasToken: (name: string) =>
    invoke<boolean>("mcp_remote_has_token", { name }),
  mcpDeleteRemoteToken: (name: string) =>
    invoke<void>("mcp_delete_remote_token", { name }),
  mcpRegistrySearch: (source: string, query?: string) =>
    invoke<McpRegistryEntry[]>("mcp_registry_search", {
      source,
      query: query ?? null,
    }),
  mcpStopServer: (name: string) => invoke<void>("mcp_stop_server", { name }),
  mcpListServers: () => invoke<McpServerInfo[]>("mcp_list_servers"),
  mcpListTools: (name: string) =>
    invoke<McpToolDescriptor[]>("mcp_list_tools", { name }),
  mcpCallTool: async (
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) =>
    invoke<string>("mcp_call_tool", {
      server,
      tool,
      args,
      approval: await mintApproval("mcp_call_tool", {
        mcp_server: server,
        mcp_tool: tool,
      }),
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
  ragCorpusStale: (name: string) => invoke<boolean>("rag_corpus_stale", { name }),
  ragRebuildHybridIndex: (name: string) =>
    invoke<number>("rag_rebuild_hybrid_index", { name }),
  ragDeleteCorpus: (name: string) =>
    invoke<void>("rag_delete_corpus", { name }),
  /**
   * Open a RAG hit's source file in the user's default app (LaunchServices,
   * no shell). Pass the corpus name plus the hit's stored relative `path`
   * (`RagHit.path`); the backend reconstructs the absolute path from the
   * corpus's own recorded root and refuses anything escaping it. Byte-range
   * jump is not honored — this opens the file, not the exact chunk.
   */
  ragOpenHit: (corpusName: string, relPath: string) =>
    invoke<void>("rag_open_hit", { corpusName, relPath }),

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
    invoke<DashboardSummary>("agent_dashboard_summary", {
      filter: filter ?? null,
    }),

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

  /** Cancel an in-flight native chat stream by op_id. Best-effort; resolves
   *  true if a stream was actually pending. (2026-05-30) */
  nativeCancelChat: (opId: string) =>
    invoke<boolean>("native_cancel", { opId }),

  /**
   * Stream a chat completion from a custom OpenAI-compatible cloud backend.
   * The Rust side resolves base_url + model + the Keychain API key from
   * `backend_id`; only the id crosses IPC. Deltas arrive via
   * `custom-chunk:{op_id}` events (see `custom-client.ts`); the promise
   * resolves when generation completes.
   */
  customChatStream: (args: {
    op_id: string;
    backend_id: string;
    messages: { role: string; content: string }[];
    /** Per-call model override — required for the OpenRouter built-in
     *  (one backend, any catalogue model); optional for user backends. */
    model?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  }) =>
    invoke<void>("custom_chat_stream", {
      opId: args.op_id,
      backendId: args.backend_id,
      messages: args.messages,
      model: args.model,
      params: {
        temperature: args.temperature,
        top_p: args.top_p,
        max_tokens: args.max_tokens,
      },
    }),

  /**
   * Stream a TOOL-CALLING chat completion from a custom/OpenRouter backend
   * (agent loop + Flows). Same Keychain/SSRF posture as `customChatStream`;
   * `tools` carries the OpenAI tool schemas and `messages` carries the full
   * OpenAI shape (assistant `tool_calls` + `role:"tool"` results). Tool-call
   * deltas arrive via `custom-toolcall:{op_id}` events (see `custom-client.ts`).
   */
  customChatStreamTools: (args: {
    op_id: string;
    backend_id: string;
    /** Full OpenAI-shape messages (already serialized by `toOpenAiMessages`). */
    messages: unknown[];
    /** OpenAI tool/function schemas. */
    tools: unknown[];
    /** Per-call model override (required for the OpenRouter built-in). */
    model?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  }) =>
    invoke<void>("custom_chat_stream_tools", {
      opId: args.op_id,
      backendId: args.backend_id,
      messages: args.messages,
      model: args.model,
      params: {
        temperature: args.temperature,
        top_p: args.top_p,
        max_tokens: args.max_tokens,
        tools: args.tools,
      },
    }),

  /** Cancel an in-flight custom/OpenRouter chat stream by op_id. Best-effort;
   *  resolves true if a stream was actually pending. (2026-05-30) */
  customCancel: (opId: string) => invoke<boolean>("custom_cancel", { opId }),

  /** Live OpenRouter model catalogue (no key needed to list). */
  openrouterListModels: () =>
    invoke<
      {
        id: string;
        name: string;
        context_length: number;
        prompt_price: string;
        completion_price: string;
        vision: boolean;
        audio: boolean;
        tools: boolean;
        reasoning: boolean;
        description: string;
        moderated: boolean;
        max_output: number;
      }[]
    >("openrouter_list_models"),
  /** Store (or clear, on "") the OpenRouter API key in the Keychain. */
  openrouterSetKey: (key: string) =>
    invoke<void>("openrouter_set_key", { key }),
  /** Whether an OpenRouter key is configured (never returns the key). */
  openrouterHasKey: () => invoke<boolean>("openrouter_has_key"),

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
  workflowGet: (id: number) =>
    invoke<RawWorkflow | null>("workflow_get", { id }),
  workflowSave: (id: number | null, name: string, graphJson: string) =>
    invoke<number>("workflow_save", { id, name, graphJson }),
  workflowDelete: (id: number) => invoke<void>("workflow_delete", { id }),
  workflowRunRecord: (
    workflowId: number,
    status: string,
    resultsJson: string,
  ) =>
    invoke<number>("workflow_run_record", { workflowId, status, resultsJson }),

  // ── Roundtable outcomes (persisted transcripts) ──
  // `tableId` = the SavedTable id the run came from (null = ad-hoc). The
  // transcript blob is JSON: { config, turns, totals, endReason, completedAt }.
  roundtableRunSave: (
    tableId: string | null,
    name: string,
    topic: string,
    turns: number,
    transcriptJson: string,
  ) =>
    invoke<number>("roundtable_run_save", {
      tableId,
      name,
      topic,
      turns,
      transcriptJson,
    }),
  roundtableRunList: (tableId: string | null) =>
    invoke<RoundtableRunSummary[]>("roundtable_run_list", { tableId }),
  roundtableRunGet: (id: number) =>
    invoke<RoundtableRun>("roundtable_run_get", { id }),
  roundtableRunDelete: (id: number) =>
    invoke<void>("roundtable_run_delete", { id }),
  /** Write exported transcript content (markdown/json) to a chosen path. */
  roundtableSaveFile: (destPath: string, content: string) =>
    invoke<void>("roundtable_save_file", { destPath, content }),
  /**
   * List the persisted runs for a workflow (most recent first, capped Rust-side).
   *
   * NOTE on the return type: the Rust `WorkflowRun` struct serializes
   * `{ id, workflow_id, started_at, status, results_json }` where
   * `results_json` is nullable. The `WorkflowRun` type imported here (from
   * `types.ts`, owned by another module) is stale — it declares `created_at`
   * and a non-nullable `results_json`. The binding keeps that declared type so
   * the existing agent-tool consumer in `agent-loop/tool-registry.ts` keeps
   * compiling; UI code that needs the ACCURATE shape should read rows through
   * the local {@link WorkflowRunRecord} type (e.g. via a cast at the call
   * site), which matches what Rust actually sends.
   */
  workflowRunsList: (workflowId: number) =>
    invoke<WorkflowRun[]>("workflow_runs_list", { workflowId }),
  /**
   * Same backend command as {@link workflowRunsList}, typed to the ACCURATE
   * Rust serialization ({@link WorkflowRunRecord}: `started_at`, nullable
   * `results_json`). Use this from UI that surfaces run history; the older
   * `workflowRunsList` is retained only for the legacy agent-tool consumer.
   */
  workflowRunsListTyped: (workflowId: number) =>
    invoke<WorkflowRunRecord[]>("workflow_runs_list", { workflowId }),

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
  /* ── DB/storage maintenance (WS4) ── */
  /** Cheap read-only storage stats (db/wal/archive bytes + row counts). */
  dbMaintenanceStats: () => invoke<MaintenanceStats>("db_maintenance_stats"),
  /** Run the SAFE phases now (caps + archive + reclaim). Never VACUUMs. */
  dbMaintenanceRun: () => invoke<MaintenanceReport>("db_maintenance_run"),
  /** Explicit heavy reclaim: safe phases + a full VACUUM. */
  dbMaintenanceVacuum: () => invoke<MaintenanceReport>("db_maintenance_vacuum"),
  /** Recovery: restore archived messages for a conversation. Returns count. */
  dbMaintenanceRestoreArchived: (conversationId: number) =>
    invoke<number>("db_maintenance_restore_archived", { conversationId }),
};
