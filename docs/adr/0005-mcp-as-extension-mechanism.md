# 0005: MCP servers as the extension story

- Status: accepted
- Date: 2026-05-26
- Deciders: @Jeritano

## Context

A local LLM workstation will eventually need extensibility — users
want to add their own tools (Jira search, Linear ticket create, k8s
kubectl, whatever). Options:

- **First-party plugin SDK**: ship a Rust/TS API contract, build a
  loader, document the lifecycle. Permanent platform commitment.
- **MCP (Model Context Protocol)**: open standard, growing ecosystem.
  Servers run as separate processes, talk JSON-RPC over stdio.
- **Lua/JS embedded runtime**: small footprint but reintroduces every
  embed-runtime sandboxing problem.

## Decision

MCP is the extension story. Users add MCP servers via
`settings.mcp_servers[]`; Froglips spawns them with `env_clear()` +
allowlist, lists their tools, presents them to the agent.

No first-party Rust/TS plugin API for v1.x. Everything that wants to
be an extension is an MCP server.

## Consequences

**+** No bespoke API to maintain. Ecosystem leverage: every MCP
server written for Claude Desktop / Cursor / Continue / Cody etc.
works in Froglips. Process isolation is a security win — extensions
can't read our memory or hijack our IPC handlers.

**−** stdio JSON-RPC has nontrivial overhead per call vs in-process.
Server failure modes (process crash, schema drift) need handling.
Per-tool latency includes a JSON-RPC round-trip.

**Hard to change later**: removing MCP after extensions exist means
breaking user installs. Adding a parallel first-party plugin API
later is fine.

**Re-evaluate**: if MCP traction stalls or the spec forks. Currently
(2026-05) the protocol has multi-vendor backing.
