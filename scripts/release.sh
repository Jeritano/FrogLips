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

# ── Developer ID signing + notarization (DISTRIBUTION builds) ───────────────
# This script ad-hoc signs for LOCAL install (bottom of file). To ship a build
# strangers can open WITHOUT the Gatekeeper "damaged/unverified" warning, the
# Tauri bundler signs + notarizes + staples AUTOMATICALLY when these env vars
# are exported before this script runs — no extra code needed here. Requires an
# Apple Developer account ($99/yr) + a "Developer ID Application" cert.
#
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: NAME (TEAMID)"
#   # cert as base64 .p12 + its password (or rely on the login keychain):
#   export APPLE_CERTIFICATE="$(base64 -i DeveloperID.p12)"
#   export APPLE_CERTIFICATE_PASSWORD="<p12-password>"
#   # notarization creds — EITHER an app-specific password…
#   export APPLE_ID="you@apple.id"; export APPLE_PASSWORD="<app-specific-pw>"
#   export APPLE_TEAM_ID="TEAMID"
#   # …OR an App Store Connect API key:
#   # export APPLE_API_ISSUER=…; export APPLE_API_KEY=…; export APPLE_API_KEY_PATH=AuthKey_*.p8
#
# With those set, `tauri build` (invoked below) produces a signed, notarized,
# stapled .app + .dmg. Verify after: `spctl -a -vvv /Applications/Froglips.app`
# should report "accepted / Notarized Developer ID". The ad-hoc codesign at the
# bottom is then redundant but harmless for the local copy.
# Auto-source local notarization creds when present (developer machine).
# The file lives OUTSIDE the repo (~/.tauri, chmod 600) and is never
# committed; CI provides the same vars via GitHub Actions secrets instead.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" && -f "$HOME/.tauri/froglips-notary.env" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.tauri/froglips-notary.env"
fi
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "▶ Developer ID signing identity set — tauri build will notarize."
else
  echo "▶ No APPLE_SIGNING_IDENTITY — local ad-hoc build (not notarized)."
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

# ── Notarization verify + self-heal ─────────────────────────────────────────
# Observed 2026-06-09 (first notarized build): the Tauri bundler notarized and
# stapled the .app, then a later bundling step RE-SIGNED it AD-HOC — stripping
# the Developer ID signature, hardened runtime, and ticket binding. Gatekeeper
# then rejected the "notarized" build. This block detects that clobber, repairs
# it (proper re-sign → re-notarize → re-staple → rebuild DMG + updater tarball
# from the repaired app), and HARD-GATES the release on a Gatekeeper accept.
NOTARIZE_APP="src-tauri/target/release/bundle/macos/Froglips.app"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" && -d "$NOTARIZE_APP" ]]; then
  sig_ok=1
  codesign -dvv "$NOTARIZE_APP" 2>&1 | grep -q "Authority=Developer ID Application" || sig_ok=0
  xcrun stapler validate "$NOTARIZE_APP" >/dev/null 2>&1 || sig_ok=0
  if [[ "$sig_ok" -ne 1 ]]; then
    echo "▶ Bundler clobbered the Developer ID signature — repairing…"
    codesign --force --options runtime --timestamp \
      --entitlements src-tauri/Entitlements.plist \
      --sign "$APPLE_SIGNING_IDENTITY" "$NOTARIZE_APP"
    rm -f /tmp/froglips-notarize.zip
    ditto -c -k --keepParent "$NOTARIZE_APP" /tmp/froglips-notarize.zip
    xcrun notarytool submit /tmp/froglips-notarize.zip \
      --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$NOTARIZE_APP"

    # Rebuild distribution artifacts from the repaired app so the DMG and the
    # updater tarball carry the SAME (notarized) binary.
    REPAIR_DMG="src-tauri/target/release/bundle/dmg/Froglips_${VERSION}_aarch64.dmg"
    rm -f "$REPAIR_DMG"
    hdiutil create -volname "Froglips" -srcfolder "$NOTARIZE_APP" -ov -format UDZO "$REPAIR_DMG" >/dev/null
    codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$REPAIR_DMG"
    xcrun notarytool submit "$REPAIR_DMG" \
      --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$REPAIR_DMG"

    REPAIR_TAR="src-tauri/target/release/bundle/macos/Froglips.app.tar.gz"
    rm -f "$REPAIR_TAR" "$REPAIR_TAR.sig"
    tar -czf "$REPAIR_TAR" -C src-tauri/target/release/bundle/macos Froglips.app
    if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
      # The signer CLI treats TAURI_SIGNING_PRIVATE_KEY env as --private-key
      # (key CONTENT) and refuses to combine it with --private-key-path; our
      # env var holds a PATH, so clear both vars for this one call and pass
      # the path explicitly.
      env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
        npx @tauri-apps/cli signer sign \
        --private-key-path "$TAURI_SIGNING_PRIVATE_KEY" \
        --password "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "$REPAIR_TAR"
    fi
  fi
  # Hard gate: never ship a build Gatekeeper rejects.
  if ! spctl -a -vv "$NOTARIZE_APP" 2>&1 | grep -q "Notarized Developer ID"; then
    echo "✗ Gatekeeper does not accept the build as Notarized Developer ID — aborting." >&2
    exit 1
  fi
  echo "✓ Notarization verified (Notarized Developer ID, stapled)"
