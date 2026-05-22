# Froglips — User Guide

Version 0.11.0 · macOS (Apple Silicon)

## 1. Install

### From a release

1. Download `Froglips_0.11.0_aarch64.dmg` from the [Releases page](https://github.com/Jeritano/FrogLips/releases/latest).
2. Open the DMG and drag `Froglips.app` to `/Applications`.
3. First launch: macOS may show "unidentified developer". Right-click the app → Open. Confirm.
4. Optional one-line fix to strip Gatekeeper quarantine entirely:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Froglips.app
   ```

### From source

```bash
git clone git@github.com:Jeritano/FrogLips.git
cd FrogLips
npm install
npm run release
```

This kills any running Froglips, builds, ad-hoc signs, and installs to `/Applications`.

## 2. Prerequisites

Froglips has three backends. **Native works out of the box — install nothing.** The other two are opt-in.

### Native (recommended; zero install)

No setup. Pick "⚡ Load a HuggingFace model natively…" from the model dropdown and enter a repo id (e.g. `NousResearch/Llama-3.2-1B`). First load downloads weights from HuggingFace into `~/.cache/huggingface/hub`; subsequent loads are instant. Runs in-process via embedded `mistralrs` + candle + Metal kernels.

### Ollama (optional — broader catalog + cloud routing)

Install only if you want Ollama's local + `:cloud` model library or stronger tool-call support on some smaller models.

1. Install from <https://ollama.com>
2. Start it: it lives in the menu bar
3. For cloud models: `ollama signin`

### MLX (optional — Apple first-party inference via Python)

Install only if you already use MLX models elsewhere. Froglips spawns `mlx_lm.server` automatically when you pick an MLX model.

```bash
python3 -m venv ~/.venvs/mlx
~/.venvs/mlx/bin/pip install mlx-lm
```

## 3. First chat

Fastest path — Native, no install:

1. Click **+ New chat** in the sidebar.
2. Click the model dropdown → **⚡ Load a HuggingFace model natively…**
3. Enter a small repo id, e.g. `NousResearch/Llama-3.2-1B`. Click **Start**.
4. First load downloads weights (~2 GB for 1B-class models) — a progress indicator tracks the download and model load. After that, type and hit Enter.

If you installed Ollama instead:

1. Model dropdown → **Browse & download models…** → set **Source** to **Ollama**.
2. Pick something small like `llama3.2:3b` or `qwen3:4b`. Click **Pull**.
3. Close the library; the model appears in the dropdown. Pick it → **Start** → chat.

## 4. The Model Library

Open with **Browse & download models…** from the model dropdown. A **Source**
selector at the top switches between five views:

| Source | What you'll find |
|---|---|
| **Installed** | Everything currently pulled — Ollama, MLX, and GGUF models, with sizes and a **Remove** button each. Default view. |
| **Ollama** | Full `ollama.com/library` view: per-model description, colored capability chips (vision / tools / thinking / audio / cloud / embedding), pull counts and relative-updated metadata. Filter chips and a Popular/Newest/Updated sort. Falls back to a curated catalog with a banner if the live page can't be scraped. |
| **HuggingFace** | Live `huggingface.co/models` view with a collapsible filter sidebar (tasks, parameter range, libraries, apps, inference providers), live total count, name filter, and sort. The action button auto-routes: MLX repos → **Pull**, GGUF repos → **View files**, others → **Open on HF ↗**. |
| **RP / Kobold** | Curated roleplay finetunes from HF (TheDrummer, Sao10K, anthracite, ReadyArt, etc.). |
| **Civitai** | Live search of `civitai.com`. Mostly diffusion (image gen) — direct loading not supported, but useful for browsing. Shows ratings, SHA256, file format, license, scan status. |

### Removing models

- **Installed view:** trash button next to each model. Confirms before deleting (two-click confirm).
- **Inline:** on the Ollama / HuggingFace / RP views, any model that's already pulled shows a red **Remove** button instead of *Pull*.

Removing frees up the actual disk space — there is no undo.

## 5. Memory system

Froglips remembers things across conversations. There are four modes (set via the small ⓘ button next to the model name). The labels are plain-language; the behavior is unchanged from earlier versions:

| Mode | What it does |
|---|---|
| **Off** | No memory recall. No fact extraction. |
| **Suggest** | Recalls relevant memories for context. You add memories manually via the Memories panel. |
| **Review** | Same as Suggest, plus automatically extracts facts after each turn into a **pending** queue. You review and approve. |
| **Auto** | Same as Review, but auto-approved into the active set. Most automatic. |

### How recall works

Before each turn, Froglips embeds your message using `nomic-embed-text` (via Ollama), looks for memories with cosine similarity > 0.55, and injects up to 5 into the system prompt as a `<memory>…</memory>` block.

If vector search returns nothing, it falls back to keyword search.

### How extraction works

After each turn, Froglips asks a small model (`qwen3:4b` if installed, else fallbacks) to extract JSON facts from your message + the assistant's reply. Facts are deduped against existing memories at 0.85 cosine before insert.

Secrets are auto-rejected: AWS/OpenAI/GitHub/Slack tokens, JWTs, bearer-prefixed strings, labeled hex blobs.

### Memories panel

Open from the sidebar's ⭐ button. Two tabs:

- **Active** — memories that will be recalled
- **Pending** — auto-extracted memories awaiting your approval (in **Review** mode)

You can delete, promote pending → active, or add manually.

## 6. Agent mode

Toggle the **Agent** button next to the chat input. **Agent mode works on all
three backends — Ollama, MLX, and Native.** (Earlier versions limited it to
Ollama and MLX; the Native backend now supports tool-calling too.)

The agent has direct access via these tools. Grouped:

**Filesystem**
| Tool | What it does |
|---|---|
| `read_file` | Read file contents (paginated, 64 KB chunks); non-UTF8 → `{binary: true}` |
| `list_dir` | List directory entries with kind + size |
| `search_files` | Recursive grep w/ filename glob. `regex: true` for Rust regex syntax |
| `file_exists` | Check whether a path exists + its kind |
| `edit_file` | Find-and-replace edit on existing files |
| `multi_edit` | Apply N find-and-replace edits to one file atomically |
| `write_file` | Write or overwrite a file (requires approval) |
| `read_pdf` | Extract text from a PDF |

**Shell + macOS automation**
| Tool | What it does |
|---|---|
| `run_shell` | Execute via `sh -c` (approval, 30 s timeout, optional cwd+env) |
| `applescript_run` | Execute AppleScript via osascript (approval) |
| `open_app` | Launch an app by name via `open -a` (approval) |
| `show_notification` | Native notification |
| `screenshot` | `screencapture -x -t png` |
| `clipboard_get` / `clipboard_set` | pbpaste / pbcopy (set requires approval) |

**Git**
| Tool | What it does |
|---|---|
| `git_status` | `git status --short --branch` |
| `git_diff` | `git diff` (optional `staged: true`) |
| `git_log` | Oneline log (default 20, max 200) |
| `git_show` | Inspect a commit / tag / ref |
| `git_branches` | List local + remote branches |
| `git_commit` | Commit already-staged changes (approval) |

**Web**
| Tool | What it does |
|---|---|
| `web_fetch` | GET + auto-HTML-strip. SSRF-blocked on loopback/private/link-local |
| `web_search` | DuckDuckGo search (no API key) |
| `http_request` | Generic HTTP w/ headers + body (approval) |

**Code intelligence**
| Tool | What it does |
|---|---|
| `find_definition` | Heuristic regex for fn/def/class/struct/etc. defs of a symbol |
| `find_references` | Word-boundary regex references |
| `format_code` | prettier / rustfmt / black / gofmt / swift-format by extension |

**Background tasks + control flow**
| Tool | What it does |
|---|---|
| `task_create` | Start a background `run_shell` task; returns task_id |
| `task_status` / `task_list` / `task_cancel` | Inspect / cancel background tasks |
| `ask_user` | Pause agent + pop a modal; agent receives user's typed answer |
| `spawn_subagent` | Recursive agent run, depth-capped at 3 |

### Agent presets

Next to the Agent toggle is a dropdown of presets:

| Preset | Tools | Best for |
|---|---|---|
| **General** | All tools | Mixed tasks |
| **Coder** | FS + shell + multi_edit + full git | Software work |
| **Researcher** | Read-only FS + git + web + read_pdf | Investigation without writes |
| **Shell** | run_shell, list, exists, read | Terminal-style tasks |

Each preset comes with a system prompt tailored to its purpose. Switching presets mid-conversation changes the prompt for the next turn.

### Safety

- Every `run_shell`, `write_file`, `edit_file`, `applescript_run`, `clipboard_set`, `open_app`, `git_commit`, and `spawn_subagent` call requires explicit user approval. An `http_request` carrying a request body always asks for confirmation too, even when you've approved a session.
- The confirm dialog shows a `destructive` / `privileged` / `pipe-from-network` badge for risky patterns (e.g. `rm -rf /`, `sudo`, `curl … | sh`).
- Path traversal (`..`), symlink escape, and reads/writes to `~/.ssh`, `~/.aws`, `~/Library/Keychains`, `.env*`, sudoers, browser profiles, `.netrc`, `gh`/`gcloud` config, etc. are blocked by the Rust side.
- Content the agent reads from outside the model — files, PDFs, the clipboard, web pages, and git output — is scanned for prompt-injection before it reaches the model.
- Subagents do not inherit your session-wide "approve all" choices; their shell and write calls each ask again.
- **MCP server tools always require confirmation** — they can't be auto-approved, even with a session "approve all" active.
- The agent loop manages the model's context window for you: on long runs it trims oversized tool results and summarizes the oldest turns so a small-context model doesn't overflow and forget its tools mid-task.
- If tool calls keep failing turn after turn, the agent stops with a clear message rather than burning its whole iteration budget retrying.
- Optional **workspace root** confines all filesystem operations to a chosen directory. Set in agent settings (⚙).

### Agent settings (⚙)

The cog button next to the Agent toggle opens a panel:

- **Workspace** — sets the sandbox root. Persisted across app restarts.
- **Approve all this session** — bypass per-call confirmation for normal-risk shell or all writes.
- **Allowed tools** — restrict tools per conversation (overridden by preset when preset has its own allowlist).
- **Approved shell prefixes** — appears once you've checked "Also approve all `<cmd> *`" on a confirm dialog.
- **Updates** — check for and install a new version.

### Metrics

While the agent is running, a small pill shows `i<iters>·t<tools>·llm<ms>·tool<ms>·r<retries>·<prompt>+<completion>tok`. Updates live.

### Tool history

⌖ Tools button in the agent toolbar opens a slide-out panel listing every tool call in the current conversation with name, ok/err status badge, collapsible args + JSON result. Useful for debugging agent runs.

## 7. Per-conversation model parameters

Each conversation can carry its own model-parameter overrides. Open the params
panel (the sliders/⚙-style control by the composer) to set any of:

- **Temperature**, **top-p**, **max tokens**
- A conversation-specific **system prompt**

Every field is optional — leave one blank and that conversation uses the
backend default, exactly as before. Parameters apply on all three backends.

A small **context-usage meter** sits by the composer, showing how much of the
model's context window the current conversation is using so you can see when
you're approaching the limit.

## 8. Organizing conversations

- **Auto-titling**: a new conversation is automatically titled from your first
  message, so the sidebar reads as real titles instead of a wall of
  "New chat".
- **Pin**: pin important conversations from the row's hover controls; pinned
  conversations sort to the top of the sidebar.
- **Tags**: tag conversations from the same hover controls to group related
  work.
- **Search**: the sidebar search field now searches **message content**, not
  just titles — so you can find a conversation by something said inside it.
- **Undo delete**: deleting a conversation shows a 5-second undo toast. Click
  **Undo** and the conversation and all its messages come back; ignore it and
  the delete finalizes.

## 9. Conversation export + per-message actions

- **Export**: ⤓ Export button in the agent toolbar saves the current conversation as Markdown (timestamps, model tags, tool calls + results included).
- **Per-message actions**: hover any message — Copy (clipboard), Regenerate (assistant only, deletes the prior pair and re-asks), Edit (user only — drafts your last prompt back into the input so you can change it and resend).

## 10. Themes + keyboard shortcuts

- ☀/☾ in sidebar toggles **light/dark theme**. Persisted across restarts.
- **Sidebar collapse**: a collapse/expand toggle hides the conversation sidebar to give the chat full width. State is remembered.
- **Markdown rendering**: assistant + user messages render Markdown with code-block syntax highlighting for 20+ languages.
- **Citation chips**: when the agent references a workspace file, the chip is clickable — Froglips confirms the resolved path and opens it. Opens are confined to the workspace root; absolute or traversal paths are rejected.
- **Scroll behavior**: the chat sticks to the bottom while a reply streams, but if you scroll up to read, autoscroll pauses so you aren't yanked back down — it resumes when you return to the bottom.
- **Empty-chat landing**: a brand-new chat shows clickable example prompts instead of a blank surface; click one to drop it into the composer.
- **Reduced motion**: entrance animations are disabled when your system "reduce motion" setting is on.
- Cmd+N — new chat
- Cmd+L — open model library
- Cmd+K — focus model picker

## 11. Voice input

Click the microphone icon next to the chat input. Uses Web Speech API. Speak, then click again to stop. Manual edits while listening are preserved — the transcript rebases around them. Recognized speech segments are joined with proper spacing.

## 12. File drag-drop

Drag any text file into the chat input area. Its path gets attached. The model sees the path in context. Total attached bytes capped at 1 MiB per turn.

## 13. Diagnostics, backup, and crash logs

Open the **Diagnostics** panel from the menu.

- **Crash log**: if Froglips ever panics, the crash is recorded to
  `~/.local-llm-app/crash.log`. The Diagnostics panel has a refreshable
  crash-log section showing recorded panics (or an empty state when there are
  none). Everything stays on disk — there is no telemetry.
- **Diagnostics bundle**: export a single archive (logs + crash log + redacted
  settings + version info) to attach to a bug report. API keys and other
  secrets are redacted before it is written.
- **Data backup**: take an online backup of the conversation database.
- **Export / import**: export your conversations, messages, and memory to a
  versioned JSON file, and import one back. Import is **additive** — it merges
  into your existing data inside a transaction rather than overwriting it.

Your data also self-protects: on startup Froglips integrity-checks the
database and, if it finds corruption, quarantines the bad file and starts
fresh instead of failing to launch.

## 14. Updates

Two ways to get a new version:

- **In-app**: Agent settings ⚙ → **Check now**. Downloads, installs, relaunches.
- **Manual**: download the DMG from the Releases page.

Updates are minisign-signed; the public key is embedded in the app. A tampered build will fail verification and refuse to install.

## 15. Troubleshooting

**"Ollama: ollama not found on PATH"**
The app prepends common bin dirs (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.cargo/bin`, `~/.venvs/mlx/bin`) at startup. If Ollama lives elsewhere, symlink it into one of those.

**Model picker shows nothing**
Make sure Ollama is actually running (menu bar icon). For MLX, ensure `~/.venvs/mlx/bin/mlx_lm.server` exists.

**Cloud model 500s**
Ollama cloud has occasional outages. Check `curl -s http://localhost:11434/api/chat -d '{"model":"<name>","messages":[{"role":"user","content":"hi"}],"stream":false}'` to confirm it's an upstream issue.

**"Workspace root is outside" errors**
Run an agent tool whose path falls outside the configured workspace. Either widen the workspace (settings ⚙) or move the file in.

**Build failure on DMG**
`hdiutil` sometimes leaves stale mounts. Fix:
```bash
hdiutil info | awk '/^\/dev\/disk/{print $1}' | xargs -I{} hdiutil detach {} -force
```
Then retry `npm run release`.
