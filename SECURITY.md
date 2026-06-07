# Security Policy

## Reporting a vulnerability

Open a private security advisory at:

<https://github.com/Jeritano/FrogLips/security/advisories/new>

Or email a maintainer if you have a contact. **Do not file a public issue** for vulnerabilities.

## Scope

Froglips is a desktop app that gives an LLM direct access to the user's filesystem and shell. The agent layer is the most security-sensitive surface. We treat the following as in-scope:

- Sandbox bypass: any way an agent tool can read or write a path outside the protected list or workspace root.
- Privilege escalation through `run_shell` (writing into the app's own bundle, modifying launch agents, etc.).
- Path traversal that survives canonicalization (`..`, symlink chains).
- Prompt injection that escapes the memory recall block.
- Updater signature bypass (forged minisign signatures accepted).
- Tampering with persistent settings or the SQLite DB through the IPC surface.
- Credentials disclosure: any way the agent can read `~/.ssh`, `~/.aws`, Keychains, etc., despite the protected list.

Out of scope:

- A user explicitly approving a destructive `run_shell` command — that's the user's call.
- Anything that requires the attacker to already have shell access on the user's machine.
- macOS Gatekeeper warnings (the app is intentionally not yet notarized). Notarization is on the roadmap — see `docs/RELEASE_PROCESS.md#notarization-roadmap`. Until then, users right-click-Open through Gatekeeper; the minisign-signed updater + SHA256SUMS provide the integrity guarantee that notarization would otherwise carry.

## Disclosure timeline

We aim to acknowledge within 7 days, ship a fix within 30 days for actively exploited issues, and credit reporters in the release notes unless they ask to stay anonymous.

## Hardening summary

See [docs/AGENT_LAYER.md](docs/AGENT_LAYER.md) for the full list of protected paths, error envelopes, and tunables. Key boundaries:

- Paths canonicalized via `fs::canonicalize` before any read/write; `..` segments rejected outright.
- macOS-aware blocklist for `~/.ssh`, `~/.aws`, `~/.gnupg`, Keychains, Cookies, TCC, Mail, Messages, all of `/etc`, sudoers, `.env*`, `credentials*`, and the app's own install path — extended to `.netrc`, `.npmrc`, the `gh`/`gcloud` config dirs, Chrome/Firefox/Safari browser profiles, and the app's own `secrets.json`/DB. Comparisons are **case-insensitive and component-wise** (macOS APFS is case-insensitive but case-preserving, so a plain prefix match would let `~/.SSH/id_ed25519` or `.ENV` slip past); the same shared helper backs the agent fs gate, the backup/export/import write-dest gate, and project-policy deny rules so they can't drift.
- Optional workspace root confines all FS access to a chosen directory. Citation-chip file opens are confined to the workspace root and confirmed before opening.
- Destructive shell patterns (`rm -rf /`, `dd of=/dev/`, `mkfs`, `:(){:|:&};:`, fork-bombs, `sudo`, `curl ... | sh`) flagged in the confirm dialog.
- Custom-backend (and MCP remote) API keys are stored in a `0600` `secrets.json` under the app's config dir — never in plaintext `settings.json` — and redacted from the settings blob returned to the webview. (They previously lived in the macOS login Keychain; that was dropped because each ad-hoc re-signed build reset the Keychain ACL and re-prompted on every access. The local file is owner-only at rest.)
- SSRF guard on all agent web tools: rejects loopback/private/link-local/metadata hosts, IPv4-mapped IPv6 literals, and NAT64 ranges; redirects are followed with the connection pinned to each hop's validated IP set, closing DNS-rebinding TOCTOU. The browser tool (off-by-default feature) pins Chrome's own resolver to the validated IP via `--host-resolver-rules` so it can't re-resolve to an internal address at connect time.
- Resource caps against a hostile peer: OAuth/MCP HTTP response bodies (success and error paths) and workflow `graph_json` are size-bounded before parsing; the local `secrets.json` is written via `O_EXCL` to a unique temp file (no symlink-follow, `0600` guaranteed) then atomically renamed.
- Untrusted tool output is routed through the injection-scan wrapper before reaching the model: `read_file`, `read_pdf`, `clipboard_get`, browser get-text + page title, all git read tools, `web_fetch`/`web_search` (incl. result titles), `http_request` (body + response headers), MCP tool results (success **and** `isError`), RAG hits, `ask_user` answers, `run_shell`/`run_code` stdout+stderr, `diff_files`, subagent answers, and `list_dir` entry names (flagged, not mutated, so the agent can still open them).
- Tool confirmation is **default-deny by completeness**: every side-effectful tool — including `format_code`, `screenshot`, `show_notification`, `remember`, `watch_path`, `stop_watch`, `task_cancel` — requires explicit confirmation; dry-run keys off a read-only allowlist, so `run_code`/`task_create`/MCP/any new tool are suppressed under "side-effects suppressed" rather than executed.
- Agent authorization: subagents don't inherit the parent's blanket approvals, their tool grant is **intersected** with the parent's (a preset can't broaden scope), `spawn_subagent` is confirmation-gated, repo-supplied policy can't auto-approve `run_shell`/`applescript_run`, and body-bearing `http_request` is treated as elevated risk.
- MCP tools are treated as untrusted: tool descriptions are sanitized before entering the system prompt, and every MCP tool is risk-classified so its calls always require explicit confirmation and can never be auto-approved (not under session approvals, not under a project policy).
- DB durability: on startup the app runs `PRAGMA integrity_check` and quarantines a corrupt database (timestamp-renamed) so a damaged file degrades to a clean start instead of a panic. Settings-file writes are atomic (temp file + rename).
- Diagnostics are local-only: a crash log (`~/.local-llm-app/crash.log`), a rolling `app.log`, and the export-diagnostics-bundle command all stay on disk — no telemetry, no network transmission. The diagnostics bundle redacts settings (including API keys) before it is written.
- Updater binaries verified against an embedded minisign public key; tampered payloads refused.
- Memory recall block escapes `<`, `>`, and Unicode RTL marks before injection.
- `open_external`: any `http(s)` URL with a valid host; non-http(s) schemes rejected.
- All subprocesses use `kill_on_drop(true)` + timeouts.
