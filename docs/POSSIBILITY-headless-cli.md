# POSSIBILITY — Headless / CLI mode for Froglips

> **STATUS: POSSIBILITY — under consideration, NOT approved, nothing built.**
> This is an exploration to think on, not a committed plan. No code has been
> written. Decisions in the "Open decisions" section are unmade.
>
> Produced 2026-06-12 from an 18-agent deep-dive (map the codebase → study prior
> art → design 4 competing architectures → 3 scoring panels → adversarial
> verification of the leader). ~1.5M tokens of analysis against the real repo.

## Goal
A terminal command that runs a Froglips agent task non-interactively (scripting,
cron, CI) — no GUI. e.g.:

```
froglips run --workspace ~/hamhawk "fix the failing build"
git diff | froglips run "review this diff"
```

Today Froglips has **no CLI** — `fn main()` just calls `run()` and launches the
WKWebView. No arg parsing, no deep-link, no control server.

---

## Recommendation (one line)
**One TS agent loop + one Rust tool layer, shared behind a single interface;
the headless host runs the loop in Node and the tools in a Rust sidecar.**
Ship Ollama-first, **read-only by default**, with an OS-level sandbox on
`run_shell`/`run_code`. = "Architecture D's structure, Architecture B's
transport, shipped in increments."

---

## The four architectures evaluated

| # | Architecture | Where the loop runs | How tools run |
|---|---|---|---|
| **A** | Rust-native rewrite | new Rust binary (loop re-implemented in Rust) | direct `agent::*` fn calls |
| **B** | Node loop + Rust sidecar | Node/Bun process | stdio JSON-RPC → Rust sidecar |
| **C** | Headless Tauri | hidden WKWebView | normal `invoke()` IPC |
| **D** | Shared core (B done deliberately) | Node (v1) → bun-compiled sidecar (end-state) | one `ToolHost` iface, two adapters |

### Scores (3 independent lenses; each = sum of 6 criteria scored 1–10)

| Architecture | Pragmatic-ship | Maintainability | Security/Ops | Avg |
|---|---|---|---|---|
| **B** | **45** | 42 | **47** | **44.7** |
| **D** | 44 | **45** | 43 | 44.0 |
| C | 43 | 40 | 39 | 40.7 |
| A | 32 | 28 | 33 | 31.0 |

B and D are the same family. B = ship-now; D = the long-term shape (single
source of truth). Recommend converging: build B's mechanism *inside* D's
structure so the loop logic is never forked.

---

## What the codebase mapping proved (feasibility — GOOD)

- **TS agent loop is ~99% portable.** `grep` across `src/lib/agent-loop/*.ts`:
  **zero** `window.` / `document.` / `@tauri-apps/api` / `localStorage` /
  `listen`. Only browser APIs used: `crypto.randomUUID`, `performance.now`,
  `AbortSignal` — all native in Node 20+ (`engines` already requires ≥20.19).
- **Rust tool layer is already pure.** `agent/{fs,shell,web,git,system,code,
  extras}.rs` are plain async fns with **zero AppHandle coupling** — reusable
  verbatim from a non-Tauri binary (one `tauri::` hit is in `fs_watcher.rs`,
  not the tool path).
- **Single clean seam.** All ~198 tool calls funnel through one file
  (`src/lib/tauri-api.ts`) → swap that facade, the loop is unaware.
