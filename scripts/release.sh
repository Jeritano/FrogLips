#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
echo "▶ Building Froglips v${VERSION}…"

# Kill any running instance so DMG bundling + app bundle replace work.
# NOTE: matches Contents/MacOS specifically — avoids killing bundle_dmg.sh,
# which has "Froglips.app" in its argv and was getting clobbered before.
pkill -f "Froglips.app/Contents/MacOS" 2>/dev/null || true
sleep 1

# Detach any stale hdiutil mounts — they break DMG bundling.
hdiutil info 2>/dev/null | awk '/^\/dev\/disk/{print $1}' | \
  xargs -I{} hdiutil detach {} -force >/dev/null 2>&1 || true

# Updater signing key path (out-of-tree). Skip signing if absent.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$HOME/.tauri/froglips.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/froglips.key"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
fi

# Try the build up to 2 times if DMG bundling flakes out
# Native inference enabled by default; set FROGLIPS_SKIP_NATIVE=1 to skip the
# heavy mistralrs+candle+Metal compile (faster builds when you only need
# Ollama / MLX paths).
#
# Phase 2 split the umbrella `native-inference` feature into per-backend
# flags. On macos-aarch64 we still ship mistralrs; the cross-platform
# llama.cpp backend (`native-llamacpp`) lives behind its own feature.
build_attempt() {
  if [[ "${FROGLIPS_SKIP_NATIVE:-}" == "1" ]]; then
    npm run tauri build
  else
    npm run tauri build -- --features native-mistralrs
  fi
}

if ! build_attempt; then
  echo "▶ First build attempt failed, cleaning state + retrying…"
  hdiutil info 2>/dev/null | awk '/^\/dev\/disk/{print $1}' | \
    xargs -I{} hdiutil detach {} -force >/dev/null 2>&1 || true
  rm -f src-tauri/target/release/bundle/dmg/rw.*.dmg 2>/dev/null || true
  sleep 2
  if ! build_attempt; then
    echo "▶ Second attempt also failed."
    if [[ -d src-tauri/target/release/bundle/macos/Froglips.app ]]; then
      echo "  → .app was produced; continuing with install + skipping DMG."
    else
      echo "  → no .app produced; aborting." >&2
      exit 1
    fi
  fi
fi

set -e

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
