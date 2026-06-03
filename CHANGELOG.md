# Changelog

All notable changes to Froglips are documented in this file. Format loosely follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Roundtable ("Table")
- **Reasoning-model support** — capture `reasoning` / `reasoning_content` from
  thinking models (OpenRouter *and* Ollama, e.g. `gemma4`); a reasoning-only
  turn falls back to that text instead of being dropped as "empty response".
- **Backend-aware per-turn timeout** — local (Ollama) seats get a longer
  window (cold-load/reload) than cloud; a timed-out cloud turn is reported as
  a timeout, not committed/billed as done.
- **Ollama Cloud (`:cloud`) seats** are no longer mis-flagged as "local" —
  the "2+ local models reload each turn" warning/gate only counts truly-local
  models.
- **Pre-run gating** — Start requires ≥2 seats and two-click-confirms a 2+
  local-model config (which reloads each turn and usually times out).
- **`sanitizeTurn` hardening** — never manufactures an empty turn; distinguishes
  a real speaker hijack from a vocative addressing another participant.
- **One-click Reset** — restores default seats/topic/rounds/budget/memory.
- Budget gate now counts failed turns' input tokens; transcript bubbles
  memoized; inject ignores IME-composition Enter; misc guards.

### Security / storage
- **API keys moved from the macOS login Keychain to a `0600` `secrets.json`**
  (custom backends + MCP remote tokens). The Keychain ACL reset on every
  ad-hoc re-signed build and re-prompted on access; the local owner-only file
  removes the prompt. `security-framework` dependency dropped.

### Fixes
- Ollama model pulls stream a clean progress bar (ANSI/`\r` stripped) instead
  of raw terminal output.
- Conversation context menu clamps to the viewport (no off-screen clipping).

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
