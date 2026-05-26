<!--
Thanks for the PR. Fill in what applies — strike through anything that doesn't.
-->

## Summary
<!-- 1-3 bullets on what changed and why. -->

## Test Plan
<!-- Bulleted markdown checklist. Be specific. "Verified end-to-end" is not a test plan. -->
- [ ] `cargo fmt --check && cargo clippy --no-default-features -- -D warnings`
- [ ] `cargo test --no-default-features`
- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] Drove the affected surface in `npm run tauri dev` and observed expected behavior

## Security Checklist
<!-- Required for any change to src-tauri/src/{approval,policy,agent,mcp}, IPC handlers, or web fetch. -->
- [ ] No new `#[tauri::command]` handler that accepts paths/URLs/commands without validation
- [ ] No new untrusted-content path that reaches the model without `injection_scan::scan_and_wrap`
- [ ] No new approval-gated IPC without payload-binding via `approval::consume_with_binding`
- [ ] No secret material logged via `tracing` or `diagnostics`

## Screenshots / Captures
<!-- For UI changes. -->

## Breaking Changes
<!-- Any schema migrations, IPC signature changes, settings.json field removals? -->
- [ ] None
- [ ] Migration version bumped in `src-tauri/src/history.rs::MIGRATIONS`
- [ ] CHANGELOG.md updated under `[Unreleased]`
