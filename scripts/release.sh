#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
echo "▶ Building Froglips v${VERSION}…"

# Kill any running instance so DMG bundling + app bundle replace work
pkill -f "Froglips.app" 2>/dev/null || true
sleep 1

# Updater signing key path (out-of-tree). Skip signing if absent.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$HOME/.tauri/froglips.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/froglips.key"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
fi

npm run tauri build

# Install fresh copy
rm -rf /Applications/Froglips.app
cp -R src-tauri/target/release/bundle/macos/Froglips.app /Applications/

# Strip Gatekeeper quarantine + ad-hoc codesign (per-machine trust)
xattr -dr com.apple.quarantine /Applications/Froglips.app || true
codesign --sign - --deep --force --timestamp=none /Applications/Froglips.app

echo "✓ Installed v${VERSION} at /Applications/Froglips.app"

# Refresh Desktop alias
ln -sf /Applications/Froglips.app "$HOME/Desktop/Froglips"

echo "✓ Desktop alias refreshed"
