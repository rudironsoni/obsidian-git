import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
const VERSION_HEADING = new RegExp(
    `^#{2,3} (?:\\[(${VERSION})\\]|(${VERSION})\\b)`,
    "gm"
);

function headingVersion(match: RegExpExecArray): string {
    return match[1] ?? match[2] ?? "";
}

/**
 * Return the CHANGELOG.md section for `version`, from its heading through
 * the line before the next version heading.
 *
 * Accepts both linked headings (`## [1.2.3](url)`) and the unlinked first
 * release heading that standard-version writes (`## 1.2.3 (date)`).
 */
export function extractChangelogSection(
    changelog: string,
    version: string
): string {
    if (version.length === 0) {
        throw new Error("A changelog version is required.");
    }

    VERSION_HEADING.lastIndex = 0;
    let match = VERSION_HEADING.exec(changelog);
    let start = -1;
    let end = changelog.length;

    while (match !== null) {
        if (headingVersion(match) === version) {
            start = match.index;
            const next = VERSION_HEADING.exec(changelog);
            if (next !== null) {
                end = next.index;
            }
            break;
        }
        match = VERSION_HEADING.exec(changelog);
    }

    if (start === -1) {
        throw new Error(`No changelog section found for version ${version}.`);
    }

    return changelog.slice(start, end).trimEnd() + "\n";
}

function isDirectRun(): boolean {
    return (
        process.argv[1] != null &&
        import.meta.url === pathToFileURL(resolve(process.argv[1])).href
    );
}

if (isDirectRun()) {
    const version = process.argv[2];
    if (version == null || version.length === 0) {
        console.error("Usage: node scripts/extract-changelog.ts <version>");
        process.exit(1);
    }

    const changelogPath = resolve(
        fileURLToPath(new URL("../CHANGELOG.md", import.meta.url))
    );
    process.stdout.write(
        extractChangelogSection(readFileSync(changelogPath, "utf8"), version)
    );
}
