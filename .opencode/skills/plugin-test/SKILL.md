---
name: plugin-test
description: >-
  Acceptance test workflow for the obsidian-git plugin. Use when the user asks
  to test the plugin, smoke a change, or judge whether WasmGit, UI, or editor
  behavior still works. Layers: Vitest, WDIO in Obsidian, optional local CLI.
  Does not spend API tokens and does not commit source changes.
metadata:
  author: obsidian-git
  version: '1.0'
---
# obsidian-git acceptance test

Use this skill to verify `obsidian-git`. Do not claim a user-visible Obsidian
UI or WasmGit-in-app bug is fixed from Vitest alone.

## Guardrails

-   Do not modify source code or commit while executing this skill.
-   Do not reintroduce a native Git binary dependency in the plugin.
-   Do not add vault-note MCP servers.

## Environments

-   **Cursor Cloud**: Layer 1 only (no display / no sandboxed Obsidian).
-   **Desktop / GitHub Actions**: Layers 1 and 2. Layer 2 needs xvfb on Linux.
-   **Developer machine with Obsidian open**: Layer 3 is optional.

## Layer 1: Vitest quality gate

Focused tests, then the full local gate:

```bash
pnpm exec vitest run tests/gitManager/wasmGit
pnpm run all
```

`pnpm run all` is tsc, Svelte check, Prettier, ESLint, and Vitest. It does
**not** launch Obsidian.

Judge Layer 1 as failed if typecheck, Svelte check, Prettier, ESLint, or
Vitest fails.

## Layer 2: WDIO in a sandboxed Obsidian

Requires `main.js` from `pnpm run build`. Specs live in `e2e/specs/` and load
the plugin into a git-initialized vault.

```bash
pnpm run build
pnpm run test:e2e
```

First smoke: plugin loads, Source Control opens, a changed file appears.

Linux CI uses xvfb (see `.github/workflows/test.yml`). Skip Layer 2 in Cursor
Cloud and report it skipped.

Optional agent debugger for a live WDIO session (`@wdio/mcp`, generated from
`.rulesync/mcp.jsonc`):

```bash
pnpm run wdio:mcp
```

## Layer 3: Obsidian CLI (local only)

Only when desktop Obsidian is already running. See the `obsidian-cli` skill.
On macOS use `obsidian-cli`, not `obsidian`.

## Recommendation

ship / hold, with reason. Name which layers ran and which were skipped.
