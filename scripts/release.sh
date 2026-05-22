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

# ── Smoke test ───────────────────────────────────────────────────────────
# Launch the freshly built .app, give it a moment to come up, then assert it
# is still alive and produced no new crash.log entry. A failed smoke test
# aborts the release — we never install a build that crashes on launch.
BUILT_APP="src-tauri/target/release/bundle/macos/Froglips.app"
CRASH_LOG="$HOME/.local-llm-app/crash.log"

if [[ -d "$BUILT_APP" ]]; then
  echo "▶ Smoke testing built app…"
  crash_before=0
  [[ -f "$CRASH_LOG" ]] && crash_before=$(wc -c < "$CRASH_LOG" | tr -d ' ')

  # ad-hoc sign so Gatekeeper lets the unsigned build run for the probe.
  codesign --sign - --deep --force --timestamp=none "$BUILT_APP" >/dev/null 2>&1 || true

  smoke_bin="$BUILT_APP/Contents/MacOS/Froglips"
  "$smoke_bin" >/dev/null 2>&1 &
  smoke_pid=$!
  sleep 6

  smoke_ok=1
  if ! kill -0 "$smoke_pid" 2>/dev/null; then
    echo "  ✗ app process exited within 6s of launch" >&2
    smoke_ok=0
  fi

  crash_after=0
  [[ -f "$CRASH_LOG" ]] && crash_after=$(wc -c < "$CRASH_LOG" | tr -d ' ')
  if [[ "$crash_after" -gt "$crash_before" ]]; then
    echo "  ✗ new crash.log entry appeared during smoke test" >&2
    smoke_ok=0
  fi

  # Quit the probe instance regardless of outcome.
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  pkill -f "Froglips.app/Contents/MacOS" 2>/dev/null || true

  if [[ "$smoke_ok" -ne 1 ]]; then
    echo "▶ Smoke test FAILED — refusing to install a broken build." >&2
    exit 1
  fi
  echo "✓ Smoke test passed"
fi

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
