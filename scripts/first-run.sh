#!/usr/bin/env bash
# Froglips first-run helper.
# Checks for required dependencies and offers to install them.
# Safe to re-run.

set -uo pipefail

GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

ok()    { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$1"; }
note()  { printf "  %s\n" "$1"; }

echo "Froglips first-run check"
echo "========================"

# 1. macOS + Apple Silicon
if [[ "$(uname)" != "Darwin" ]]; then
  fail "Froglips is macOS only."
  exit 1
fi
ARCH=$(uname -m)
if [[ "$ARCH" != "arm64" ]]; then
  warn "Detected ${ARCH}. Froglips builds target Apple Silicon (arm64). Intel Macs are unsupported."
else
  ok  "Apple Silicon detected."
fi

# 2. Gatekeeper quarantine
APP="/Applications/Froglips.app"
if [[ -d "$APP" ]]; then
  if xattr -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
    warn "Gatekeeper quarantine is set on /Applications/Froglips.app — first launch will show a warning."
    read -r -p "  Strip quarantine now? [Y/n] " ans
    if [[ ! "$ans" =~ ^[Nn] ]]; then
      xattr -dr com.apple.quarantine "$APP" && ok "Quarantine stripped."
    fi
  else
    ok "App not quarantined."
  fi
else
  warn "/Applications/Froglips.app not found. Drag the .app into /Applications first."
fi

# 3. Ollama (recommended backend)
if command -v ollama >/dev/null 2>&1; then
  ok  "Ollama installed: $(ollama --version 2>&1 | head -1)"
  if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    warn "Ollama is not running. Start it from the menu bar or run: ollama serve"
  else
    ok "Ollama is running."
  fi
else
  warn "Ollama not found."
  note "Ollama is the easiest backend — supports local + cloud models."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "  Install Ollama via Homebrew now? [Y/n] " ans
    if [[ ! "$ans" =~ ^[Nn] ]]; then
      brew install --cask ollama && ok "Ollama installed."
      note "Launch Ollama from /Applications, then re-run this script."
    fi
  else
    note "Install: https://ollama.com/download   (or install Homebrew first)"
  fi
fi

# 4. MLX backend (optional)
MLX_BIN="$HOME/.venvs/mlx/bin/mlx_lm.server"
if [[ -x "$MLX_BIN" ]]; then
  ok "MLX backend installed at ~/.venvs/mlx"
else
  warn "MLX backend not found (optional)."
  note "MLX gives lower latency for local models on Apple Silicon. Install with:"
  note "  python3 -m venv ~/.venvs/mlx && ~/.venvs/mlx/bin/pip install mlx-lm"
fi

# 5. HuggingFace CLI for MLX downloads (optional)
if command -v huggingface-cli >/dev/null 2>&1; then
  ok "huggingface-cli available"
elif [[ -x "$HOME/.venvs/mlx/bin/huggingface-cli" ]]; then
  ok "huggingface-cli available in mlx venv"
else
  note "huggingface-cli is optional — Froglips can use the in-app browser instead."
fi

echo
echo "Setup check complete."
echo
echo "Next steps:"
echo "  1. Open /Applications/Froglips.app"
echo "  2. Click 'Browse & download models…' in the dropdown"
echo "  3. Pick something small (llama3.2:3b or qwen3:4b) and click Pull"
echo
