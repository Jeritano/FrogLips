# Froglips

Native macOS chat app for local LLMs. Apple Silicon, MLX + Ollama backends, agent mode w/ filesystem and shell tools, vector-recall memory, signed auto-updates.

![version](https://img.shields.io/badge/version-0.6.3-22c55e) ![platform](https://img.shields.io/badge/platform-macOS%20arm64-blue) ![stack](https://img.shields.io/badge/stack-Tauri%202%20%C2%B7%20React%2019%20%C2%B7%20Rust-orange)

## What it does

- Native desktop app (Tauri 2 + React 19 + Rust) — no Electron, ~14 MB binary
- Backends: **MLX** (Metal, via `mlx_lm.server`) and **Ollama** (local + cloud models)
- Conversation history in SQLite with WAL + connection pooling
- **Memory system**: vector recall (`nomic-embed-text`), automatic fact extraction, dedup at 0.85 cosine
- **Agent mode**: tool-calling loop with `read_file`, `list_dir`, `search_files`, `file_exists`, `edit_file`, `write_file`, `run_shell` — sandboxed by an optional workspace root, structured errors, per-call confirmation
- **Agent presets**: General / Coder / Researcher / Shell — selectable per turn
- **Model library**: curated Ollama + MLX catalogs, live HuggingFace + Civitai search, inline pull/delete, dedicated *Installed* tab w/ sizes
- **Auto-updater**: signed minisign releases via GitHub Releases
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
5. Install **Ollama** (the easiest backend): https://ollama.com/download
6. Open Froglips → *Browse & download models…* → pick something small (`llama3.2:3b`, `qwen3:4b`) → **Pull**
7. Hit **Start** in the dropdown, type a message, send

Optional: clone the repo and run `bash scripts/first-run.sh` for an automated dependency check.

See [User Guide](docs/USER_GUIDE.md) for full walkthrough.

## Requirements

- Apple Silicon Mac (M1+)
- For MLX backend: Python 3.10+ with `mlx-lm` at `~/.venvs/mlx`
  ```bash
  python3 -m venv ~/.venvs/mlx
  ~/.venvs/mlx/bin/pip install mlx-lm
  ```
- For Ollama backend: [Ollama](https://ollama.com) installed and running
- For agent cloud models: `ollama signin` once

## Development

```bash
npm install
npm run tauri dev   # HMR for frontend, Tauri restart for Rust
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
| Ollama models | `~/.ollama/models/` |
| MLX models | `~/.cache/huggingface/hub/` |
| Updater private key (DO NOT COMMIT) | `~/.tauri/froglips.key` |

## License

Personal project. Use at your own risk.
