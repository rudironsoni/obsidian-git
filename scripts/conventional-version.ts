export type VersionBump = "major" | "minor" | "patch";

export interface VersionParts {
    major: number;
    minor: number;
    patch: number;
}

export interface BetaTag extends VersionParts {
    tag: string;
    beta: number;
}

const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const BETA_TAG = /^v?(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
const BASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;

export function parseBaseVersion(version: string): VersionParts {
    const match = BASE_VERSION.exec(version);
    if (!match) {
        throw new Error(`Version is not SemVer: ${version}`);
    }
    return {
        major: Number.parseInt(match[1]!, 10),
        minor: Number.parseInt(match[2]!, 10),
        patch: Number.parseInt(match[3]!, 10),
    };
}

export function parseStableTag(tag: string): VersionParts | undefined {
    const match = STABLE_TAG.exec(tag);
    if (!match) return undefined;
    return {
        major: Number.parseInt(match[1]!, 10),
        minor: Number.parseInt(match[2]!, 10),
        patch: Number.parseInt(match[3]!, 10),
    };
}

export function parseBetaTag(tag: string): BetaTag | undefined {
    const match = BETA_TAG.exec(tag);
    if (!match) return undefined;
    return {
        tag,
        major: Number.parseInt(match[1]!, 10),
        minor: Number.parseInt(match[2]!, 10),
        patch: Number.parseInt(match[3]!, 10),
        beta: Number.parseInt(match[4]!, 10),
    };
}

export function formatVersion(version: VersionParts): string {
    return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareVersions(a: VersionParts, b: VersionParts): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

export function bumpVersion(
    version: VersionParts,
    bump: VersionBump
): VersionParts {
    switch (bump) {
        case "major":
            return { major: version.major + 1, minor: 0, patch: 0 };
        case "minor":
            return { major: version.major, minor: version.minor + 1, patch: 0 };
        case "patch":
            return {
                major: version.major,
                minor: version.minor,
                patch: version.patch + 1,
            };
        default: {
            const _exhaustive: never = bump;
            throw new Error(`unhandled bump: ${String(_exhaustive)}`);
        }
    }
}

export function matchesBase(tag: VersionParts, base: VersionParts): boolean {
    return (
        tag.major === base.major &&
        tag.minor === base.minor &&
        tag.patch === base.patch
    );
}

export function conventionalPrefix(branch: string): string {
    const name = branch
        .replace(/^refs\/heads\//, "")
        .replace(/^origin\//, "")
        .trim();
    if (name.includes("/")) {
        return name.split("/")[0]!.toLowerCase();
    }
    const dashed = /^([a-z]+)-/i.exec(name);
    if (dashed) return dashed[1]!.toLowerCase();
    return name.toLowerCase();
}

/**
 * Maps a conventional branch name to a SemVer bump. Unknown or missing
 * names default to patch so every merge still cuts a release.
 */
export function bumpFromBranch(branch: string | undefined | null): VersionBump {
    if (branch == undefined || branch.trim() === "") return "patch";
    const prefix = conventionalPrefix(branch);
    switch (prefix) {
        case "feat":
        case "feature":
            return "minor";
        case "breaking":
        case "major":
            return "major";
        case "fix":
        case "bug":
        case "bugfix":
        case "hotfix":
        case "chore":
        case "deps":
        case "docs":
        case "refactor":
        case "perf":
        case "test":
        case "tests":
        case "ci":
        case "build":
        case "style":
            return "patch";
        default:
            return "patch";
    }
}

export function stableTagExists(
    tags: readonly string[],
    base: VersionParts
): boolean {
    return tags.some((tag) => {
        const parsed = parseStableTag(tag);
        return parsed != undefined && matchesBase(parsed, base);
    });
}

export function isSkipReleaseMessage(
    message: string | undefined | null
): boolean {
    if (message == undefined) return false;
    return (
        message.includes("chore(release)") || message.includes("[skip release]")
    );
}