- **Backends:** Ollama = pure HTTP to `127.0.0.1:11434` (trivially headless).
  MLX = pure HTTP to `:8080` (headless + spawn `mlx_lm.server`). Native
  `mistralrs` = in-process + Metal, streams via **Tauri events** today (needs a
  refactor before it's headless-clean) — defer.

## What adversarial verification REFUTED (the real work — READ THIS)

1. **🔴 CRITICAL — confinement does NOT cover the execution tools.**
   `within_workspace` + the credential/system denylists (`fs.rs:218-317`) gate
   only the *structured* FS tools (read/write/edit/move/copy/delete).
   **`run_shell` is explicitly NOT confined** (`shell.rs:243-248`) — a shell
   command can absolute-path anywhere. With no human in the loop, a
   prompt-injected agent that gets shell can escape the workspace and exfiltrate
   /mutate outside it. **This is true for ALL four architectures** and is the
   single most important finding.
   **Required fix:** (a) default-deny execution tools in headless; (b) wrap the
   `sh -c` spawn (`shell.rs:278`) and the `run_code` interpreter spawn
   (`shell.rs:163`) in macOS `sandbox-exec`/Seatbelt, network-off by default, so
   confinement is OS-enforced and does not depend on the loop's honesty.

2. **🟠 Streaming, not just `invoke`.** A load-bearing part of the system rides
   the **Tauri event bus** (`AppHandle::emit` ↔ renderer `listen`), which has no
   request/response equivalent: native-backend LLM streaming
   (`native-chunk`/`native-toolcalls`) and `ask_user`. The sidecar boundary must
   carry **streams + interactive prompts**, not only tool calls. Most
   underestimated piece — *not* tool dispatch (which is trivial).

3. **🟠 Effort was optimistic.** Real cost center = streaming transport +
   human-in-the-loop replacement + OS sandbox. Tool dispatch is the easy part
   (one transport swap behind the centralized facade).

4. **`ask_user` is the one tool with no headless equivalent** — wire it to a
   stdin TTY prompt when attached, else a structured `ask_user_unavailable`
   failure. **Never hang** (the Cursor hang-bug lesson).

## Why NOT C / A

- **C (headless Tauri):** a hidden WKWebView still needs a **WindowServer / GUI
  session**. On a true headless CI/cron host it won't instantiate → fails the
  entire purpose. Only viable as an "attach to the already-running desktop app"
  fast-path, not the core mechanism.
- **A (Rust rewrite):** discards the most battle-tested code in the repo (the TS
  loop — hardening tasks #24–#71) and creates **permanent two-loop divergence**
  (a fix lands in one loop, not the other). *Exception:* native-`mistralrs` is
  genuinely easier in-process from Rust — keep as a future per-backend option.

---

## Recommended CLI surface (prior-art consensus)
Studied: Claude Code `claude -p`, Codex `codex exec`, aider `--message`,
opencode `run`, Cursor `-p`, continue `cn -p`, goose `run`.

```
froglips run [--] "<prompt>"            # `run` verb → bare `froglips` still launches the GUI
git diff | froglips run "review this"   # stdin pipe
froglips run -f task.md --workspace ~/proj
  --output-format text|json|stream-json   # text→stdout; ALL logs/progress→stderr (pipes clean)
  --ask-for-approval untrusted|on-failure|on-request|never
  --sandbox read-only|workspace-write|danger-full-access   # default: read-only
  --agent coder  --model qwen3-coder:480b-cloud  --max-turns N
```

### Security model (Codex's two-axis design — the best-engineered)
Separate **approval policy** ("what may the agent attempt") from **OS sandbox**
("what can the process physically do"). Defaults fail-closed:
- `--sandbox read-only` default; `workspace-write` confines edits to cwd+temp;
  **network OFF by default** even when writes are allowed.
- **Require explicit `--workspace`** in non-TTY contexts — never fall back to the
  home dir under a service user.
- IRREVERSIBLE tools (delete/kill/undo) never auto-run.
- `injection_scan` fencing + path denylists stay always-on (non-bypassable).
- `ask_user` → fail-closed in unattended mode.

---

## Phased plan + honest effort

- **Phase 0 — seam (~1 wk):** extract one `AgentHost`/`ToolHost` TS interface
  that BOTH the webview (`TauriToolHost` = today's `tauri-api.ts`) and the CLI
  implement → `tsc` enforces parity, no logic fork. Mechanical, behind the
  existing vitest gate.
- **Phase 1 — MVP (~3 wk):** Node loop + Rust tools sidecar (stdio JSON-RPC that
  carries streams), Ollama-only, read-only default, fs/git/web tools, text/json
  output. Usable.
- **Phase 2 — hardened v1 (~2–3 wk):** Seatbelt sandbox at the shell/code spawn,
  two-axis approval, MLX backend, MCP + memory over RPC, stream-json, exit codes,
  packaging/notarization (sign the second binary / cask).
- **Phase 3 — optional:** native-mistralrs headless (~1 wk, event→channel
  refactor); bun-compiled single binary to drop the Node dep / enable Docker
  (~1–1.5 wk); attach-to-running-desktop backend (avoid double model cold-start).

**Realistic: ~6–8 weeks for a hardened v1.** Read-only Ollama MVP in ~3.

---

## Open decisions (unmade — to think on)
1. **Security default:** read-only + Seatbelt-on out of the box (safest; edits
   require `--sandbox workspace-write`)? — *recommended yes.*
2. **Backend scope v1:** Ollama-only first → MLX next → native deferred? —
   *recommended yes.*
3. **Ship increment:** ~3-week read-only MVP first, or hold for the ~6–8-week
   hardened v1?
4. **Runtime:** Node (fast, needs node present) vs bun-compiled single binary
   (self-contained, +1 wk)? — *recommended Node for v1, bun later.*
5. **Is this worth building at all** vs. just documenting `curl`/`ollama`
   direct-access for scripting? (The CLI's value = the agent loop + tools +
   workspace confinement + flows, which raw `ollama` does not give.)

## Appendix — reuse estimates (verified against repo)
- TS agent loop (~8.4k LOC, 16 modules): **~99% reused unchanged**; only
  `tauri-api.ts` is swapped for an RPC shim.
- Rust tool layer (`agent/*.rs`, `approval.rs`, `policy.rs`, `injection_scan`,
  `mcp/`, `memory.rs`, `rag.rs`): **~95% reused**; net-new is a ~400–600 LOC
  JSON-RPC dispatcher + the CLI harness (~1.5–2k LOC) + the Seatbelt wrapper.
- Tool JSON schemas (`tools.ts`, ~85 entries): export to a shared `tools.json`
  so the CLI and GUI never fork the tool catalog.
