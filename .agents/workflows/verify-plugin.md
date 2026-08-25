---
description: Run the local obsidian-git quality gate
trigger: /verify-plugin
turbo: true
---
# Workflow: /verify-plugin

Run the repository quality gate for `obsidian-git`.

## Phase 1: Local gate

```bash
pnpm run all
```

This runs `tsc`, Svelte check, Prettier, ESLint, and Vitest. Judge as failed
if any step fails.

## Phase 2: Focused tests (when the change is narrow)

Run the Vitest files that cover the touched modules, for example:

```bash
pnpm exec vitest run tests/gitManager/wasmGit
```

## Phase 3: Build (when bundling or release artifacts changed)

```bash
pnpm run build
```

Confirm `main.js` is produced. Do not commit `main.js`.

## Phase 4: Report

```
## Verify plugin

- pnpm run all: <pass/fail>
- focused tests: <pass/fail/skipped>
- pnpm run build: <pass/fail/skipped>

Verdict: <ship / hold>
```

// turbo
