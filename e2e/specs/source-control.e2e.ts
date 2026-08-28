import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const PLUGIN_ID = "obsidian-git";
const OPEN_SOURCE_CONTROL = "obsidian-git:open-git-view";

async function waitForGitReady() {
    await browser.waitUntil(
        async () => {
            return await browser.executeObsidian(({ app }, pluginId) => {
                const plugin = (
                    app as {
                        plugins: {
                            plugins: Record<string, { gitReady?: boolean }>;
                        };
                    }
                ).plugins.plugins[pluginId];
                return plugin?.gitReady === true;
            }, PLUGIN_ID);
        },
        {
            timeout: 60_000,
            timeoutMsg: "obsidian-git did not become gitReady",
        }
    );
}

describe("obsidian-git smoke", function () {
    it("loads the plugin", async function () {
        const enabled = await browser.executeObsidian(({ app }, pluginId) => {
            return (
                app as { plugins: { enabledPlugins: Set<string> } }
            ).plugins.enabledPlugins.has(pluginId);
        }, PLUGIN_ID);
        expect(enabled).toBe(true);
        await waitForGitReady();
    });

    it("opens source control and lists a changed file", async function () {
        await waitForGitReady();

        await browser.executeObsidian(async ({ app }, pluginId) => {
            if (!(await app.vault.adapter.exists("Changed.md"))) {
                await app.vault.create("Changed.md", "e2e change\n");
            }
            const plugin = (
                app as {
                    plugins: {
                        plugins: Record<
                            string,
                            { refresh?: () => Promise<void> }
                        >;
                    };
                }
            ).plugins.plugins[pluginId];
            await plugin?.refresh?.();
        }, PLUGIN_ID);

        await browser.executeObsidianCommand(OPEN_SOURCE_CONTROL);

        const view = browser.$("main.git-view");
        await expect(view).toExist();

        const changed = browser.$('.git-view [data-path="Changed.md"]');
        await expect(changed).toExist();
        await expect(changed).toHaveAttribute("data-path", "Changed.md");
    });
});
