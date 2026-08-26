---
targets:
    - "*"
description: "Run the local obsidian-git quality gate and WDIO smoke when possible"
---

Run the repository quality gate for `obsidian-git`. Follow the `plugin-test`
skill. Skip WDIO in Cursor Cloud. Skip Obsidian CLI unless a desktop app is
already running.

## Layer 1: Vitest gate

```bash
pnpm run all
```

This runs `tsc`, Svelte check, Prettier, ESLint, and Vitest. Judge as failed
if any step fails.

When the change is narrow, also run the matching Vitest files:

```bash
pnpm exec vitest run tests/gitManager/wasmGit
```

## Layer 2: WDIO (desktop / CI)

```bash
pnpm run build
pnpm run test:e2e
```

Skip this layer when there is no display (Cursor Cloud). Do not claim UI
fixes from Layer 1 alone.

## Layer 3: Build artifact (when bundling changed)

If Layer 2 already ran `pnpm run build`, reuse that. Otherwise:

```bash
pnpm run build
```

Confirm `main.js` is produced. Do not commit `main.js`.

## Layer 4: Optional local CLI

Only with a running Obsidian vault. See the `obsidian-cli` skill.

## Report

```
## Verify plugin

- pnpm run all: <pass/fail>
- focused tests: <pass/fail/skipped>
- pnpm run test:e2e: <pass/fail/skipped>
- pnpm run build: <pass/fail/skipped>
- obsidian-cli: <pass/fail/skipped>

Verdict: <ship / hold>
```
