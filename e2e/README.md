# End-to-end tests

WebdriverIO + [wdio-obsidian-service](https://github.com/jesse-r-s-hines/wdio-obsidian-service)
loads a sandboxed Obsidian with this plugin.

```bash
pnpm run build
pnpm run test:e2e
```

`onPrepare` git-inits `tests/test-vault` so WasmGit sees a valid repository.
Do not commit that `.git` directory.

The same vault is the iOS inspect fixture. After `pnpm run dev` or
`pnpm run build`, copy plugin files with `pnpm run sync:test-vault`.

Cursor Cloud has no display: skip these specs and use Vitest. GitHub Actions
runs them under xvfb.
