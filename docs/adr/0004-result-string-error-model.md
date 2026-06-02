# 0004: `Result<T, String>` IPC errors (interim)

- Status: accepted (interim — superseded TBD when CommandError migration lands)
- Date: 2026-05-26
- Deciders: @Jeritano

## Context

Every `#[tauri::command]` in the codebase returns `Result<T, String>`.
The string carries the human-readable error; the renderer surfaces it
via `setErr()` / ErrorBar.

Senior SE review (2026-05-25) flagged this as a maturity gap: the UI
cannot distinguish:

- ValidationFailed (retryable with different input)
- NotFound (target gone, suggest different one)
- Unavailable (backend down, suggest start/restart)
- Internal (unrecoverable, surface stack)

A typed `enum CommandError` with `From<anyhow::Error>` would give the
frontend a discriminated union for retry hinting + nicer UX.

## Decision

Defer the migration to a focused PR series. Reasons:

1. Touches every IPC handler + every catch-site in the renderer
   (~250 + ~150 sites). Big-bang risk.
2. Need to define the taxonomy first (5-7 variants? 20?). Premature
   choice baked into 250 call sites is worse than the status quo.
3. Other maturity items (tests, release pipeline) have higher
   leverage per engineer-hour.

For now: keep `Result<T, String>`. New IPC handlers MAY use the
existing helper `commands::map_err` to flatten anyhow into a string,
or return `String` directly with a stable prefix the UI can pattern-
match (e.g. `"backend_unavailable: ..."`).

## Consequences

**+** No churn. CI green. Existing tests untouched.

**−** UI continues to render generic error strings. No retry hinting.
Stack traces lost on `anyhow::Error.to_string()`.

**Re-evaluate**: after test coverage on UI error paths reaches ~60%
so a migration has a safety net. Then design the enum, do a wave-
based migration (group by module, one PR per wave).
