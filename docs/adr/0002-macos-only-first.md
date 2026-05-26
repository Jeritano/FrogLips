# 0002: macOS-only for 1.x

- Status: accepted
- Date: 2026-05-26
- Deciders: @Jeritano

## Context

Tauri supports macOS, Windows, Linux. Several Froglips features are
macOS-specific by design:

- `applescript_run` / `open_app` / `show_notification`
- `screenshot` via `screencapture -x -t png`
- Keychain integration via `security-framework`
- TCC plist embed in `build.rs`
- mistralrs Metal backend (no CUDA equivalent shipped)
- macOS tray icon, global shortcut, file drag-drop

Each Linux/Windows port would need an equivalent surface. Estimated
incremental cost per platform: ~4-6 engineer-weeks plus ongoing
maintenance / per-platform CI / per-platform bug triage.

## Decision

macOS Apple Silicon only for the entire 1.x line. Tag any new feature
that bakes in a macOS assumption with `#[cfg(target_os = "macos")]`
gates so a future port has a clear surface to attack.

## Consequences

**+** Focus. Single distribution channel. One TCC model. One signing
flow. One backend kernel target (Metal).

**−** Excludes ~85% of LLM-curious users on Windows. Reduces feedback
volume. Closes off enterprise pilots that mandate Windows/Linux.

**Re-evaluate**: when product-market-fit on macOS justifies the
multi-platform investment, OR when llama.cpp + CPU-only inference
becomes the universally-acceptable fallback. Probably v2.0.
