import { appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    bumpFromBranch,
    bumpVersion,
    compareVersions,
    formatVersion,
    matchesBase,
    parseBaseVersion,
    parseBetaTag,
    stableTagExists,
    type VersionBump,
    type VersionParts,
} from "./conventional-version";

export interface ReleaseVersionInput {
    packageVersion: string;
    tags: readonly string[];
    branch?: string | null;
    explicitVersion?: string | null;
    explicitBump?: string | null;
}

export interface ReleaseVersionResult {
    version: string;
    bump: VersionBump;
    alreadyTagged: boolean;
    followedBetaBase: string | null;
}

function parseExplicitBump(
    value: string | null | undefined
): VersionBump | undefined {
    if (value == undefined || value === "" || value === "none") {
        return undefined;
    }
    if (value === "major" || value === "minor" || value === "patch") {
        return value;
    }
    throw new Error(`Invalid bump '${value}'`);
}

function relatedBetaBase(
    tags: readonly string[],
    candidate: VersionParts
): VersionParts | undefined {
    const matching = tags
        .map(parseBetaTag)
        .filter((tag) => tag != undefined && matchesBase(tag, candidate));
    return matching.length > 0 ? candidate : undefined;
}

/**
 * Next stable SemVer: explicit version, explicit bump, or conventional
 * branch bump, then at least the beta series that branch already published.
 */
export function computeNextReleaseVersion(
    input: ReleaseVersionInput
): ReleaseVersionResult {
    const packageBase = parseBaseVersion(input.packageVersion);
    const tagged = stableTagExists(input.tags, packageBase);

    if (input.explicitVersion != undefined && input.explicitVersion !== "") {
        const version = parseBaseVersion(input.explicitVersion);
        const formatted = formatVersion(version);
        return {
            version: formatted,
            bump: bumpFromBranch(input.branch),
            alreadyTagged: stableTagExists(input.tags, version),
            followedBetaBase: null,
        };
    }

    const explicitBump = parseExplicitBump(input.explicitBump);
    const bump = explicitBump ?? bumpFromBranch(input.branch);
    const fromBump = tagged ? bumpVersion(packageBase, bump) : packageBase;
    const betaBase = relatedBetaBase(input.tags, fromBump);
    const chosen =
        betaBase != undefined && compareVersions(betaBase, fromBump) > 0
            ? betaBase
            : fromBump;
    const followedBetaBase =
        betaBase != undefined ? formatVersion(betaBase) : null;
    const version = formatVersion(chosen);
    return {
        version,
        bump,
        alreadyTagged: stableTagExists(input.tags, chosen),
        followedBetaBase,
    };
}

function readGitTags(): string[] {
    return execSync("git tag --list", { encoding: "utf8" })
        .split(/\r?\n/)
        .map((tag) => tag.trim())
        .filter(Boolean);
}

function readPackageVersion(): string {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
        version?: unknown;
    };
    if (typeof packageJson.version !== "string") {
        throw new Error("package.json version must be a string");
    }
    return packageJson.version;
}

function run(): void {
    const result = computeNextReleaseVersion({
        packageVersion: readPackageVersion(),
        tags: readGitTags(),
        branch: process.env.RELEASE_BRANCH,
        explicitVersion: process.env.EXPLICIT_VERSION,
        explicitBump: process.env.EXPLICIT_BUMP,
    });
    console.log(`Next stable version: ${result.version}`);
    console.log(`Bump: ${result.bump}`);
    console.log(`Already tagged: ${result.alreadyTagged ? "yes" : "no"}`);
    console.log(`Followed beta base: ${result.followedBetaBase ?? "(none)"}`);

    if (result.alreadyTagged) {
        throw new Error(
            `Stable version ${result.version} is already tagged. Refusing to cut a duplicate release.`
        );
    }

    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
            process.env.GITHUB_OUTPUT,
            `version=${result.version}\nbump=${result.bump}\n`
        );
    } else {
        console.log(`version=${result.version}`);
    }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
}