fi

# ── Smoke test ───────────────────────────────────────────────────────────
# Launch the freshly built .app, give it a moment to come up, then assert it
# is still alive and produced no new crash.log entry. A failed smoke test
# aborts the release — we never install a build that crashes on launch.
BUILT_APP="src-tauri/target/release/bundle/macos/Froglips.app"
LOG_DIR="$HOME/.local-llm-app"
CRASH_LOG="$LOG_DIR/crash.log"
# tracing-appender rotates daily as app.YYYY-MM-DD.log; the "Froglips backend
# starting" line is emitted from lib.rs once the Tauri builder has set up its
# windows and event loop, so its presence is a strong "the binary actually
# came up" signal — much stronger than just `kill -0`.
READY_MARKER="Froglips backend starting"

if [[ -d "$BUILT_APP" ]]; then
  echo "▶ Smoke testing built app…"
  crash_before=0
  [[ -f "$CRASH_LOG" ]] && crash_before=$(wc -c < "$CRASH_LOG" | tr -d ' ')

  # Snapshot the current log size for every existing app.*.log so we only
  # treat *new* output as smoke-test evidence (the log file persists across
  # runs). Use a tempdir of per-log size files instead of an associative
  # array — macOS ships bash 3.2 which has no `declare -A`.
  SNAP_DIR=$(mktemp -d -t froglips-smoke.XXXXXX)
  trap 'rm -rf "$SNAP_DIR"' EXIT
  shopt -s nullglob
  for lf in "$LOG_DIR"/app.*.log; do
    sz=$(wc -c < "$lf" 2>/dev/null | tr -d ' ')
    echo "${sz:-0}" > "$SNAP_DIR/$(basename "$lf")"
  done
  shopt -u nullglob

  # ad-hoc sign so Gatekeeper lets the unsigned build run for the probe.
  codesign --sign - --deep --force --timestamp=none "$BUILT_APP" >/dev/null 2>&1 || true

  # The executable inside the bundle is the Cargo bin name (local-llm-app),
  # not "Froglips" — read CFBundleExecutable so a rename can't break this.
  smoke_exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \
    "$BUILT_APP/Contents/Info.plist" 2>/dev/null \
    || ls "$BUILT_APP/Contents/MacOS" | head -1)
  smoke_bin="$BUILT_APP/Contents/MacOS/$smoke_exe"
  "$smoke_bin" >/dev/null 2>&1 &
  smoke_pid=$!

  # Two-probe smoke test, polling for up to 20s:
  #   (a) process is alive  (b) we saw the "ready" marker in app.*.log
  # We pass only if at least one is true at the end (and the process must
  # have stayed alive long enough to be observed — instant exit still fails).
  proc_alive=0
  saw_ready=0
  deadline=$(( $(date +%s) + 20 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if kill -0 "$smoke_pid" 2>/dev/null; then
      proc_alive=1
    fi

    shopt -s nullglob
    for lf in "$LOG_DIR"/app.*.log; do
      snap_file="$SNAP_DIR/$(basename "$lf")"
      start_off=0
      [[ -f "$snap_file" ]] && start_off=$(cat "$snap_file" 2>/dev/null || echo 0)
      cur_size=$(wc -c < "$lf" 2>/dev/null | tr -d ' ' || echo 0)
      if [[ "$cur_size" -gt "$start_off" ]]; then
        # tail just the new bytes since launch and look for the marker
        if tail -c +$((start_off + 1)) "$lf" 2>/dev/null | grep -q "$READY_MARKER"; then
          saw_ready=1
        fi
      fi
    done
    shopt -u nullglob

    if [[ "$proc_alive" -eq 1 && "$saw_ready" -eq 1 ]]; then
      break
    fi
    sleep 1
  done

  # Final alive check (process may have died after we saw it).
  final_alive=0
  kill -0 "$smoke_pid" 2>/dev/null && final_alive=1

  smoke_ok=0
  if [[ "$final_alive" -eq 1 || "$saw_ready" -eq 1 ]]; then
    smoke_ok=1
  fi

  if [[ "$smoke_ok" -ne 1 ]]; then
    echo "  ✗ process did not stay alive and no '$READY_MARKER' line appeared in $LOG_DIR/app.*.log within 20s" >&2
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
  echo "✓ Smoke test passed (proc_alive=$final_alive, ready_marker=$saw_ready)"
fi

# Install fresh copy
rm -rf /Applications/Froglips.app
cp -R src-tauri/target/release/bundle/macos/Froglips.app /Applications/

# Per-machine trust for UNSIGNED builds only. When a Developer ID identity
# was used, the bundle already carries a notarized signature — the old
# unconditional `codesign --sign - --force` here REPLACED it with an ad-hoc
# one, silently unsigning the installed copy.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  xattr -dr com.apple.quarantine /Applications/Froglips.app || true
  codesign --sign - --deep --force --timestamp=none /Applications/Froglips.app
fi

echo "✓ Installed v${VERSION} at /Applications/Froglips.app"

# Refresh Desktop alias
ln -sf /Applications/Froglips.app "$HOME/Desktop/Froglips"

echo "✓ Desktop alias refreshed"
