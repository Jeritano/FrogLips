# Contributing

Patches welcome. Keep this short — Froglips is small.

## Setup

```bash
git clone git@github.com:Jeritano/FrogLips.git
cd FrogLips
npm install
npm run tauri dev
```

You'll need Node 22+, Rust stable, and Xcode command-line tools.

## Before you push

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npx tsc --noEmit
```

CI runs the same three commands on every push. A separate CI job also
compile-checks the Rust crate on Linux and Windows on every PR, so
platform-specific breaks surface before release-tag time — keep cross-platform
code (`cfg`-gated backends, path handling) building on all targets.

Database schema changes go through the numbered `user_version` migration
ladder in `src-tauri/src/history.rs`: add a new numbered step rather than an
ad-hoc `ALTER`, and make it transactional and idempotent so fresh and existing
databases converge on the same schema.

## Style

- Rust: `cargo fmt`. Prefer explicit error types over `anyhow` in library code that's tested.
- TypeScript: no formatter enforced, but match the existing 2-space, semicolons-on style.
- Commits: imperative mood, prefix with `vX.Y.Z:` if it's a release commit. Detail in body.
- Do not credit AI assistants in commit messages (no `Co-Authored-By` for any model / tool).

## Pull requests

- One concern per PR.
- Include a test for any new agent tool or path-validation change.
- Update `CHANGELOG.md` under `[Unreleased]`.
- Update relevant docs (`docs/USER_GUIDE.md`, `docs/AGENT_LAYER.md`, etc.) when behaviour changes.

## Security issues

See [SECURITY.md](SECURITY.md) — do not file public issues for vulnerabilities.

## Release process

See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md).
