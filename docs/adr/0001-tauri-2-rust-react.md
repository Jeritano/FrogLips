# 0001: Tauri 2 + Rust + React stack

- Status: accepted
- Date: 2026-05-26
- Deciders: @Jeritano

## Context

A local-first LLM workstation needs: (a) tight native integration
(keychain, TCC, AppleScript, file watcher, global shortcut), (b) a
modern UI for streaming chat + workflow canvas, (c) a low-friction
distribution story (single signed binary), (d) good crypto / signing /
networking primitives for the agent layer.

Candidate stacks evaluated:

- **Electron + Node**: easy UI, heavyweight runtime (~150 MB), no native
  crypto without C++ addons, security model treats the renderer as
  partially-trusted by default.
- **Tauri 2 + Rust + React**: small binary (~66 MB), Rust backend with
  first-class IPC trust boundary, WKWebView renderer, plugin system for
  updater / signing / dialog. Tooling matured in 2.x.
- **SwiftUI**: macOS-native, but locks out cross-platform later AND has
  weaker LLM/ML library ecosystem.

## Decision

Tauri 2 + Rust + React 19.

## Consequences

**+** Small binary, fast cold-start, Rust safety on the trust boundary,
React ecosystem for UI, cross-platform headroom for v2.0.

**−** WKWebView quirks (e.g. `webkitSpeechRecognition` TCC requirement
on the dev binary — addressed via `build.rs` Info.plist embed). Two
languages to staff. IPC layer is now a permanent surface (~250
commands at last count).

**Hard to change later**: every IPC handler's argument shape +
return type. Migration would mean a JSON-schema wire format and a
proxy layer. Avoid by keeping the IPC surface narrow and namespaced.
