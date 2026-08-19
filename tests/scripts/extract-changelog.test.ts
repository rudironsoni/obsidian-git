import { describe, expect, it } from "vitest";
import { extractChangelogSection } from "../../scripts/extract-changelog.mjs";

const changelog = `# Changelog

## [2.39.0](https://example.com/compare/2.38.6...2.39.0) (2026-08-12)

### Features

* add option to squash unpushed commits

### [2.38.6](https://example.com/compare/2.38.5...2.38.6) (2026-07-05)

### [2.38.5](https://example.com/compare/2.38.4...2.38.5) (2026-06-14)

### Bug Fixes

* binary writes in mobile git adapter
`;

describe("extractChangelogSection", () => {
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
});
