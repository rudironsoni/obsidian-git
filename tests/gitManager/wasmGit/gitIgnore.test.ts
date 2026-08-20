import { describe, expect, it } from "vitest";
import { GitIgnore } from "../../../src/gitManager/wasmGit/gitIgnore";

describe("GitIgnore", () => {
    it("ignores names in any directory when the pattern has no slash", () => {
        const ignore = new GitIgnore();
        ignore.addFile("", "*.bin\n.DS_Store\n");

        expect(ignore.ignores("photo.bin", false)).toBe(true);
        expect(ignore.ignores("assets/photo.bin", false)).toBe(true);
        expect(ignore.ignores(".DS_Store", false)).toBe(true);
        expect(ignore.ignores("note.md", false)).toBe(false);
    });

    it("treats a trailing slash as directory-only and ignores children", () => {
        const ignore = new GitIgnore();
        ignore.addFile("", ".obsidian/\n");

        expect(ignore.ignores(".obsidian", true)).toBe(true);
        expect(ignore.ignoresPathOrParent(".obsidian/workspace.json")).toBe(
            true
        );
        expect(ignore.canSkipDirectory(".obsidian")).toBe(true);
        expect(ignore.ignores("obsidian.md", false)).toBe(false);
    });

    it("anchors patterns that contain a slash to the ignore file directory", () => {
        const ignore = new GitIgnore();
        ignore.addFile("", "/root-only.md\n");
        ignore.addFile("docs", "private.md\n");

        expect(ignore.ignores("root-only.md", false)).toBe(true);
        expect(ignore.ignores("nested/root-only.md", false)).toBe(false);
        expect(ignore.ignores("docs/private.md", false)).toBe(true);
        expect(ignore.ignores("private.md", false)).toBe(false);
    });

    it("honors negation and reports that walkers must not skip directories", () => {
        const ignore = new GitIgnore();
        ignore.addFile("", "*\n!keep.md\n");

        expect(ignore.ignores("skip.md", false)).toBe(true);
        expect(ignore.ignores("keep.md", false)).toBe(false);
        expect(ignore.hasNegations).toBe(true);
        expect(ignore.canSkipDirectory("anything")).toBe(false);
    });

    it("supports ** across directories", () => {
        const ignore = new GitIgnore();
        ignore.addFile("", "**/draft.md\n");

        expect(ignore.ignores("draft.md", false)).toBe(true);
        expect(ignore.ignores("notes/draft.md", false)).toBe(true);
        expect(ignore.ignores("notes/keep.md", false)).toBe(false);
    });
});
