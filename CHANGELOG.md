# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [0.11.1]

A local-first macOS desktop app for chatting with local and cloud LLMs.

### Core

- **Chat** — streaming conversations against local (MLX / Ollama / in-process
  native) and cloud (`*:cloud`, OpenRouter, custom OpenAI-compatible) backends,
  with conversation history, soft-delete, and a memory/profile system.
- **Roundtable** — multi-model conversations: several models take turns on a
  shared transcript with a director, per-turn budget/time caps, and graceful
  per-turn failure handling.
- **Flows** — card-based agent workflows with an App-level run provider so a run
  survives navigation, a scheduler, and a scratchpad.
- **Tools / Agent mode** — gated tool use (shell, file, web, http) with an
  approval model, plus MCP servers as the extension mechanism.
- **Model library** — live HuggingFace + ModelScope search, a curated Ollama
  catalog, OpenRouter, and an *Installed* tab with sizes + total disk usage.
- **Vision** — image attachments in chat for vision-capable models.

### Platform

- Tauri 2 + Rust + React, macOS-only for 1.x.
- Local-only, no telemetry. All user data (settings, history, weights) lives in
  `~/.local-llm-app/` and never leaves the device.
- Signed minisign releases via GitHub Releases with an in-app auto-updater.
- SQLite persistence with an immutable migration ladder.
