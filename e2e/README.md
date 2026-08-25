# End-to-end tests

WebdriverIO + [wdio-obsidian-service](https://github.com/jesse-r-s-hines/wdio-obsidian-service)
loads a sandboxed Obsidian with this plugin.

```bash
pnpm run build
pnpm run test:e2e
```

`onPrepare` git-inits `vaults/simple` so WasmGit sees a valid repository.
Do not commit that `.git` directory.

Cursor Cloud has no display: skip these specs and use Vitest. GitHub Actions
runs them under xvfb.
