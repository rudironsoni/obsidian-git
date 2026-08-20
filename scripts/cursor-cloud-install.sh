#!/usr/bin/env bash
# Cloud Agent install script for the obsidian-git environment.
#
# Activates the toolchain required by package.json (Node >=24, pnpm >=11) and
# installs dependencies from the frozen lockfile. Kept idempotent and safe to
# re-run against cached state.
set -euo pipefail

# --- Toolchain: Node 24 (package.json engines requires >=24) + pnpm 11 (>=11) ---
# The Cloud Agent base image ships an older default Node on PATH, so we install
# and activate Node 24 through nvm and prepend it to PATH for this process. The
# default alias is pointed at 24 so interactive `nvm use`/login shells prefer it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    mkdir -p "$NVM_DIR"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
nvm use 24
export PATH="$NVM_BIN:$PATH"
corepack enable
corepack prepare pnpm@11.2.0 --activate

echo "Using node $(node -v), npm $(npm -v), pnpm $(pnpm -v)"

# --- Install obsidian-git dependencies (pnpm, frozen lockfile) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

echo "Installing obsidian-git dependencies (pnpm)..."
pnpm install --frozen-lockfile

echo "Cloud Agent install complete."
