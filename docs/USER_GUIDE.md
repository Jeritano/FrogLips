# Froglips — User Guide

Version 0.6.3 · macOS (Apple Silicon)

## 1. Install

### From a release

1. Download `Froglips_0.6.3_aarch64.dmg` from the [Releases page](https://github.com/Jeritano/FrogLips/releases/latest).
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

Froglips uses one or both of these backends. You can install only what you need.

### Ollama (easiest, cloud + local)

1. Install from <https://ollama.com>
2. Start it: it lives in the menu bar
3. If you want cloud models: `ollama signin`

### MLX (Apple's Metal-accelerated local inference)

```bash
python3 -m venv ~/.venvs/mlx
~/.venvs/mlx/bin/pip install mlx-lm
```

Froglips spawns `mlx_lm.server` automatically when you pick an MLX model.

## 3. First chat

1. Click **+ New chat** in the sidebar.
2. Click the model dropdown at the top → **Browse & download models…**
3. The Model Library opens. Default tab is **Installed** (empty on a fresh install).
4. Switch to the **Ollama** tab. Pick something small to start, like `llama3.2:3b` or `qwen3:4b`. Click **Pull**. (First pull downloads ~2 GB, takes a few minutes.)
5. After it finishes, close the library. The model now appears in the dropdown.
6. Pick the model, click **Start**. Status will go `stopped → loading → ready`.
7. Type a message and press Enter. Stream the response.

## 4. The Model Library

Five tabs:

| Tab | What you'll find |
|---|---|
| **Installed** | Everything currently pulled. Ollama models and MLX models, with sizes and a **Remove** button each. Default tab. |
| **Ollama** | Curated catalog of popular Ollama models (cloud + local). Already-installed entries show a green `✓ installed` tag and a **Remove** button. |
| **HuggingFace MLX** | Live search of `huggingface.co` filtered to MLX models. Sort by downloads, see likes, license, base model, last modified. |
| **RP / Kobold** | Curated roleplay finetunes from HF (TheDrummer, Sao10K, anthracite, ReadyArt, etc.). |
| **Civitai** | Live search of `civitai.com`. Mostly diffusion (image gen) — direct loading not supported, but useful for browsing. Shows ratings, SHA256, file format, license, scan status. |

### Removing models

- **Installed tab:** trash button next to each model. Confirms before deleting.
- **Inline:** on Ollama / HF / RP tabs, any model that's already pulled shows a red **Remove** button instead of *Pull*.

Removing frees up the actual disk space — there is no undo.

## 5. Memory system

Froglips remembers things across conversations. There are four modes (set via the small ⓘ button next to the model name):

| Mode | What it does |
|---|---|
| **off** | No memory recall. No fact extraction. |
| **manual** | Recalls relevant memories for context. You add memories manually via the Memories panel. |
| **queue** | Same as manual, plus automatically extracts facts after each turn into a **pending** queue. You review and approve. |
| **direct** | Same as queue, but auto-approved into the active set. Most automatic. |

### How recall works

Before each turn, Froglips embeds your message using `nomic-embed-text` (via Ollama), looks for memories with cosine similarity > 0.55, and injects up to 5 into the system prompt as a `<memory>…</memory>` block.

If vector search returns nothing, it falls back to keyword search.

### How extraction works

After each turn, Froglips asks a small model (`qwen3:4b` if installed, else fallbacks) to extract JSON facts from your message + the assistant's reply. Facts are deduped against existing memories at 0.85 cosine before insert.

Secrets are auto-rejected: AWS/OpenAI/GitHub/Slack tokens, JWTs, bearer-prefixed strings, labeled hex blobs.

### Memories panel

Open from the sidebar's ⭐ button. Two tabs:

- **Active** — memories that will be recalled
- **Pending** — auto-extracted memories awaiting your approval (in `queue` mode)

You can delete, promote pending → active, or add manually.

## 6. Agent mode

Toggle the **Agent** button next to the chat input. Available only with the Ollama backend.

The agent has direct access to the user's filesystem and shell via 7 tools:

| Tool | What it does |
|---|---|
| `read_file` | Read file contents (paginated, 64 KB chunks) |
| `list_dir` | List directory entries with kind + size |
| `search_files` | Recursive grep with filename glob (`*.ts` etc.) |
| `file_exists` | Check whether a path exists + its kind |
| `edit_file` | Find-and-replace edit on existing files |
| `write_file` | Write or overwrite a file (requires approval) |
| `run_shell` | Execute via `sh -c` (requires approval, 30 s timeout) |

### Agent presets

Next to the Agent toggle is a dropdown of presets:

| Preset | Tools | Best for |
|---|---|---|
| **General** | All | Mixed tasks |
| **Coder** | read, list, search, exists, edit, write, run_shell | Software work |
| **Researcher** | read, list, search, exists | Read-only investigation |
| **Shell** | run_shell, list, exists, read | Terminal-style tasks |

Each preset comes with a system prompt tailored to its purpose. Switching presets mid-conversation changes the prompt for the next turn.

### Safety

- Every `run_shell`, `write_file`, and `edit_file` call requires explicit user approval.
- The confirm dialog shows a `destructive` / `privileged` / `pipe-from-network` badge for risky patterns (e.g. `rm -rf /`, `sudo`, `curl … | sh`).
- Path traversal (`..`), symlink escape, and writes to `~/.ssh`, `~/.aws`, `~/Library/Keychains`, `.env*`, sudoers, etc. are blocked by the Rust side.
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

## 7. Voice input

Click the microphone icon next to the chat input. Uses Web Speech API. Speak, then click again to stop. Manual edits while listening are preserved — the transcript rebases around them.

## 8. File drag-drop

Drag any text file into the chat input area. Its path gets attached. The model sees the path in context. Total attached bytes capped at 1 MiB per turn.

## 9. Updates

Two ways to get a new version:

- **In-app**: Agent settings ⚙ → **Check now**. Downloads, installs, relaunches.
- **Manual**: download the DMG from the Releases page.

Updates are minisign-signed; the public key is embedded in the app. A tampered build will fail verification and refuse to install.

## 10. Troubleshooting

**"Ollama: ollama not found on PATH"**
The app prepends common bin dirs (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.cargo/bin`, `~/.venvs/mlx/bin`) at startup. If Ollama lives elsewhere, symlink it into one of those.

**Agent says "I don't have access"**
You're probably on the MLX backend (agent is Ollama-only). Pick an Ollama model.

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
