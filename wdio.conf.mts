import * as path from "node:path";
import { env } from "node:process";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { ensureE2eVaultGitRepo, E2E_VAULT_DIR } from "./e2e/prepareVault";

const cacheDir = path.resolve(".obsidian-cache");
const vault = path.relative(process.cwd(), E2E_VAULT_DIR);

const desktopVersions = await parseObsidianVersions(
    env.OBSIDIAN_VERSIONS ?? "latest/latest",
    { cacheDir }
);

if (env.CI) {
    console.log("obsidian-cache-key:", JSON.stringify(desktopVersions));
}

export const config: WebdriverIO.Config = {
    runner: "local",
    framework: "mocha",
    specs: ["./e2e/specs/**/*.e2e.ts"],
    maxInstances: Number(env.WDIO_MAX_INSTANCES || 1),
    capabilities: desktopVersions.map(([appVersion, installerVersion]) => ({
        browserName: "obsidian",
        "wdio:obsidianOptions": {
            appVersion,
            installerVersion,
            plugins: ["."],
            vault,
        },
    })),
    services: ["obsidian"],
    reporters: ["obsidian"],
    mochaOpts: {
        ui: "bdd",
        timeout: 120 * 1000,
    },
    waitforInterval: 250,
    waitforTimeout: 15 * 1000,
    logLevel: "warn",
    cacheDir,
    injectGlobals: false,
    async onPrepare() {
        ensureE2eVaultGitRepo();
    },
};
