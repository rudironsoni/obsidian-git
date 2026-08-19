import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractChangelogSection } from "../../scripts/extract-changelog";

const changelog = `# Changelog

## 3.0.0 (2026-08-19)

### Features

* first fork release notes

## [2.39.0](https://example.com/compare/2.38.6...2.39.0) (2026-08-12)

### Features

* add option to squash unpushed commits

### [2.38.6](https://example.com/compare/2.38.5...2.38.6) (2026-07-05)

### [2.38.5](https://example.com/compare/2.38.4...2.38.5) (2026-06-14)

### Bug Fixes

* binary writes in mobile git adapter
`;

describe("extractChangelogSection", () => {
    it("extracts an unlinked first-release heading written by standard-version", () => {
        expect(extractChangelogSection(changelog, "3.0.0")).toBe(
            `## 3.0.0 (2026-08-19)

### Features

* first fork release notes
`
        );
    });

    it("extracts a version section and stops before the next heading", () => {
        expect(extractChangelogSection(changelog, "2.39.0")).toBe(
            `## [2.39.0](https://example.com/compare/2.38.6...2.39.0) (2026-08-12)

### Features

* add option to squash unpushed commits
`
        );
    });

    it("extracts a patch heading with no notes", () => {
        expect(extractChangelogSection(changelog, "2.38.6")).toBe(
            `### [2.38.6](https://example.com/compare/2.38.5...2.38.6) (2026-07-05)
`
        );
    });

    it("extracts the last section through the end of the file", () => {
        expect(extractChangelogSection(changelog, "2.38.5")).toBe(
            `### [2.38.5](https://example.com/compare/2.38.4...2.38.5) (2026-06-14)

### Bug Fixes

* binary writes in mobile git adapter
`
        );
    });

    it("throws when the version is missing", () => {
        expect(() => extractChangelogSection(changelog, "9.9.9")).toThrow(
            /No changelog section found for version 9\.9\.9/
        );
    });

    it("throws when no version is provided", () => {
        expect(() => extractChangelogSection(changelog, "")).toThrow(
            /A changelog version is required/
        );
    });

    it("extracts 3.0.0 from the repository CHANGELOG.md", () => {
        const realChangelog = readFileSync("CHANGELOG.md", "utf8");
        const section = extractChangelogSection(realChangelog, "3.0.0");
        expect(section.startsWith("## 3.0.0")).toBe(true);
        expect(section).toContain("BREAKING CHANGES");
        expect(section).not.toContain("## [2.39.0]");
    });
});
