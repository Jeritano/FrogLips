# local-llm-app

Desktop chat for local LLMs. MLX backend. No Ollama.

## What it does
- Native macOS app (Tauri + React)
- Spawns `mlx_lm.server` for the picked model, talks to it over the OpenAI-compatible HTTP API
- Lists models cached in `~/.cache/huggingface/hub`
- Chat with streaming, file drag-drop, persistent SQLite history
- System tray icon

## Requirements
- Apple Silicon (MLX is Metal-only)
- Python 3.10+ with `mlx-lm` installed at `~/.venvs/mlx`:
  ```
  python3 -m venv ~/.venvs/mlx
  ~/.venvs/mlx/bin/pip install mlx-lm
  ```
- Rust + Node (for dev/build)

## Run in dev
```
npm install
npm run tauri dev
```

## Build for release
```
npm run tauri build
```
Output: `src-tauri/target/release/bundle/macos/local-llm-app.app`

## Adding models
Download an MLX model from Hugging Face:
```
~/.venvs/mlx/bin/huggingface-cli download mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit
```
Then pick it in the dropdown.

## Data locations
- DB: `~/.local-llm-app/db.sqlite`
- Models: `~/.cache/huggingface/hub/`

## Backend port
`mlx_lm.server` binds `127.0.0.1:8080`. Make sure nothing else holds it.
