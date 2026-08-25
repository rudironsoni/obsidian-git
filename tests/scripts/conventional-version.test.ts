import { describe, expect, it } from "vitest";
import {
    bumpFromBranch,
    bumpVersion,
    compareVersions,
    formatVersion,
    isSkipReleaseMessage,
    parseBaseVersion,
} from "../../scripts/conventional-version";
import { computeNextBetaVersion } from "../../scripts/compute-beta-version";
import { computeNextReleaseVersion } from "../../scripts/compute-release-version";

describe("bumpFromBranch", () => {
    it("maps feat and feature to minor", () => {
        expect(bumpFromBranch("feat/wasm-staging")).toBe("minor");
        expect(bumpFromBranch("feature-login")).toBe("minor");
        expect(bumpFromBranch("refs/heads/feat/foo")).toBe("minor");
    });

    it("maps fix-family prefixes to patch", () => {
        expect(bumpFromBranch("fix/oob")).toBe("patch");
        expect(bumpFromBranch("bugfix-typo")).toBe("patch");
        expect(bumpFromBranch("hotfix/prod")).toBe("patch");
        expect(bumpFromBranch("chore/ci")).toBe("patch");
    });

    it("maps breaking and major to major", () => {
        expect(bumpFromBranch("breaking/api")).toBe("major");
        expect(bumpFromBranch("major-drop-native-git")).toBe("major");
    });

    it("defaults missing or unknown names to patch", () => {
        expect(bumpFromBranch(undefined)).toBe("patch");
        expect(bumpFromBranch("")).toBe("patch");
        expect(bumpFromBranch("cursor/fix-wasm-add-oob-026e")).toBe("patch");
    });
});

describe("computeNextBetaVersion", () => {
    const tags = ["3.1.0", "3.1.1"];

    it("uses a minor beta base for feat when the package version is already tagged", () => {
        const result = computeNextBetaVersion("3.1.1", tags, "feat/staging");
        expect(result.betaBaseVersion).toBe("3.2.0");
        expect(result.nextBetaVersion).toBe("3.2.0-beta.1");
        expect(result.bump).toBe("minor");
    });

    it("uses a patch beta base for fix when the package version is already tagged", () => {
        const result = computeNextBetaVersion("3.1.1", tags, "fix/oob");
        expect(result.betaBaseVersion).toBe("3.1.2");
        expect(result.nextBetaVersion).toBe("3.1.2-beta.1");
    });

    it("uses a major beta base for breaking branches", () => {
        const result = computeNextBetaVersion("3.1.1", tags, "breaking/wasm");
        expect(result.nextBetaVersion).toBe("4.0.0-beta.1");
    });

    it("increments N for an existing beta series", () => {
        const result = computeNextBetaVersion(
            "3.1.1",
            [...tags, "3.2.0-beta.1", "3.2.0-beta.5"],
            "feat/more"
        );
        expect(result.latestBetaTag).toBe("3.2.0-beta.5");
        expect(result.nextBetaVersion).toBe("3.2.0-beta.6");
    });

    it("keeps the package version as the beta base when it is not tagged yet", () => {
        const result = computeNextBetaVersion("3.1.1", ["3.1.0"], "feat/new");
        expect(result.packageStableTagExists).toBe(false);
        expect(result.nextBetaVersion).toBe("3.1.1-beta.1");
    });
});

describe("computeNextReleaseVersion", () => {
    it("bumps minor for a feat PR and follows that beta base", () => {
        const result = computeNextReleaseVersion({
            packageVersion: "3.1.1",
            tags: ["3.1.1", "3.2.0-beta.5"],
            branch: "feat/staging",
        });
        expect(result.version).toBe("3.2.0");
        expect(result.followedBetaBase).toBe("3.2.0");
        expect(result.alreadyTagged).toBe(false);
        expect(result.bump).toBe("minor");
    });

    it("bumps patch for a fix PR without taking an unrelated feat beta", () => {
        const result = computeNextReleaseVersion({
            packageVersion: "3.1.1",
            tags: ["3.1.1", "3.2.0-beta.1"],
            branch: "fix/oob",
        });
        expect(result.version).toBe("3.1.2");
        expect(result.followedBetaBase).toBeNull();
    });

    it("defaults a missing PR branch to patch", () => {
        const result = computeNextReleaseVersion({
            packageVersion: "3.1.1",
            tags: ["3.1.1"],
        });
        expect(result.version).toBe("3.1.2");
        expect(result.bump).toBe("patch");
    });

    it("honours an explicit version override", () => {
        const result = computeNextReleaseVersion({
            packageVersion: "3.1.1",
            tags: ["3.1.1"],
            branch: "feat/ignored",
            explicitVersion: "9.0.0",
        });
        expect(result.version).toBe("9.0.0");
    });

    it("honours an explicit bump override", () => {
        const result = computeNextReleaseVersion({
            packageVersion: "3.1.1",
            tags: ["3.1.1"],
            branch: "fix/ignored",
            explicitBump: "major",
        });
        expect(result.version).toBe("4.0.0");
        expect(result.bump).toBe("major");
    });

    it("marks the result already tagged when the stable tag exists", () => {
        const result = computeNextReleaseVersion({
            packageVersion: "3.1.1",
            tags: ["3.1.1", "3.1.2"],
            branch: "fix/oob",
        });
        expect(result.version).toBe("3.1.2");
        expect(result.alreadyTagged).toBe(true);
    });

    it("releases the untagged package version without bumping", () => {
        const result = computeNextReleaseVersion({
            packageVersion: "3.1.1",
            tags: ["3.1.0"],
            branch: "feat/first",
        });
        expect(result.version).toBe("3.1.1");
        expect(result.alreadyTagged).toBe(false);
    });
});

describe("isSkipReleaseMessage", () => {
    it("detects standard-version and explicit skip markers", () => {
        expect(isSkipReleaseMessage("chore(release): 3.1.2")).toBe(true);
        expect(isSkipReleaseMessage("docs: note [skip release]")).toBe(true);
        expect(isSkipReleaseMessage("feat: staging engine")).toBe(false);
    });
});

describe("version helpers", () => {
    it("bumps and compares SemVer parts", () => {
        expect(
            formatVersion(bumpVersion(parseBaseVersion("3.1.1"), "minor"))
        ).toBe("3.2.0");
        expect(
            compareVersions(
                parseBaseVersion("3.2.0"),
                parseBaseVersion("3.1.2")
            )
        ).toBeGreaterThan(0);
    });
});
