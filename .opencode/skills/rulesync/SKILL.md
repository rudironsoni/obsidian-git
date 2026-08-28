---
name: rulesync
description: >-
  Generates and syncs AI rule configuration files across coding tools from
  `.rulesync/`. Use when syncing AI rules, or when tempted to edit AGENTS.md,
  CLAUDE.md, or other generated agent files.
---
# Rulesync in this repository

`.rulesync/` is the only authored source for the agent harness. CI runs
`pnpm run rulesync:generate` and is the only writer of generated files.

## Do

-   Add or edit rules, skills, commands, subagents, hooks, and permissions under `.rulesync/`.
-   Change `rulesync.jsonc` or `rulesync.lock` when targets or remote skill sources change.
-   Leave generated files for the Rulesync GitHub workflow to update.

## Do not

-   Hand-edit `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, or generated trees under `.cursor/` (except `.cursor/environment.json`), `.claude/`, `.codex/`, `.agent/`, `.agents/`, `.copilot/`, `.opencode/`, `.grok/`, `.vscode/`.
-   Run `rulesync gitignore` in a way that ignores `AGENTS.md`; generated files stay tracked.
-   Overwrite `.cursor/environment.json` or `scripts/cursor-cloud-install.sh`.

Local check (does not commit):

```bash
pnpm run rulesync:check
```
