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
- A corrupt `secrets.json` is now quarantined to `secrets.json.corrupt` + logged
  instead of silently wiping (then overwriting) stored keys.
- SSRF hardening: block IPv4-mapped IPv6 (`::ffff:169.254.169.254`) + the
  Alibaba metadata IP `100.100.100.200` across the MCP and custom-backend
  guards; the custom backend now DNS-resolves + pins (no rebind TOCTOU).
- Path-safety write denylist extended to browser-profile dirs (Chrome/Firefox/
  Safari) to match the agent fs layer.

### MCP / Tools
- **One-click OAuth** for remote MCP servers — browser authorization
  (discovery → dynamic client registration → PKCE/S256 → loopback callback →
  token + refresh), all SSRF-pinned. No more pasting API keys for OAuth servers.
- OAuth endpoints require https (loopback http allowed); 401 → auto-refresh → retry.

### Table (outcomes) / Flows
- **Saved roundtables** — keep multiple named roundtables; the Table landing is
  a Flows-style list.
- **Persisted outcomes** — a completed run auto-saves (transcript + totals) to
  the DB (migration v17), with per-table run history, a read-only viewer,
  **Save to file** (Markdown/JSON), and **Run again**.
- Fixed: cloud-capable rows (e.g. `gemma4`) show as Installed when a local tag
  (`gemma4:latest`) is present; Remove targets the real tag.

### Chat
- Tool calls/results hidden from the transcript; the stream shows only the
  answer + a live **Thinking… / Running tools…** status. Expand the full call
  history via the toolbar **History** button.
- Cold-start: the landing shows on first launch (no conversation yet) and guides
  "pick a model + Start"; backend-crash/restart messages now surface.

### UI / premium pass
- Two-layer elevation shadows, tactile `:active` press, tinted selection + thin
  scrollbars, shell gradient frame, soft input focus rings, card hover-lift,
  premium Flows canvas (selection ring, arrowhead edges, grabbable handles),
  unified modal enter-animation + frosted backdrop.
- **lucide-react icon system** replaces ~90 emoji/Unicode glyph icons app-wide.
- EmptyState + skeleton loaders; readable agent-toolbar metrics; "Claude
  Skills" → "Skills".

### Production / reliability
- App version + a "Report an issue" link in Diagnostics.
- `release.sh` documents the Developer ID signing + notarization env contract.
- Setup wizard distinguishes Ollama running / installed-but-stopped (→ run
  `ollama serve`) / not-installed (→ download).
- HuggingFace library load failures get a Retry; the native-chat error path no
  longer hangs the spinner.

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
