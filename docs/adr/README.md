# Architecture Decision Records

Permanent record of choices that constrain the codebase. Each ADR is
immutable once merged — if the decision changes, write a new ADR
superseding it.

## Why ADRs

Codebases accumulate weird-looking patterns. Without a record of WHY,
the next contributor wastes a day re-discovering the constraint that
forced the pattern. ADRs make the constraint explicit and durable.

## Format

`NNNN-short-title.md` — incrementing number, kebab-case title. Body:

```
# NNNN: Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD
- Deciders: @handles

## Context
What's the situation. What constraints apply.

## Decision
What we chose.

## Consequences
What that buys us. What we give up. What's hard to change later.
```

## Index

- [0001](0001-tauri-2-rust-react.md) — Tauri 2 + Rust + React stack
- [0002](0002-macos-only-first.md) — macOS-only for 1.x
- [0003](0003-local-first-no-telemetry.md) — Local-only, no telemetry
- [0004](0004-result-string-error-model.md) — Status quo `Result<T, String>` IPC errors
- [0005](0005-mcp-as-extension-mechanism.md) — MCP servers as the extension story
