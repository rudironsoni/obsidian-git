#!/usr/bin/env bash
# Cloud Agent install script for the obsidian-git environment.
#
# Sets up the toolchain and installs dependencies for the primary repo
# (obsidian-git, pnpm) and its additional repository dependency
# (influx, npm). Kept idempotent and safe to re-run: it can run again on
# cached state and tolerates the influx repo not being checked out yet.
set -euo pipefail

# --- Toolchain: Node 24 (package.json engines requires >=24) + pnpm 11 (>=11) ---
# The Cloud Agent base image ships a different default Node on PATH, so we
# activate Node 24 through nvm and prepend it to PATH for this process.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    mkdir -p "$NVM_DIR"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
export PATH="$NVM_BIN:$PATH"
corepack enable
corepack prepare pnpm@11.2.0 --activate

echo "Using node $(node -v), npm $(npm -v), pnpm $(pnpm -v)"

# --- Resolve repo locations relative to this script ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OBSIDIAN_GIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$OBSIDIAN_GIT_DIR/.." && pwd)"

# --- Primary repo: obsidian-git (pnpm) ---
echo "Installing obsidian-git dependencies (pnpm)..."
cd "$OBSIDIAN_GIT_DIR"
pnpm install --frozen-lockfile

# --- Additional repo: influx (npm), declared via repositoryDependencies ---
# Cursor clones repositoryDependencies alongside the primary repo; the exact
# root can vary by checkout layout, so search a few likely locations.
INFLUX_DIR=""
for candidate in \
    "${INFLUX_DIR_OVERRIDE:-}" \
    "$WORKSPACE_ROOT/influx" \
    "$OBSIDIAN_GIT_DIR/../influx" \
    "/workspace/influx" \
    "$HOME/influx"; do
    if [ -n "$candidate" ] && [ -f "$candidate/package.json" ]; then
        INFLUX_DIR="$(cd "$candidate" && pwd)"
        break
    fi
done

if [ -n "$INFLUX_DIR" ]; then
    echo "Installing influx dependencies (npm) at $INFLUX_DIR..."
    cd "$INFLUX_DIR"
    npm ci
else
    echo "influx not found near the workspace; skipping (repositoryDependencies not checked out yet)."
fi

echo "Cloud Agent install complete."
