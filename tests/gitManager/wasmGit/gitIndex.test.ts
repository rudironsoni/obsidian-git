import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { parseGitIndex } from "../../../src/gitManager/wasmGit/gitIndex";
import { hashGitBlob } from "../../../src/gitManager/wasmGit/worktreeStatus";
import { withCleanup } from "../../helpers/cleanup";
import { git } from "../../helpers/gitCli";
import {
    cleanupTempDirectory,
    createTempDirectory,
} from "../../helpers/gitRepo";

describe("parseGitIndex", () => {
    it("reads path, size, hash, and mtime from a native git index", async () => {
        const dir = createTempDirectory("obsidian-git-index-");
        withCleanup({ cleanup: () => cleanupTempDirectory(dir) });
        await git(dir, ["init", "--initial-branch=main", "."]);
        await git(dir, ["config", "user.name", "Test User"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        const content = "hello index\n";
        writeFileSync(path.join(dir, "note.md"), content);
        await git(dir, ["add", "note.md"]);

        const entries = parseGitIndex(
            new Uint8Array(readFileSync(path.join(dir, ".git/index")))
        );
        const note = entries.find((entry) => entry.path === "note.md");
        expect(note).toBeDefined();
        expect(note!.stage).toBe(0);
        expect(note!.size).toBe(Buffer.byteLength(content));
        expect(note!.hash).toBe(await hashGitBlob(Buffer.from(content)));
        expect(note!.mtimeSeconds).toBeGreaterThan(0);
    });

    it("records unmerged stages during a conflict", async () => {
        const dir = createTempDirectory("obsidian-git-index-conflict-");
        withCleanup({ cleanup: () => cleanupTempDirectory(dir) });
        await git(dir, ["init", "--initial-branch=main", "."]);
        await git(dir, ["config", "user.name", "Test User"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        writeFileSync(path.join(dir, "note.md"), "base\n");
        await git(dir, ["add", "note.md"]);
        await git(dir, ["commit", "-m", "base"]);
        await git(dir, ["checkout", "-b", "other"]);
        writeFileSync(path.join(dir, "note.md"), "other\n");
        await git(dir, ["commit", "-am", "other"]);
        await git(dir, ["checkout", "main"]);
        writeFileSync(path.join(dir, "note.md"), "main\n");
        await git(dir, ["commit", "-am", "main"]);
        await git(dir, ["merge", "other"]).catch(() => undefined);

        const entries = parseGitIndex(
            new Uint8Array(readFileSync(path.join(dir, ".git/index")))
        );
        const stages = entries
            .filter((entry) => entry.path === "note.md")
            .map((entry) => entry.stage)
            .sort();
        expect(stages).toEqual([1, 2, 3]);
    });
});
