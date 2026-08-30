#!/usr/bin/env bash
# Copy this fork's plugin artifacts into tests/test-vault.
# iOS cannot follow a symlink to repo-root main.js.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/tests/test-vault/.obsidian/plugins/obsidian-git"

if [[ ! -f "$ROOT/main.js" ]]; then
    echo "main.js is missing. Run pnpm run dev or pnpm run build first." >&2
    exit 1
fi

mkdir -p "$DEST"
cp "$ROOT/manifest.json" "$ROOT/styles.css" "$DEST/"
cp "$ROOT/main.js" "$DEST/"
echo "Copied plugin files to $DEST"
