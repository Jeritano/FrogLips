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
- Gatekeeper bypass on a third-party machine — the app ships signed with a Developer ID certificate, notarized, and stapled, so it launches without a right-click-Open; the minisign-signed updater + SHA256SUMS carry the integrity guarantee for in-place updates.

## Disclosure timeline

We aim to acknowledge within 7 days, ship a fix within 30 days for actively exploited issues, and credit reporters in the release notes unless they ask to stay anonymous.

## Hardening summary

See [docs/AGENT_LAYER.md](docs/AGENT_LAYER.md) for the full list of protected paths, error envelopes, and tunables. Key boundaries:

- Paths canonicalized via `fs::canonicalize` before any read/write; `..` segments rejected outright.
- macOS-aware blocklist for `~/.ssh`, `~/.aws`, `~/.gnupg`, Keychains, Cookies, TCC, Mail, Messages, all of `/etc`, sudoers, `.env*`, `credentials*`, and the app's own install path — extended to `.netrc`, `.npmrc`, the `gh`/`gcloud` config dirs, Chrome/Firefox/Safari browser profiles, and the app's own `secrets.json`/DB. Comparisons are **case-insensitive and component-wise** (macOS APFS is case-insensitive but case-preserving, so a plain prefix match would let `~/.SSH/id_ed25519` or `.ENV` slip past); the same shared helper backs the agent fs gate, the backup/export/import write-dest gate, and project-policy deny rules so they can't drift.
- Optional workspace root confines all FS access to a chosen directory. Citation-chip file opens are confined to the workspace root and confirmed before opening.
- Destructive shell patterns (`rm -rf /`, `dd of=/dev/`, `mkfs`, `:(){:|:&};:`, fork-bombs, `sudo`, `curl ... | sh`) flagged in the confirm dialog.
- **OS sandbox on agent shell/code (default-on).** `run_shell` and `run_code` children run under a macOS Seatbelt profile (`sandbox-exec`) that denies read/write to the high-value credential set no build legitimately touches — `~/.ssh`, `~/.gnupg`, login/system Keychains, browser cookies, Mail/Messages, and Froglips' own config/DB. Network and ordinary build inputs (`~/.gitconfig`, `~/.npmrc`, `~/.aws`, project files) stay allowed so builds aren't broken. A one-time startup probe disables the wrapper if `sandbox-exec` or the profile is unusable, so a bad profile degrades to unsandboxed rather than bricking the shell; `FROGLIPS_NO_SHELL_SANDBOX=1` opts out. The per-call approval click remains the primary boundary — this is defense-in-depth that contains an approved-but-malicious command, plus env-scrubbing (secret/loader keys removed), a dedicated process group killed on timeout/cancel, and `RLIMIT_FSIZE`/no-core caps.
- Custom-backend (and MCP remote) API keys are stored in the **macOS login Keychain** (in-process Security.framework, so the item ACL binds to the stable notarized Developer ID signature), never in plaintext `settings.json`, and redacted from the settings blob returned to the webview. A `0600` `secrets.json` under the app's config dir is the fallback: keys from older builds auto-migrate into the Keychain on first read (then the plaintext is purged), a Keychain failure transparently falls back to the file so a key is never lost, and `FROGLIPS_SECRETS_FILE=1` reverts to the file outright. (The Keychain was originally dropped because each *ad-hoc* re-signed build reset the ACL and re-prompted; a stable notarized signature removes that, so it is the default again.)
- SSRF guard on all agent web tools: rejects loopback/private/link-local/metadata hosts, IPv4-mapped IPv6 literals, and NAT64 ranges; redirects are followed with the connection pinned to each hop's validated IP set, closing DNS-rebinding TOCTOU. The browser tool (off-by-default feature) pins Chrome's own resolver to the validated IP via `--host-resolver-rules` so it can't re-resolve to an internal address at connect time.
- Resource caps against a hostile peer: OAuth/MCP HTTP response bodies (success and error paths) and workflow `graph_json` are size-bounded before parsing; the fallback `secrets.json` (when the Keychain is unavailable or `FROGLIPS_SECRETS_FILE=1`) is written via `O_EXCL` to a unique temp file (no symlink-follow, `0600` guaranteed) then atomically renamed, and its perms are re-asserted to `0600` on load.
- Untrusted tool output is routed through the injection-scan wrapper before reaching the model: `read_file`, `read_pdf`, `clipboard_get`, browser get-text + page title, all git read tools, `web_fetch`/`web_search` (incl. result titles), `http_request` (body + response headers), MCP tool results (success **and** `isError`), RAG hits, `ask_user` answers, `run_shell`/`run_code` stdout+stderr, `diff_files`, subagent answers, and `list_dir` entry names (flagged, not mutated, so the agent can still open them).
- Tool confirmation is **default-deny by completeness**: every side-effectful tool — including `format_code`, `screenshot`, `show_notification`, `remember`, `watch_path`, `stop_watch`, `task_cancel` — requires explicit confirmation; dry-run keys off a read-only allowlist, so `run_code`/`task_create`/MCP/any new tool are suppressed under "side-effects suppressed" rather than executed.
- Agent authorization: subagents don't inherit the parent's blanket approvals, their tool grant is **intersected** with the parent's (a preset can't broaden scope), `spawn_subagent` is confirmation-gated, repo-supplied policy can't auto-approve `run_shell`/`applescript_run`, and body-bearing `http_request` is treated as elevated risk.
- **Computer Use (desktop control) is OFF by default and quadruple-gated.** The `cu_*` mouse/keyboard/screenshot tools run only when the user enables `computer_use_enabled`. When off they are absent from the system prompt **and** hard-blocked at dispatch, so a prompt-injected or hallucinated `cu_*` call can never drive the desktop. When on, each action additionally requires (1) the per-call confirmation modal, (2) a payload-bound Rust approval token (`verify_bound` over the exact coordinates/text/keys, so an approved click can't be swapped for another), and (3) macOS Accessibility (`AXIsProcessTrusted`), checked driver-side and failing closed rather than posting an event the OS would silently drop. Screenshots feed the model as image input but the captured bytes never leave the machine.
- MCP tools are treated as untrusted: tool descriptions are sanitized before entering the system prompt, and every MCP tool is risk-classified so its calls always require explicit confirmation and can never be auto-approved (not under session approvals, not under a project policy).
- DB durability: on startup the app runs `PRAGMA integrity_check` and quarantines a corrupt database (timestamp-renamed) so a damaged file degrades to a clean start instead of a panic. Settings-file writes are atomic (temp file + rename).
- Diagnostics are local-only: a crash log (`~/.local-llm-app/crash.log`), a rolling `app.log`, and the export-diagnostics-bundle command all stay on disk — no telemetry, no network transmission. The diagnostics bundle redacts settings (including API keys) before it is written.
- Updater binaries verified against an embedded minisign public key; tampered payloads refused.
- Memory recall block escapes `<`, `>`, and Unicode RTL marks before injection.
- `open_external`: any `http(s)` URL with a valid host; non-http(s) schemes rejected.
- All subprocesses use `kill_on_drop(true)` + timeouts.
