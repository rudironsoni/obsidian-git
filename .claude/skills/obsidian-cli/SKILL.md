---
name: obsidian-cli
description: >-
  Interactive Obsidian CLI loop for local plugin development. Use when a
  developer has desktop Obsidian running and wants to reload obsidian-git,
  capture errors, eval JS, screenshot, or inspect the DOM. Not a CI quality
  gate. Requires the official Obsidian CLI.
---
# Obsidian CLI (local interactive)

Use this for a developer's machine with Obsidian already open. Do not treat
CLI success as CI proof. The quality gates are Vitest (`pnpm run test`) and
WDIO (`pnpm run test:e2e`).

Official docs: https://help.obsidian.md/cli

Skill source: [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)
(`obsidian-cli`).

## macOS command name

On macOS, invoke `obsidian-cli`, not `obsidian`. Calling `obsidian` relaunches
the app and drops the existing CLI session.

On Linux and Windows, `obsidian` is the CLI when the official CLI is installed.

```bash
obsidian-cli help
# or, off macOS:
obsidian help
```

## Plugin develop/test cycle

Plugin id is `obsidian-git`.

1. Rebuild: `pnpm run build` or `pnpm run dev`.
2. Reload:

    ```bash
    obsidian-cli plugin:reload id=obsidian-git
    ```

3. Check errors:

    ```bash
    obsidian-cli dev:errors
    ```

4. Verify:

    ```bash
    obsidian-cli eval code="app.plugins.enabledPlugins.has('obsidian-git')"
    obsidian-cli dev:screenshot path=screenshot.png
    obsidian-cli dev:dom selector='.git-view' text
    obsidian-cli dev:console level=error
    ```

Other useful commands:

```bash
obsidian-cli eval code="app.commands.executeCommandById('obsidian-git:open-git-view')"
obsidian-cli dev:css selector=".git-view" prop=display
obsidian-cli dev:mobile on
```

## Optional local MCP (not in this repo)

Do not add vault-note MCP servers to `.rulesync/mcp.jsonc`. The repo MCP is
`@wdio/mcp` for live WDIO sessions.

If you want CLI tools inside Cursor on a developer machine, add a **local**
`.cursor/mcp.json` entry pointing at
[GoldSucc/obsidian-cli-mcp](https://github.com/GoldSucc/obsidian-cli-mcp) (or
run the CLI directly). That server needs a running desktop Obsidian and a
vault path. Do not commit that config; it is machine-specific.

## Cloud and CI

Cursor Cloud and GitHub Actions do not have a focused Obsidian desktop vault.
Skip this skill there. Use Vitest in Cloud; use WDIO + xvfb in CI.
