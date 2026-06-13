# Release Process

How to ship a new Froglips version.

## Versioning

[Semver](https://semver.org). Bump in lockstep across three files:

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`

Patch (0.0.X) — bug fixes, no API change.
Minor (0.X.0) — new features, no breaking change to user data.
Major (X.0.0) — schema migrations, breaking config changes.

### Pre-1.0 policy (current)

While the project is still pre-1.0 the patch and minor bumps **may
include forward-only DB schema migrations** that change the user-data
contract. Migrations are additive (new columns, new indexes, new
tables) and run automatically via the `PRAGMA user_version` ladder in
`src-tauri/src/history.rs`. We track the current schema version in
that file's `MIGRATIONS` array (latest = v13 at the time of writing).

Once the schema and IPC surface stabilise enough that we feel comfortable
calling a major bump a breaking-change marker, we'll cut **1.0.0** and
switch to the standard semver contract. Track readiness as: stable IPC
surface (no command renames between minor versions), stable DB schema
(no migrations between minor versions), and a non-empty co-maintainer
roster.

## Build prerequisites

- **Full Xcode** (App Store) — not just the Command Line Tools. `mistralrs` requires the `metal` compiler which only ships in `Xcode.app`.
- After installing Xcode:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -runFirstLaunch
  sudo xcodebuild -license accept
  xcodebuild -downloadComponent MetalToolchain
  xcrun -f metal   # should print a path
  ```
- Node 22+, Rust stable
- Updater minisign keypair at `~/.tauri/froglips.key` (gitignored)

## Build

```bash
npm run release
```

This script (`scripts/release.sh`):

1. Kills any running `Froglips.app` (so DMG bundling can mount cleanly)
2. Exports `TAURI_SIGNING_PRIVATE_KEY=~/.tauri/froglips.key` if present
3. Runs `npm run tauri build -- --features native-mistralrs` (set `FROGLIPS_SKIP_NATIVE=1` to build a lean ~14 MB binary without mistralrs / candle / Metal kernels — useful for fast iteration when you only need Ollama / MLX). The umbrella `native-inference` flag was retired in Phase 2 — use `native-mistralrs` directly.
4. **Smoke-tests the built app before installing** — launches the bundle and confirms it starts cleanly, so a broken build never replaces a working install. (The probe reads `CFBundleExecutable` from the bundle `Info.plist`; the executable inside the bundle is the Cargo bin name `local-llm-app`, not `Froglips`.)
5. Replaces `/Applications/Froglips.app`
6. Strips Gatekeeper quarantine
7. Ad-hoc codesigns (`codesign --sign - --deep --force`)
8. Refreshes the `~/Desktop/Froglips` alias

Build artifacts land in:

```
src-tauri/target/release/bundle/macos/
├── Froglips.app                  (installed bundle)
├── Froglips.app.tar.gz           (updater asset)
└── Froglips.app.tar.gz.sig       (minisign signature)
src-tauri/target/release/bundle/dmg/
└── Froglips_<version>_aarch64.dmg
```

## Publish to GitHub

After a successful build:

```bash
VERSION=$(node -p "require('./package.json').version")
SIG=$(cat src-tauri/target/release/bundle/macos/Froglips.app.tar.gz.sig)

# 1. Build the updater manifest
cat > /tmp/latest.json <<EOF
{
  "version": "${VERSION}",
  "notes": "Short release notes...",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG}",
      "url": "https://github.com/Jeritano/FrogLips/releases/download/v${VERSION}/Froglips.app.tar.gz"
    }
  }
}
EOF

# 2. Commit + tag
git add -A
git commit -m "v${VERSION}: <summary>"
git tag -a v${VERSION} -m "v${VERSION} — <summary>"
git push origin main v${VERSION}

# 3. Create the GitHub release with all four assets
gh release create v${VERSION} \
  --title "v${VERSION} — <summary>" \
  --notes "<detailed notes>" \
  src-tauri/target/release/bundle/macos/Froglips.app.tar.gz \
  src-tauri/target/release/bundle/macos/Froglips.app.tar.gz.sig \
  src-tauri/target/release/bundle/dmg/Froglips_${VERSION}_aarch64.dmg \
  /tmp/latest.json
```

The auto-updater queries `https://github.com/Jeritano/FrogLips/releases/latest/download/latest.json`. GitHub redirects `latest/download/<filename>` to the asset on the most-recent release — so as long as you upload `latest.json` to every release, the URL stays stable.

### Downgrade prevention (known limitation)

The Tauri updater compares `latest.json`'s `version` to the running binary's `tauri.conf.json` version with a semver-greater check, so the in-app **Agent settings → Check now** flow will refuse to install an older version. **The same protection does not exist for a manual install:** a user who downloads an older DMG from a prior release page and replaces `/Applications/Froglips.app` will end up on the older binary regardless of the auto-updater. If a release ever needs to be redacted (e.g. a security regression), the only authoritative remediation is to **delete the affected release** on GitHub — `latest.json` updates automatically because we publish a fresh one with every release, but the older DMG asset will stay reachable until the release itself is removed.

This is documented behaviour, not a bug. The minisign signature on every DMG protects against a *tampered* binary; it cannot retroactively expire a *legitimate older* binary.

The tagged `release.yml` CI workflow additionally publishes a `SHA256SUMS`
file alongside the binaries so downloads can be integrity-verified, plus a
detached minisign signature `SHA256SUMS.minisig` over that manifest (signed
with the same key used for updater bundles — see "Signing key" below).

### Verifying a downloaded release

```bash
# 1. Verify the manifest signature against the project's minisign pubkey.
#    PUBKEY is the same value embedded in tauri.conf.json under
#    plugins.updater.pubkey (base64-decoded if necessary — the
#    `minisign -P <pubkey>` form takes the raw key string).
minisign -V -P "<MINISIGN_PUBKEY>" -m SHA256SUMS

# 2. Now that SHA256SUMS itself is trusted, verify the asset hashes.
sha256sum -c SHA256SUMS
```

If step 1 fails, **do not trust** the hashes in step 2 — the manifest may
have been tampered with after the release was published.

## Signing key

Generated once with:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/froglips.key -p ""
```

- Private: `~/.tauri/froglips.key` — **DO NOT COMMIT**. Losing it means no further updates work (you'd have to rotate the public key and push a forced re-install).
- Public: embedded in `tauri.conf.json` under `plugins.updater.pubkey`.

### Key custody (bus-factor protection)

Single-developer custody is a bus-factor of 1 — lost laptop, forgotten
passphrase, or sudden absence breaks the auto-updater forever. Maintain
**three independent copies** of the private key + passphrase:

1. **Primary:** `~/.tauri/froglips.key` on the build machine (current).
2. **Cold backup:** GPG-encrypted copy on an offline encrypted USB drive
   stored in a physically separate location (home safe, bank box).
   Encrypt with `gpg --symmetric --cipher-algo AES256 froglips.key`;
   the passphrase for the GPG layer is *different* from the minisign
   passphrase and is itself stored in a password manager entry titled
   `froglips-key-gpg-passphrase` (so a single password-manager breach
   does not yield a usable signing key).
3. **Password manager:** an entry titled `froglips-minisign-private-key`
   carrying the raw private key file contents and the minisign
   passphrase, shared with a co-maintainer (when one exists). 1Password
   Secure Notes / Bitwarden attachments both work.

Verify the cold backup yearly by decrypting it on an air-gapped machine
and re-signing a known-good SHA256SUMS file; compare the signature against
the production one. Yearly verify-only, never re-import to the primary.

If the project has *no* co-maintainer yet, the password-manager copy
still protects against drive failure but does not protect against the
maintainer becoming unavailable. The bus-factor remains 1. Resolve by
adding a trusted co-maintainer with custody-only access (no commit
rights) to the password-manager entry. Document the co-maintainer in
this file (currently: **none — sole-maintainer project**).

### Key rotation playbook

The minisign pubkey is embedded in `tauri.conf.json` and is what existing
installs use to validate updater bundles **and** `SHA256SUMS.minisig`. If
you ever need to rotate (suspected compromise, lost passphrase, planned
hygiene), use a **dual-sign window** so users on the old version can still
verify and auto-update onto the new key:

1. Generate the new keypair:
   ```bash
   npx @tauri-apps/cli signer generate -w ~/.tauri/froglips-NEW.key -p ""
   ```
2. **Two consecutive releases** are signed with **both** keys:
   - Build once normally (signed with the old key, as today).
   - Re-run `minisign -S -s ~/.tauri/froglips-NEW.key -m <each .tar.gz>` and
     `... -m SHA256SUMS` to produce `*.sig.new` / `SHA256SUMS.minisig.new`.
   - Upload both `*.sig` (old) and `*.sig.new` (new) to the release.
   - `latest.json` still references the **old** signature so existing
     installs can update; new installs (which ship the new pubkey in their
     embedded `tauri.conf.json`) read the `.sig.new` files.
3. On release N (first dual-signed), update `tauri.conf.json` →
   `plugins.updater.pubkey` to the **new** pubkey. Anyone fresh-installing
   from N onward now trusts only the new key.
4. After **two** dual-signed releases have shipped, drop the old key from
   the signing pipeline. Anyone still on a pre-N version must reinstall
   manually (download the DMG, verify with the *old* `SHA256SUMS.minisig`,
   install, then auto-updates resume).
5. Securely destroy the old private key (`shred -u`, then remove the
   password-manager entry).

If the old key is **already known-compromised**, skip the dual-sign window
and force a manual reinstall instead — a single release signed with the
new key, plus a security notice in the release notes directing users to
download from GitHub manually. Auto-update cannot bridge a hostile-key
gap.

## Notarization (current)

Releases ship **Developer ID-signed, notarized, and stapled** — Gatekeeper
trusts the binary, so there is no first-launch right-click or quarantine
workaround. `scripts/release.sh` does this automatically when the signing
credentials are present.

Credentials live out-of-tree in `~/.tauri/froglips-notary.env` (mode `0600`,
**never committed**), sourced by `release.sh`:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team-id>)"
export APPLE_ID="<apple-id-email>"
export APPLE_PASSWORD="<app-specific-password>"   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="<team-id>"
```

When `APPLE_SIGNING_IDENTITY` is set, `tauri build` codesigns with that
identity and notarizes via `notarytool`; `release.sh` then staples both the
`.app` (for the updater tarball) and the `.dmg`, repairs the signature if the
DMG bundler clobbered it, smoke-tests the built app, and verifies the installed
copy reports a Notarized Developer ID before swapping it into `/Applications`.
With no signing identity present the build falls back to an ad-hoc signature for
local-only use (Gatekeeper will warn — fine for a dev machine, not for release).

CI does **not** notarize (no secrets on the runner); notarization happens on the
maintainer's machine during `npm run release`. The minisign updater signature
independently carries integrity for in-place updates.

## Troubleshooting builds

### DMG bundling fails

`hdiutil` can leave stale mounts that block new ones. Fix:

```bash
hdiutil info | awk '/^\/dev\/disk/{print $1}' | xargs -I{} hdiutil detach {} -force
```

Then retry. The `.app` and updater `.tar.gz` are generated *after* DMG, so a DMG failure prevents publishing a new updater bundle. Don't skip this step.

### Codesign warns "replacing existing signature"

That's fine — signing is idempotent; each build re-signs (Developer ID for a
release build, ad-hoc when no signing identity is configured).

### Updater says "no update available" when there clearly is

- Confirm `latest.json` was actually uploaded to the release page (it's easy to miss).
- Confirm the version in `latest.json` is *higher* than the running app's version.
- Confirm the `url` field points to a working asset (paste in browser).

### "Tampered" / "signature failure" from updater

Mismatch between the private key used at build time and the public key in `tauri.conf.json`. Most likely scenario: someone rebuilt without `TAURI_SIGNING_PRIVATE_KEY` set, producing an unsigned tarball that the app rejects. The release script handles this automatically; check that `~/.tauri/froglips.key` exists.

## Release checklist

- [ ] All three version files updated
- [ ] `CHANGELOG` entry added (if you maintain one)
- [ ] User-facing changes documented in `docs/USER_GUIDE.md`
- [ ] Engineering changes documented in `docs/ARCHITECTURE.md` or `docs/AGENT_LAYER.md`
- [ ] `npm run release` completes cleanly
- [ ] App launches and version shows correctly in `About Froglips`
- [ ] Git tag pushed
- [ ] GitHub release created with all four assets
- [ ] In-app "Check for updates" finds and installs the release from the previous version
