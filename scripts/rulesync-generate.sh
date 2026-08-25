#!/usr/bin/env bash
# Generate or check Rulesync outputs without deleting Cursor Cloud config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".cursor/environment.json"
ENV_BACKUP="$(mktemp)"
REFERENCE_SKILL=".rulesync/skills/.curated/reference/SKILL.md"

ensure_reference_skill() {
    if [[ -d ".rulesync/skills/.curated/reference" && ! -f "$REFERENCE_SKILL" ]]; then
        cat >"$REFERENCE_SKILL" <<'EOF'
---
name: obsidian-plugin-dev-reference
description: >-
    Obsidian plugin development reference notes covering lifecycle, vault
    operations, editor extensions, settings, testing, security, and CI.
targets:
    - "*"
---

# Obsidian plugin development reference

Use these notes with the project overview in `.rulesync/rules/overview.md`.

-   [lifecycle.md](lifecycle.md)
-   [vault-operations.md](vault-operations.md)
-   [editor-extensions.md](editor-extensions.md)
-   [settings-migration.md](settings-migration.md)
-   [testing.md](testing.md)
-   [security.md](security.md)
-   [dev-workflow.md](dev-workflow.md)
-   [cicd-release.md](cicd-release.md)
-   [frameworks.md](frameworks.md)
-   [eslint-rules.md](eslint-rules.md)
-   [accessibility.md](accessibility.md)
-   [css-accessibility.md](css-accessibility.md)
EOF
    fi
}

ensure_reference_skill


ENV_FILE=".cursor/environment.json"
ENV_BACKUP="$(mktemp)"

if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$ENV_BACKUP"
fi

cleanup() {
    if [[ -f "$ENV_BACKUP" ]]; then
        mkdir -p .cursor
        cp "$ENV_BACKUP" "$ENV_FILE"
        rm -f "$ENV_BACKUP"
    fi
}
trap cleanup EXIT

if [[ "${1:-}" == "--check" ]]; then
    ./node_modules/.bin/rulesync generate --check
else
    ./node_modules/.bin/rulesync generate
fi
