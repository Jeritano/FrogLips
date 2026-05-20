# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

## [0.6.3] — 2026-05-20

### Fixed
- Pinned model identity via authoritative system preamble — cloud tags (`deepseek-v4-pro:cloud`, `kimi-*:cloud`) no longer misidentify themselves on "what model are you?".

## [0.6.2] — 2026-05-20

### Security
- All Markdown rendered via `dangerouslySetInnerHTML` now sanitized through DOMPurify with a strict tag + attribute allowlist. `javascript:` / `vbscript:` / `data:` URIs blocked on anchors.
- `.gitignore` extended to cover common secret-file patterns (`.env*`, `*.key`, `*.pem`, `.tauri/`, etc.).
- CI now runs `npm audit` + `cargo audit` on every push (informational; will fail builds once baseline is clean).

## [0.6.1] — 2026-05-20

### Added
- First cross-platform release: GitHub Actions matrix builds for Linux (`.deb` + `.AppImage`) and Windows (`.msi` + `.exe`). Builds attached to the GitHub Release automatically on tag push.

### Fixed
- DMG bundling flake: `scripts/release.sh` now detaches stale hdiutil mounts before each build and retries once on failure.

## [0.6.0] — 2026-05-20

### Added
- Markdown rendering w/ syntax highlighting (highlight.js, 20+ languages registered).
- Light theme toggle in sidebar (☀/☾), persisted to settings.
- Conversation search bar in sidebar.
- Slide-out tool-history panel (⌖ Tools button) — shows every tool call w/ args + result, ok/err status.
- `release.yml` cross-platform CI workflow.

### Changed
- `scripts/release.sh` pkill filter narrowed to `Contents/MacOS` so bundle_dmg.sh isn't killed mid-stream.

## [0.5.0] — 2026-05-20

### Added
- MIT LICENSE, CHANGELOG, SECURITY, CONTRIBUTING files.
- GitHub Actions CI: `cargo test`, `cargo clippy -- -D warnings`, `tsc --noEmit`.
- Rust unit tests for `agent.rs` (path validation + classify_shell_risk) and `models.rs` (delete_mlx_model containment).
- Embedding cache now LRU-bounded at 10 000 entries.
- HTTP fetches to Ollama use a 60 s `AbortSignal.timeout` to avoid wedges.
- New agent tools: `git_status`, `git_diff`, `multi_edit` (atomic multi-replace).
- `search_files` supports a `regex` flag.
- `read_file` detects non-UTF8 content and returns `{kind: "binary"}` instead of garbled lossy text.
- `edit_file` confirm dialog now shows a unified diff preview before approval.
- Memory: edit-in-place, JSON export/import, configurable embedding model + recall threshold, per-memory tag editing.
- `formatRecallBlock` now escapes `<`, `>`, and Unicode RTL/control marks against prompt injection.
- Settings file persists last_model, memory_mode, active_preset, embedding_model, recall_threshold, window_size, and window_position.
- Window position + size restored on startup.
- Keyboard shortcuts: Cmd+N (new chat), Cmd+K (model picker), Cmd+, (settings), Cmd+L (model library).
- Conversation export to Markdown (per-conversation, includes timestamps + tool calls).
- Copy + Regenerate + Edit-and-retry actions on assistant messages.
- Syntax highlighting in code blocks via shiki.
- Installed tab: filter chips by tag, sort options (size/name), total disk usage summary.
- HuggingFace MLX tab paginated beyond first 100 results.
- ModelBrowser catalog data extracted to `src/lib/catalog.ts`.
- Light theme toggle.

### Changed
- `lib.rs` Tauri commands split into `commands/{server,conv,memory,agent,models}.rs`.
- `ChatWindow.tsx` split: `<AgentSettingsPanel>` and `<AgentConfirmModal>` extracted.
- `MessageList` items wrapped in `React.memo` to skip re-render on streaming updates.

### Fixed
- DMG bundling: build now ships with `targets: ["app", "updater"]` by default; DMG produced via separate manual step.
- mlx_lm.server stderr now surfaced to UI on failure (no more silent "stopped" with no reason).

## [0.4.1] — 2026-05-20
- Model Library tabs replaced with a labeled dropdown source selector.

## [0.4.0] — 2026-05-20
- Installed tab in ModelBrowser, with delete buttons for pulled Ollama + MLX models.
- Inline ✓ installed badge + Remove button on catalog cards.
- Civitai data expanded: updatedAt, comment + favorite counts, SHA256, availability, mode.
- `kimi-k2-thinking:cloud` added to Ollama curated catalog.
- Backend: `delete_ollama_model`, `delete_mlx_model` (canonicalized rm -rf w/ containment guard).

## [0.3.0] — 2026-05-20
- Workspace root persisted to settings.json, restored on startup.
- Shell cancellation: per-op AbortHandle map, cancelActiveShell wired to user abort.
- Token tracking from Ollama `prompt_eval_count` + `eval_count`.
- Command-prefix approve-all via "remember this pattern" checkbox.
- Agent presets: General / Coder / Researcher / Shell (dropdown in toolbar, persisted).
- Auto-updater via tauri-plugin-updater + GitHub Releases.
- `scripts/release.sh`: kill app, build, install, codesign ad-hoc, refresh Desktop alias.

## [0.2.0] — 2026-05-20
- Agent layer maturation across security, capability, loop, UX.
- New agent tools: edit_file, search_files, file_exists.
- read_file pagination, list_dir truncation signal, structured ToolError enum.
- Optional workspace root sandbox + canonicalized path validation.
- classify_shell_risk heuristic + red-banner destructive confirm.
- Agent settings panel: workspace picker, per-conversation allowlist, session approve-all toggles.
- Dynamic system prompt injecting workspace + OS + tool list.
- Dedupe, retry, live metrics (iterations, tool calls, latency, retries).

## [0.1.1] — 2026-05-19
- `ensure_path_for_gui()` extends PATH at startup to fix "ollama not found on PATH" when launched from Finder/Dock.

## [0.1.0] — 2026-05-19
- Initial public release: Tauri 2 + React 19 + Rust desktop app.
- MLX + Ollama backends, conversation history, memory system, agent mode skeleton, model library w/ HF + Civitai search.
