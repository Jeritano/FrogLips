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
- macOS Gatekeeper warnings (the app is intentionally not yet notarized).

## Disclosure timeline

We aim to acknowledge within 7 days, ship a fix within 30 days for actively exploited issues, and credit reporters in the release notes unless they ask to stay anonymous.

## Hardening summary

See [docs/AGENT_LAYER.md](docs/AGENT_LAYER.md) for the full list of protected paths, error envelopes, and tunables. Key boundaries:

- Paths canonicalized via `fs::canonicalize` before any read/write; `..` segments rejected outright.
- macOS-aware blocklist for `~/.ssh`, `~/.aws`, `~/.gnupg`, Keychains, Cookies, TCC, Mail, Messages, sudoers, `.env*`, `credentials*`, and the app's own install path — extended to `.netrc`, `.npmrc`, the `gh`/`gcloud` config dirs, Chrome/Firefox/Safari browser profiles, and the app's own `settings.json`.
- Optional workspace root confines all FS access to a chosen directory. Citation-chip file opens are confined to the workspace root and confirmed before opening.
- Destructive shell patterns (`rm -rf /`, `dd of=/dev/`, `mkfs`, `:(){:|:&};:`, fork-bombs, `sudo`, `curl ... | sh`) flagged in the confirm dialog.
- Custom-backend API keys are stored in the macOS Keychain, not in plaintext `settings.json`, and redacted from the settings blob returned to the webview.
- SSRF guard on all agent web tools: rejects loopback/private/link-local/metadata hosts, IPv4-mapped IPv6 literals, and NAT64 ranges; redirects are followed with the connection pinned to each hop's validated IP set, closing DNS-rebinding TOCTOU.
- Untrusted tool output (`read_file`, `read_pdf`, `clipboard_get`, browser get-text, git read tools) is routed through an injection-scan wrapper before reaching the model.
- Agent authorization: subagents don't inherit the parent's blanket approvals, `spawn_subagent` is confirmation-gated, repo-supplied policy can't auto-approve `run_shell`/`applescript_run`, and body-bearing `http_request` is treated as elevated risk. MCP tool descriptions are sanitized before entering the system prompt.
- Updater binaries verified against an embedded minisign public key; tampered payloads refused.
- Memory recall block escapes `<`, `>`, and Unicode RTL marks before injection.
- `open_external` allow-list: huggingface, civitai, ollama hosts only.
- All subprocesses use `kill_on_drop(true)` + timeouts.
