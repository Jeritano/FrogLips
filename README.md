# Froglips

**Froglips — the local-LLM power workstation.** A cross-platform desktop app that turns a model running entirely on your own machine into a real working environment. Plain chat is the substrate; the product is built on three pillars:

- **Agent** — a tool-calling loop with filesystem/shell/web/code/task tools, MCP servers, an optional workspace sandbox, dry-run mode, and risk-classified confirmation. Runs on Froglips's built-in native engine.
- **Knowledge** — vector-recall memory, project RAG, and a searchable, taggable conversation history.
- **Models** — manage a fleet of local models, with per-conversation parameters and a live context-usage meter.

**v2.0 is the first cross-platform release** — alongside the original macOS arm64 build, signed binaries now ship for **Intel macOS, Linux x86_64, and Windows x86_64**. Froglips ships its own **native backend** — an in-process engine (`mistralrs` + Metal on Apple Silicon, `llama.cpp` via `llama-cpp-2` everywhere else) that runs models on your hardware with zero install — with agent mode, vector-recall memory, and signed auto-updates.

![version](https://img.shields.io/badge/version-0.11.0-22c55e) ![platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-blue) ![stack](https://img.shields.io/badge/stack-Tauri%202%20%C2%B7%20React%2019%20%C2%B7%20Rust-orange)

## What it does

- Native desktop app (Tauri 2 + React 19 + Rust) — no Electron, ~66 MB binary
- **Built-in native backend**: an in-process engine (`mistralrs` + candle + Metal) that runs models directly on your hardware — no subprocess, no daemon, zero install
- Conversation history in SQLite with WAL + connection pooling, a numbered `user_version` migration ladder, and DB-corruption recovery (integrity-check + quarantine on startup)
- **Markdown rendering** w/ syntax highlighting via `marked` + `highlight.js` (20+ languages). DOMPurify-sanitized.
- **Light + dark themes**, ☀/☾ toggle in sidebar, persisted; reduced-motion support
- **Conversation organization**: pin, tag, and message-content search (not just titles); pinned conversations sort first; auto-titling from the first message; **Markdown export** per conversation; undo toast for conversation delete
- **Memory system**: vector recall (`nomic-embed-text`), automatic fact extraction, dedup at 0.85 cosine, Unicode injection sanitization
- **Agent mode**: tool-calling loop — filesystem (`read_file`/`list_dir`/`search_files` literal+regex/`file_exists`/`edit_file`/`multi_edit`/`write_file`), shell (`run_shell` + `applescript_run`), full git (`status`/`diff`/`log`/`show`/`branches`/`commit`), web (`web_fetch` + `web_search` + `http_request`, all SSRF-guarded), code intel (`find_definition`/`find_references`/`format_code`), macOS (`screenshot`/`clipboard_get`+`set`/`open_app`/`show_notification`), docs (`read_pdf`), background tasks (`task_create`/`status`/`list`/`cancel`), and recursive `spawn_subagent` + `ask_user` for human-in-the-loop. Sandboxed by optional workspace root, structured errors, untrusted-content injection scanning, an agent-loop context-window manager (budgets messages so small-context models don't overflow), a consecutive-error budget, per-call confirmation w/ destructive-pattern badges, and risk-classified MCP tools that always require confirmation.
- **Agent presets**: General / Coder / Researcher / Shell — selectable per turn
- **Per-conversation model parameters**: temperature / top-p / max-tokens / system-prompt overrides, with a live context-usage meter by the composer
- **Tool-history slide-out panel** for debugging agent runs (⌖ Tools button)
- **Data backup**: online SQLite backup, versioned JSON export (conversations + messages + memory), and additive import
- **Diagnostics**: local crash logging (`~/.local-llm-app/crash.log`), a rolling `app.log`, a crash-log viewer, and an export-diagnostics-bundle command — all on-disk, no telemetry
- **Model library**: live HuggingFace + Civitai search, inline pull/delete, dedicated *Installed* tab w/ sizes + total disk usage
- **Auto-updater**: signed minisign releases via GitHub Releases
- **Keyboard shortcuts**: Cmd+N (new chat), Cmd+L (model library), Cmd+K (focus picker)
- macOS-native bits: tray icon, file drag-drop, voice input, `open -a` shell

## Quick start

1. Go to the [latest release](https://github.com/Jeritano/FrogLips/releases/latest)
2. Download `Froglips_X.Y.Z_aarch64.dmg`
3. Open the DMG, drag `Froglips.app` into `/Applications`, eject the DMG
4. **First-launch warning:** macOS will refuse to open the app because it's not notarized.
   - Right-click `/Applications/Froglips.app` → **Open** → click **Open** in the dialog
   - Or strip Gatekeeper quarantine in one line:
     ```bash
     xattr -dr com.apple.quarantine /Applications/Froglips.app
     ```
5. Open Froglips → model dropdown → **⚡ Load a HuggingFace model natively…** → enter a small repo id like `NousResearch/Llama-3.2-1B` → **Start**

That's it. No daemon, no Python, no separate downloads — Froglips's native backend runs the model in-process via embedded Metal kernels. First model load pulls weights from HuggingFace into `~/.cache/huggingface/hub`; subsequent loads are instant.

See [User Guide](docs/USER_GUIDE.md) for full walkthrough.

## Requirements

### Runtime (end user)
- Apple Silicon Mac (M1+)
- **Zero install.** Froglips's native backend loads models directly via embedded mistralrs + Metal kernels. HuggingFace model weights download on demand into `~/.cache/huggingface/hub`.

### Build (developer)
- Full **Xcode** (from App Store, not just Command Line Tools — `mistralrs` needs the `metal` compiler)
- `sudo xcodebuild -runFirstLaunch && xcodebuild -downloadComponent MetalToolchain`
- Node 22+, Rust stable

## Development

```bash
npm install
npm run tauri dev   # HMR for frontend, Tauri restart for Rust
```

Skip native inference for faster iteration:

```bash
FROGLIPS_SKIP_NATIVE=1 npm run tauri dev
```

## Build a release

```bash
npm run release     # kills running app, builds, signs, installs to /Applications
```

Then upload `src-tauri/target/release/bundle/macos/Froglips.app.tar.gz{,.sig}` and the DMG to a new GitHub Release. See [Release Process](docs/RELEASE_PROCESS.md).

## Documentation

- [User Guide](docs/USER_GUIDE.md) — getting started, every feature explained
- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit together
- [Agent Layer](docs/AGENT_LAYER.md) — tools, security, sandboxing, presets
- [Release Process](docs/RELEASE_PROCESS.md) — versioning, signing, publishing

## Data locations

| What | Where |
|---|---|
| App settings (workspace root) | `~/Library/Application Support/Froglips/settings.json` |
| Conversation + memory DB | Tauri app data dir |
| Model weights | `~/.cache/huggingface/hub/` |
| Updater private key (DO NOT COMMIT) | `~/.tauri/froglips.key` |

## License

Copyright (c) 2026 Joseph D Eriano. All Rights Reserved.

Proprietary software — **not** open source. No permission is granted to use,
copy, modify, or distribute it without the express written permission of the
copyright holder. See [LICENSE](LICENSE) for the full terms. Bundled
third-party dependencies remain under their own respective licenses.
