import { appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    bumpFromBranch,
    bumpVersion,
    formatVersion,
    matchesBase,
    parseBaseVersion,
    parseBetaTag,
    stableTagExists,
    type BetaTag,
    type VersionParts,
} from "./conventional-version";

export interface BetaVersionResult {
    packageBaseVersion: string;
    betaBaseVersion: string;
    packageStableTagExists: boolean;
    bump: ReturnType<typeof bumpFromBranch>;
    latestBetaTag: string | null;
    nextBetaVersion: string;
}

export function computeNextBetaVersion(
    packageVersion: string,
    tags: readonly string[],
    branch: string | undefined | null
): BetaVersionResult {
    const packageBase = parseBaseVersion(packageVersion);
    const bump = bumpFromBranch(branch);
    const packageStableTagExists = stableTagExists(tags, packageBase);
    const betaBase: VersionParts = packageStableTagExists
        ? bumpVersion(packageBase, bump)
        : packageBase;
    const betaTags = tags
        .map(parseBetaTag)
        .filter(
            (tag): tag is BetaTag =>
                tag != undefined && matchesBase(tag, betaBase)
        )
        .sort((a, b) => b.beta - a.beta);
    const latestBetaTag = betaTags[0] ?? null;
    const betaBaseVersion = formatVersion(betaBase);

    return {
        packageBaseVersion: formatVersion(packageBase),
        betaBaseVersion,
        packageStableTagExists,
        bump,
        latestBetaTag: latestBetaTag?.tag ?? null,
        nextBetaVersion: `${betaBaseVersion}-beta.${latestBetaTag ? latestBetaTag.beta + 1 : 1}`,
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
    const branch =
        process.env.RELEASE_BRANCH ??
        process.env.GITHUB_REF_NAME ??
        process.env.GITHUB_HEAD_REF;
    const result = computeNextBetaVersion(
        readPackageVersion(),
        readGitTags(),
        branch
    );
    console.log(`Package base version: ${result.packageBaseVersion}`);
    console.log(
        `Package stable tag exists: ${result.packageStableTagExists ? "yes" : "no"}`
    );
    console.log(`Bump from branch: ${result.bump}`);
    console.log(`Beta base version: ${result.betaBaseVersion}`);
    console.log(
        `Latest beta tag for base: ${result.latestBetaTag ?? "(none)"}`
    );
    console.log(`Next beta tag: ${result.nextBetaVersion}`);

    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
            process.env.GITHUB_OUTPUT,
            `new_tag=${result.nextBetaVersion}\n`
        );
    } else {
        console.log(`new_tag=${result.nextBetaVersion}`);
    }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
}
