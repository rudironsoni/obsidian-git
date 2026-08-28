import type { Plugin } from "obsidian";

/** Vault-root file so it is visible in the iOS Files app after a crash loop. */
export const CRASH_LOG_PATH = "obsidian-git-crash.log";

const MAX_LOG_BYTES = 256_000;
const MAX_EXTRA_CHARS = 500;

export function formatCrashLogLine(phase: string, extra?: unknown): string {
    let extraText = "";
    if (extra !== undefined) {
        try {
            extraText = " " + JSON.stringify(extra);
        } catch {
            extraText = " [unserializable]";
        }
        if (extraText.length > MAX_EXTRA_CHARS) {
            extraText = extraText.slice(0, MAX_EXTRA_CHARS) + "…";
        }
    }
    return `${new Date().toISOString()} [${phase}]${extraText}\n`;
}

/**
 * Append-only boot log that survives an iOS WebView restart.
 * Writes never throw into plugin lifecycle.
 */
export class CrashLog {
    private chain: Promise<void> = Promise.resolve();
    private rotated = false;

    constructor(private readonly plugin: Plugin) {}

    log(phase: string, extra?: unknown): void {
        const line = formatCrashLogLine(phase, extra);
        this.chain = this.chain.then(() => this.write(line)).catch(() => {});
    }

    private async write(line: string): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        if (!this.rotated) {
            this.rotated = true;
            try {
                const stat = await adapter.stat(CRASH_LOG_PATH);
                if (stat != null && stat.size > MAX_LOG_BYTES) {
                    await adapter.write(
                        CRASH_LOG_PATH,
                        formatCrashLogLine("rotate", { size: stat.size })
                    );
                }
            } catch {
                // First write in a new vault: file does not exist yet.
            }
        }
        try {
            await adapter.append(CRASH_LOG_PATH, line);
        } catch {
            const previous = (await adapter.exists(CRASH_LOG_PATH))
                ? new TextDecoder().decode(
                      await adapter.readBinary(CRASH_LOG_PATH)
                  )
                : "";
            await adapter.write(CRASH_LOG_PATH, previous + line);
        }
    }
}
