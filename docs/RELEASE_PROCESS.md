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

Back the private key up to a password manager.

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

## Troubleshooting builds

### DMG bundling fails

`hdiutil` can leave stale mounts that block new ones. Fix:

```bash
hdiutil info | awk '/^\/dev\/disk/{print $1}' | xargs -I{} hdiutil detach {} -force
```

Then retry. The `.app` and updater `.tar.gz` are generated *after* DMG, so a DMG failure prevents publishing a new updater bundle. Don't skip this step.

### Codesign warns "replacing existing signature"

That's fine — ad-hoc signing is idempotent. Each build re-signs.

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
