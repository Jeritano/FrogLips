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
3. Runs `npm run tauri build -- --features native-inference` (set `FROGLIPS_SKIP_NATIVE=1` to build a lean ~14 MB binary without mistralrs / candle / Metal kernels — useful for fast iteration when you only need Ollama / MLX)
4. Replaces `/Applications/Froglips.app`
5. Strips Gatekeeper quarantine
6. Ad-hoc codesigns (`codesign --sign - --deep --force`)
7. Refreshes the `~/Desktop/Froglips` alias

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

## Signing key

Generated once with:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/froglips.key -p ""
```

- Private: `~/.tauri/froglips.key` — **DO NOT COMMIT**. Losing it means no further updates work (you'd have to rotate the public key and push a forced re-install).
- Public: embedded in `tauri.conf.json` under `plugins.updater.pubkey`.

Back the private key up to a password manager.

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
