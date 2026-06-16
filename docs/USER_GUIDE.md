# Froglips — User Guide

Version 0.14.4 · macOS (Apple Silicon)

## 1. Install

### From Homebrew

```bash
brew install --cask Jeritano/tap/froglips
```

### From a release

1. Download the latest `Froglips_*_aarch64.dmg` from the [Releases page](https://github.com/Jeritano/FrogLips/releases/latest).
2. Open the DMG and drag `Froglips.app` to `/Applications`.
3. Double-click to launch. The app is signed with a Developer ID, notarized, and stapled, so it opens without any Gatekeeper right-click or quarantine workaround.

### From source

```bash
git clone git@github.com:Jeritano/FrogLips.git
cd FrogLips
npm install
npm run release
```

This kills any running Froglips, builds, signs, and installs to `/Applications` — notarized when Developer ID + notary credentials are configured, ad-hoc-signed otherwise.

## 2. Prerequisites

**Install nothing.** Froglips ships its own native backend — an in-process engine (`mistralrs` + candle + Metal kernels) that runs models directly on your hardware. There is no daemon to install, no Python to set up.

Pick "⚡ Load a HuggingFace model natively…" from the model dropdown and enter a repo id (e.g. `Qwen/Qwen2.5-1.5B-Instruct` — small, instruction-tuned, no HF login required). The native engine loads **standard** HuggingFace transformers checkpoints (safetensors + `config.json`); MLX-format repos (e.g. `mlx-community/*-4bit`) are not loadable by this backend — use the MLX backend for those. The first load downloads weights from HuggingFace into `~/.cache/huggingface/hub` and warms the model — give it a minute; every load after that is instant.

## 3. First chat

1. Click **+ New chat** in the sidebar.
2. Click the model dropdown → **⚡ Load a HuggingFace model natively…**
3. Enter a small, instruction-tuned repo id, e.g. `Qwen/Qwen2.5-1.5B-Instruct`. Click **Start**.
4. The first load downloads the weights (a few GB for 1–2B-class models) and warms the model — a progress indicator tracks the download and load, and it can take a minute. After that, type and hit Enter; every later load is instant.

## 4. The Model Library

Open with **Browse & download models…** from the model dropdown. A **Source**
selector at the top switches between views:

| Source | What you'll find |
|---|---|
| **Installed** | Everything currently downloaded, with sizes and a **Remove** button each. Default view. |
| **HuggingFace** | Live `huggingface.co/models` view with a collapsible filter sidebar (tasks, parameter range, libraries, apps, inference providers), live total count, name filter, and sort. The action button auto-routes: GGUF repos → **View files**, others → **Open on HF ↗**. |
| **Ollama** | Curated catalog of popular Ollama-library models (chat, code, reasoning, vision, embeddings) with one-click pull. |
| **OpenRouter** | Cloud models served via OpenRouter — select to activate, no local download. |
| **ModelScope** | Live search of the ModelScope registry. |
| **llmpm** | Locally-served models managed by the `llmpm` process manager. |

### Removing models

- **Installed view:** trash button next to each model. Confirms before deleting (two-click confirm).
- **Inline:** on the HuggingFace / RP views, any model that's already downloaded shows a red **Remove** button instead of *Pull*.

Removing frees up the actual disk space — there is no undo.

### Model capability badges

To help you pick a model that will succeed *before* you hit a wall, the model
picker annotates models with lightweight badges derived from the model id:

- **Vision** — flags models from known multimodal families (LLaVA, Qwen-VL,
  Gemma 3, Pixtral, Llama 3.2-Vision, …); the image-attach control only shows on
  these.
- **Tool-calling fitness** — a hint of how reliably a model emits the
  OpenAI-style tool calls that Agent mode and Flows need: **good** (e.g.
  Qwen 2.5/3, Mistral, Llama 3.1/3.3, frontier cloud models), **weak** (small or
  abliterated/uncensored builds that tend to narrate instead of calling), or
  **untested** (unknown family — no warning either way).
- **Context window** — a compact marker (`8k` / `32k` / `128k` / `1M`) of the
  model's context size.

These are heuristics meant to steer, not gates — a "weak" model still loads, and
where the backend can report real capabilities it overrides the heuristic.

## 5. Memory system

Froglips remembers things across conversations. There are four modes (set via the small ⓘ button next to the model name). The labels are plain-language; the behavior is unchanged from earlier versions:

| Mode | What it does |
|---|---|
| **Off** | No memory recall. No fact extraction. |
| **Suggest** | Recalls relevant memories for context. You add memories manually via the Memories panel. |
| **Review** | Same as Suggest, plus automatically extracts facts after each turn into a **pending** queue. You review and approve. |
| **Auto** | Same as Review, but auto-approved into the active set. Most automatic. |

### How recall works

Before each turn, Froglips embeds your message using `nomic-embed-text`, looks for memories with cosine similarity > 0.55, and injects up to 5 into the system prompt as a `<memory>…</memory>` block.

If vector search returns nothing, it falls back to keyword search.

### How extraction works

After each turn, Froglips asks a small model (`qwen3:4b` if installed, else fallbacks) to extract JSON facts from your message + the assistant's reply. Facts are deduped against existing memories at 0.85 cosine before insert.

Secrets are auto-rejected: AWS/OpenAI/GitHub/Slack tokens, JWTs, bearer-prefixed strings, labeled hex blobs.

### Memories panel

Open from the sidebar's ⭐ button. Two tabs:

- **Active** — memories that will be recalled
- **Pending** — auto-extracted memories awaiting your approval (in **Review** mode)

You can delete, promote pending → active, or add manually.

## 5b. Multi-model auto-routing

Instead of one active model, you can configure several specialists and let
Froglips pick the best one for each message.

**Turn it on:** in the chat, toggle **Auto-route** (above the composer). A chip
on each answer shows which route handled it — `→ Coder · qwen3-coder ·
semantic`.

**Manage routes:** click **Manage routes**. A *route* binds a **model +
backend + role** to:
- a **"when to use"** description (read by the classifier),
- optional **keywords** for an instant fast-path (e.g. ` ``` `, `error`),
- optional **example messages (utterances)** — embedded locally so similar
  messages match by meaning in a few milliseconds, no LLM call.

Mark one route as the **default** fallback.

**How a message is routed:** keyword fast-path → semantic match (utterances) →
small-LLM classifier on the active model → default. The first stages are
near-instant; the classifier only runs when the faster stages are unsure. If
nothing routes, the active model answers (no failure).

**Configurations:** save a whole set of routes as a named **configuration**
(e.g. "Hybrid cloud+local", "All-local private"), add **notes**, and switch
between them in one click. Duplicate one to fork a variant.

**Test routing:** the **Test routing** box runs the real router on a message you
type and shows the chosen route, method, and similarity score — tune your
utterances/keywords without sending a chat.

**Notes:** fast multi-model switching works best on Ollama (loads models on
demand) and cloud backends; MLX/native routes only switch to the already-loaded
model. Semantic matching needs an embedding model (`nomic-embed-text`); without
one it cleanly falls back to keyword + classifier. Agent mode keeps the active
model (routing applies to plain chat).

## 5c. Project knowledge (RAG)

Point Froglips at a local folder and it indexes the files so the agent can
**semantically search** them via the `search_project_knowledge` tool. Open the
RAG panel from the Knowledge surface.

**Index a folder:** enter a corpus **name**, an **absolute folder path** (or
drag a folder in), and an optional **glob filter** (e.g. `**/*.{ts,tsx}`), then
**Ingest folder**. Indexing runs on the backend and reports how many files and
chunks it created.

**The corpus manifest:** each indexed corpus shows its **chunk count** and how
long ago it was last indexed. When the source files on disk have changed since
the last index, a yellow **Stale** badge appears next to the corpus name.

**Re-index:** click the ↻ button on a corpus row to re-ingest it from its
recorded folder. Unchanged files take a fast copy-forward path (no re-embed), so
re-indexing is cheap when little changed. A stale corpus is also refreshed on
the app's daily maintenance pass; this button is the on-demand path.

**Click-to-open hits:** the **Test search (debug)** box runs the real retriever
against a corpus and lists the top hits with their relevance score and a
snippet. Each hit's path is a **clickable link** that opens the source file in
your default app — the open is confined to the corpus's recorded folder, so a
hit can never open a file outside it.

## 6. Agent mode

Toggle the **Agent** button next to the chat input. Agent mode runs on
Froglips's built-in native backend — any model you load supports the
tool-calling loop.

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
| **Researcher** | FS read + write_file/edit_file/multi_edit + git + web + read_pdf | Investigation + reports/summaries |
| **Shell** | run_shell, list, exists, read | Terminal-style tasks |

Each preset comes with a system prompt tailored to its purpose. Switching presets mid-conversation changes the prompt for the next turn.

### Safety

- Every `run_shell`, `write_file`, `edit_file`, `multi_edit`, `make_dir`, `move_path`, `copy_path`, `delete_path`, `applescript_run`, `clipboard_set`, `open_app`, `git_commit`, `kill_process`, `agent_undo`, and `spawn_subagent` call requires explicit user approval. An `http_request` carrying a request body always asks for confirmation too, even when you've approved a session.
- The confirm dialog shows a `destructive` / `privileged` / `pipe-from-network` badge for risky patterns (e.g. `rm -rf /`, `sudo`, `curl … | sh`).
- **"Trust this task" (per-run)** — on a normal-risk confirmation dialog you can tick **Allow all remaining actions for this task** before clicking **Allow**. For the rest of *that single agent run* every normal-risk tool call auto-approves so you aren't clicking through each step of a multi-step task. It is scoped to the one run (it resets when the run ends), and it deliberately does NOT cover destructive-risk calls, shell, or MCP tools — those always re-confirm. The checkbox is hidden on non-normal-risk dialogs so it can never silently waive a dangerous action.
- **Path-aware risk escalation** — writes targeting `/etc/`, `/Library/Launch{Agents,Daemons}/`, shell rc files (`.zshrc`, `.bashrc`, …), `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, or any `.app` / `.command` / `.terminal` / `.workflow` / `.tool` bundle (root OR internal) are automatically classified `destructive`. The chat agent's session-level **Approve all this session → writes/edits** toggle CANNOT waive these — they always show the explicit confirmation modal with the loud red badge.
- Path traversal (`..`) is collapsed before risk classification so `~/foo/../../etc/hosts` doesn't slip through as "normal". Symlink escape, reads/writes to `~/.ssh`, `~/.aws`, `~/Library/Keychains`, `.env*`, sudoers, browser profiles, `.netrc`, `gh`/`gcloud` config, etc. are blocked by the Rust side regardless of UI risk.
- Content the agent reads from outside the model — files, PDFs, the clipboard, web pages, and git output — is scanned for prompt-injection before it reaches the model.
- Subagents do not inherit your session-wide "approve all" choices; their shell and write calls each ask again.
- **MCP server tools always require confirmation** — they can't be auto-approved, even with a session "approve all" active, and they're explicitly excluded from the unattended scheduled-workflow auto-approve.
- The agent loop manages the model's context window for you: on long runs it trims oversized tool results and summarizes the oldest turns so a small-context model doesn't overflow and forget its tools mid-task.
- If tool calls keep failing turn after turn, the agent stops with a clear message rather than burning its whole iteration budget retrying.
- Optional **workspace root** confines all filesystem operations to a chosen directory. Set in agent settings (⚙).

### Agent settings (⚙)

The cog button next to the Agent toggle opens a panel:

- **Workspace** — sets the sandbox root. Persisted across app restarts.
- **Approve all this session** — chat-mode only. Two checkboxes (shell normal-risk only / writes-and-edits) bypass per-call confirmation for the rest of the chat session. Destructive-risk calls and sensitive-path writes still gate explicitly (see *Path-aware risk escalation* above). Workflows use a different model — per-card `Unattended` checkbox, see §7 — and there is no equivalent session-level toggle on the Workflows surface.
- **Allowed tools** — restrict tools per conversation (overridden by preset when preset has its own allowlist).
- **Approved shell prefixes** — appears once you've checked "Also approve all `<cmd> *`" on a confirm dialog.
- **Updates** — check for and install a new version.

### Metrics

While the agent is running, a small pill shows `i<iters>·t<tools>·llm<ms>·tool<ms>·r<retries>·<prompt>+<completion>tok`. Updates live.

### Tool history

⌖ Tools button in the agent toolbar opens a slide-out panel listing every tool call in the current conversation with name, ok/err status badge, collapsible args + JSON result. Useful for debugging agent runs.

## 7. Workflows

Workflows turn single agents into multi-agent pipelines. Open it from the
sidebar (the 🧩 Workflows entry).

- **Create a workflow** — click **+ New workflow**, give it a name.
- **The table-top** — the open canvas is your workspace. A **card deck** sits in
  the corner; the top card is the "new agent" affordance.
- **Add an agent** — click the deck's top card. A centered form opens: pick a
  name (auto-generated, editable), a role/preset, a model (defaults to the
  system default), an optional **System prompt** (overrides the role/preset's
  system prompt for this card only — leave blank to inherit from the preset),
  a prompt, and an optional tool allowlist and schedule. There's also an
  **Unattended** checkbox — see *Approval* below. Save and the configured
  card lands on the canvas.
- **Per-card system prompt** — the role/preset (Researcher, Coder, etc.)
  supplies a system prompt by default. When three cards share the same role
  they share the same system prompt, which is sometimes wrong (e.g. you want
  one Researcher to write a specific filename suffix and another to be terse).
  Fill the per-card **System prompt** textarea to override the preset for that
  card only. Whitespace-only falls back to the preset.
- **Wire the chain** — drag from one card's right handle to the next card's
  left handle. The chain runs left→right; each card's final output is handed to
  the next card as its input.
- **Run** — the **Run workflow / Stop** button lives in the global top-bar
  (next to the theme toggle, parity with the chat ModelPicker layout). It runs
  the whole chain. A single card's **Run** button on the canvas runs just that
  card (disabled for mid-chain cards, which have no upstream input on their
  own). Per-card live status (`idle / running / done / failed`) renders in the
  right-hand status panel.
- **Disconnect cards** — click any edge line between two cards to disconnect
  them (a confirmation prompts before removing). React Flow's select+Delete
  doesn't survive the editor's re-render, so click-to-disconnect is the
  reliable affordance.
- **Approval — per-card Unattended** — each card has a single **Unattended**
  checkbox in its form (no global session-level toggles, no run-panel
  checkbox, no per-call modal stream). When the box is ticked the card
  blanket-bypasses confirmation for every tool call it makes during this
  workflow run — including `run_shell` and `applescript_run` — relying on the
  Rust write-layer protected-prefix list and the shell-risk classifier as the
  authoritative gates. When the box is NOT ticked, every dangerous tool call
  on that card surfaces the same confirmation modal you'd see in chat agent
  mode; click **Allow** / **Deny**, or click **Stop** to abort the whole run
  cleanly. The Unattended flag is per-card and persists with the card; it is
  not reset on workflow open. The unification means a research → summary →
  report chain runs end-to-end on a single decision per card instead of one
  modal per tool call.
- **Navigation cancels runs** — leaving the Workflows view while a run is in
  progress aborts it cleanly (you'll see the run recorded as failed with the
  remaining cards skipped). A blue banner warns while a run is live. Future
  releases will lift run state above the page so navigation is non-destructive.
- **Run History** — click the **History** button to open a panel of this
  workflow's past runs (manual and scheduled). Each entry records when it ran,
  its overall status, and a per-card summary you can expand to see what each card
  produced — so you can review an unattended scheduled run after the fact. A
  one-off **Test** run against typed sample input is deliberately *not* recorded.
- **Schedule** — a card with a schedule triggers the workflow unattended. A
  card must explicitly opt into `unattended` for its declared tools to
  auto-approve on a scheduled run; everything else still hits the deny-all gate.
  Even with `unattended`, the curated never-auto list (`run_shell`,
  `applescript_run`, `delete_path`, `kill_process`, `agent_undo`,
  `http_request`, `spawn_subagent`, MCP tools) ALWAYS requires explicit
  confirmation — they're refused on scheduled runs with no UI involved.
- **Schedule grammar** — `every <n>m`, `every <n>h`, or `daily HH:MM` (UTC).
  The form validator matches what the Rust scheduler actually accepts; an
  invalid schedule disables Save with an inline hint.

## 7b. MCP servers (Tools)

Click **🧰 Tools** in the sidebar to open the MCP hub. MCP (Model Context
Protocol) servers are external tool providers — once you connect one, its tools
become available to the **agent** alongside Froglips's built-in tools. The hub
has two tabs: **Installed** and **Browse**.

### Browsing and adding a server

1. Open **Browse**. Pick a registry source at the top: **Official registry** or
   **PulseMCP**. Type in **Search MCP servers…** to filter.
2. Each card shows the server's name, description, GitHub stars, and a transport
   badge (`remote` / `package`). Click **Add**:
   - **Package servers** (npm or PyPI) prefill a launch command — `npx` for npm,
     `uvx` for Python.
   - **Remote servers** open the add form with the endpoint URL prefilled.
   - A server with no installable package opens **↗** to its homepage instead.
3. The add form lands on **Installed** with the fields filled. Review and click
   **Connect**.

### Adding a server manually

On **Installed**, click **+ Add manually** and choose a type:

- **Local (stdio)** — a **name**, a **command** (e.g. `npx`), space-separated
  **args** (e.g. `-y @modelcontextprotocol/server-filesystem ~/dir`), and an
  optional **env JSON** field. Local servers run with your full user
  privileges — only add commands you trust.
- **Remote (URL)** — a **name** and a streamable-HTTP endpoint URL
  (`https://…/mcp`). An optional **bearer token** is stored in the **macOS
  Keychain** (with a `0600`-file fallback), never in plaintext settings.

### Managing installed servers

The **Installed** tab lists every server with a colored status dot and a
`stdio` / `remote` badge. For each you can **Start** / **Stop** it, see its live
tool count + tool chips, and **Remove** it (two-click confirm; removing a remote
server also deletes its stored token). A failed start shows its error inline.

> **Note.** MCP tools are always confirmation-gated in the agent — they can
> never be auto-approved even with a session "approve all" active, and they're
> refused outright on unattended scheduled workflow runs.

## 8. About You

The **About You** profile tells the model who you are. Open it from the topbar
menu (☰ → 👤 About You).

- Fill in any of: name, what you do, location, a free-text "anything else", and
  how you want the AI to respond.
- Tick **Use my profile** to enable it.
- When enabled, the profile is formatted into a system-prompt block injected
  into **every chat session** so responses fit you.
- **Workflows intentionally do NOT inject the profile.** Workflow agents are
  task-focused; some models were observed picking the profile's name as a
  literal filename when the workflow prompt also mentioned a file. Workflow
  cards rely on their own prompt for any user context.
- It is stored locally in `settings.json`, never auto-populated, and never sent
  anywhere except to the model you are already chatting with.

## 9. Per-conversation model parameters

Each conversation can carry its own model-parameter overrides. Open the params
panel (the sliders/⚙-style control by the composer) to set any of:

- **Temperature**, **top-p**, **max tokens**
- A conversation-specific **system prompt**

Every field is optional — leave one blank and that conversation uses the
backend default, exactly as before.

A small **context-usage meter** sits by the composer, showing how much of the
model's context window the current conversation is using so you can see when
you're approaching the limit.

### Auto-continue

When the meter crosses **~85%** of the model's context window, a banner
appears above the composer:

> *Conversation is 85%+ full — auto-continuing in 5s.*  **[Continue now]**  **[Not yet]**

- After the 5-second countdown (or **Continue now**) Froglips asks the same
  model you are chatting with to summarize the prior turns, creates a fresh
  conversation titled **"Continued: <previous title>"**, seeds it with the
  summary as both a system message and the conversation's `system_prompt`
  parameter, and switches you to the new thread. Your next message lands in
  the new conversation with a clean context budget.
- **Not yet** dismisses the banner for the current conversation; it will
  re-arm the next time you open it fresh.
- The original conversation is untouched — older history stays in the
  previous thread and the sidebar shows both.

## 10. Organizing conversations

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

## 11. Conversation export + per-message actions

- **Export**: ⤓ Export button in the agent toolbar saves the current conversation as Markdown (timestamps, model tags, tool calls + results included).
- **Per-message actions**: hover any message — Copy (clipboard), Regenerate (assistant only, deletes the prior pair and re-asks), Edit (user only — drafts your last prompt back into the input so you can change it and resend).
- **Reasoning disclosure**: reasoning models (DeepSeek-R1, Qwen3, gpt-oss, …) emit a chain-of-thought before their answer. Froglips splits that out of the prose: while the model is still thinking it streams into an expanded **Thinking…** disclosure; once the answer arrives the disclosure collapses to **Thought for a moment**, which you can re-open to read the reasoning. The final answer is never cluttered with the raw `<think>` text.

### Find in a conversation (Cmd+F)

Press **Cmd+F** in an open conversation to bring up a find bar scoped to that
thread. Type a query and Froglips highlights every match across the *whole*
conversation — including earlier messages hidden behind "Show earlier messages"
— and shows a live `current / total` count. Use the next/prev arrows (or Enter /
Shift+Enter) to step through hits; Esc closes the bar.

## 12. Themes + keyboard shortcuts

- ☀/☾ in sidebar toggles **light/dark theme**. Persisted across restarts.
- **System theme**: alongside Light and Dark there is a **System** option that follows your macOS appearance and live-updates the moment the OS flips light↔dark — no relaunch. A fresh install defaults to System; an explicit Light/Dark choice pins that theme.
- **Sidebar collapse**: a collapse/expand toggle hides the conversation sidebar to give the chat full width. State is remembered.
- **Markdown rendering**: assistant + user messages render Markdown with code-block syntax highlighting for 20+ languages.
- **Citation chips**: when the agent references a workspace file, the chip is clickable — Froglips confirms the resolved path and opens it. Opens are confined to the workspace root; absolute or traversal paths are rejected.
- **Scroll behavior**: the chat sticks to the bottom while a reply streams, but if you scroll up to read, autoscroll pauses so you aren't yanked back down — it resumes when you return to the bottom.
- **Empty-chat landing**: a brand-new chat shows clickable example prompts instead of a blank surface; click one to drop it into the composer.
- **Reduced motion**: entrance animations are disabled when your system "reduce motion" setting is on.

### Keyboard shortcuts

- **Cmd+N** — new chat
- **Cmd+L** — open model library
- **Cmd+K** — focus model picker
- **Cmd+F** — find in the open conversation (see §11)
- **Cmd+,** — open settings
- **?** (no modifier, outside any text field) — toggle the **keyboard-shortcuts cheatsheet**, a small overlay listing these shortcuts so they're discoverable without leaving the keyboard.

## 13. Voice input

Click the microphone icon next to the chat input. Uses Web Speech API. Speak, then click again to stop. Manual edits while listening are preserved — the transcript rebases around them. Recognized speech segments are joined with proper spacing.

## 14. File drag-drop

Drag any text file into the chat input area. Its path gets attached. The model sees the path in context. Total attached bytes capped at 1 MiB per turn.

## 15. Diagnostics, backup, and crash logs

Open the **Diagnostics** panel from the menu.

- **Crash log**: if Froglips ever panics, the crash is recorded to
  `~/.local-llm-app/crash.log`. The Diagnostics panel has a refreshable
  crash-log section showing recorded panics (or an empty state when there are
  none). Everything stays on disk — there is no telemetry.
- **Diagnostics bundle**: export a single archive (logs + crash log + redacted
  settings) to attach to a bug report. API keys and other secrets are redacted
  before it is written. The app version is shown in the Diagnostics header
  (next to the title), and a **Report an issue** link opens the GitHub tracker.
- **Data backup**: take an online backup of the conversation database.
- **Export / import**: export your conversations, messages, and memory to a
  versioned JSON file, and import one back. Import is **additive** — it merges
  into your existing data inside a transaction rather than overwriting it.

Your data also self-protects: on startup Froglips integrity-checks the
database and, if it finds corruption, quarantines the bad file and starts
fresh instead of failing to launch.

## 16. Updates

Two ways to get a new version:

- **In-app**: Settings → Updates → **Check for updates**. Downloads, installs, relaunches.
- **Manual**: download the DMG from the Releases page.

**Automatic update checks** run quietly in the background (shortly after launch,
then about once a day) and surface a banner when a newer version is available —
they never install on their own. This is **on by default**; toggle **Auto-update
→ "Check for updates automatically in the background"** off in Settings to opt
out. The manual **Check for updates** button works regardless of the toggle.

Updates are minisign-signed; the public key is embedded in the app. A tampered build will fail verification and refuse to install.

## 17. Troubleshooting

**Model picker shows nothing**
Load a model first: model dropdown → **⚡ Load a HuggingFace model natively…** and enter a repo id. Until a model has finished loading, the picker has nothing to show.

**Model fails to load**
First loads download weights from HuggingFace into `~/.cache/huggingface/hub`; a slow or interrupted download is the usual cause. Retry the load — completed shards are reused. Very large models may exceed available memory; try a smaller repo. Note: the native backend loads **standard** transformers checkpoints only — MLX-format repos (`mlx-community/*-4bit`, etc.) won't load natively; pick a plain safetensors repo (e.g. `Qwen/Qwen2.5-1.5B-Instruct`) or use the MLX backend for MLX models.

**"Workspace root is outside" errors**
Run an agent tool whose path falls outside the configured workspace. Either widen the workspace (settings ⚙) or move the file in.

**Build failure on DMG**
`hdiutil` sometimes leaves stale mounts. Fix:
```bash
hdiutil info | awk '/^\/dev\/disk/{print $1}' | xargs -I{} hdiutil detach {} -force
```
Then retry `npm run release`.
