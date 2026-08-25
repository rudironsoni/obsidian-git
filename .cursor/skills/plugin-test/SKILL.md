---
name: plugin-test
description: Acceptance test workflow for the obsidian-git plugin. Use when the user asks to test the plugin, smoke a change, or judge whether WasmGit, UI, or editor behavior still works. Uses pnpm quality gates and Vitest. Does not spend API tokens and does not commit source changes.
---
# obsidian-git acceptance test

Use this skill for verification of `obsidian-git`. Prefer focused Vitest files,
then `pnpm run all`.

## Guardrails

-   Do not modify source code or commit while executing this skill.
-   There is no WDIO or real-Obsidian GUI harness. If a check requires a live
    vault, say it was skipped.
-   Do not reintroduce a native Git binary dependency.

## Pass 1: Local gate

```bash
pnpm run all
```

Judge Pass 1 as failed if typecheck, Svelte check, Prettier, ESLint, or Vitest
fails.

## Pass 2: Focused coverage

When the change is narrow, also run the matching tests, for example:

```bash
pnpm exec vitest run tests/gitManager/wasmGit
```

## Pass 3: Build (if artifacts changed)

```bash
pnpm run build
```

## Recommendation

ship / hold, with reason.
