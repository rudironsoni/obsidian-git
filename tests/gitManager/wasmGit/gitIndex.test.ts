import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
    GIT_FILEMODE_BLOB,
    compareIndexEntries,
    parseGitIndex,
    removeIndexPath,
    upsertStagedFile,
    writeGitIndex,
    type GitIndexEntry,
} from "../../../src/gitManager/wasmGit/gitIndex";
import { hashGitBlob } from "../../../src/gitManager/wasmGit/gitObject";
import { withCleanup } from "../../helpers/cleanup";
import { git } from "../../helpers/gitCli";
import {
    cleanupTempDirectory,
    createTempDirectory,
} from "../../helpers/gitRepo";

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

function blobEntry(
    filePath: string,
    args: Partial<GitIndexEntry> & { hash?: string; size?: number } = {}
): GitIndexEntry {
    return {
        path: filePath,
        hash: args.hash ?? EMPTY_BLOB,
        size: args.size ?? 0,
        mtimeSeconds: args.mtimeSeconds ?? 1_700_000_000,
        stage: args.stage ?? 0,
        mode: args.mode ?? GIT_FILEMODE_BLOB,
        skipWorktree: args.skipWorktree,
        intentToAdd: args.intentToAdd,
        assumeValid: args.assumeValid,
    };
}

async function initRepo(prefix: string): Promise<string> {
    const dir = createTempDirectory(prefix);
    withCleanup({ cleanup: () => cleanupTempDirectory(dir) });
    await git(dir, ["init", "--initial-branch=main", "."]);
    await git(dir, ["config", "user.name", "Test User"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    return dir;
}

describe("parseGitIndex", () => {
    it("reads path, size, hash, mode, and mtime from a native git index", async () => {
        const dir = await initRepo("obsidian-git-index-");
        const content = "hello index\n";
        writeFileSync(path.join(dir, "note.md"), content);
        await git(dir, ["add", "note.md"]);

        const entries = parseGitIndex(
            new Uint8Array(readFileSync(path.join(dir, ".git/index")))
        );
        const note = entries.find((entry) => entry.path === "note.md");
        expect(note).toBeDefined();
        expect(note!.stage).toBe(0);
        expect(note!.mode).toBe(GIT_FILEMODE_BLOB);
        expect(note!.size).toBe(Buffer.byteLength(content));
        expect(note!.hash).toBe(await hashGitBlob(Buffer.from(content)));
        expect(note!.mtimeSeconds).toBeGreaterThan(0);
        expect(note!.skipWorktree).toBe(false);
        expect(note!.intentToAdd).toBe(false);
    });

    it("records unmerged stages during a conflict", async () => {
        const dir = await initRepo("obsidian-git-index-conflict-");
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

    it("parses a native v4 prefix-compressed index", async () => {
        const dir = await initRepo("obsidian-git-index-v4-");
        writeFileSync(path.join(dir, "alpha.md"), "a\n");
        writeFileSync(path.join(dir, "alphabet.md"), "ab\n");
        writeFileSync(path.join(dir, "zulu.md"), "z\n");
        await git(dir, ["add", "alpha.md", "alphabet.md", "zulu.md"]);
        await git(dir, ["update-index", "--index-version", "4"]);

        const raw = readFileSync(path.join(dir, ".git/index"));
        expect(raw.subarray(4, 8).readUInt32BE(0)).toBe(4);

        const entries = parseGitIndex(new Uint8Array(raw));
        expect(entries.map((entry) => entry.path).sort()).toEqual([
            "alpha.md",
            "alphabet.md",
            "zulu.md",
        ]);
        expect(entries.find((entry) => entry.path === "alpha.md")!.size).toBe(
            2
        );
    });

    it("parses skip-worktree and intent-to-add flags", async () => {
        const dir = await initRepo("obsidian-git-index-flags-");
        writeFileSync(path.join(dir, "note.md"), "tracked\n");
        writeFileSync(path.join(dir, "planned.md"), "later\n");
        await git(dir, ["add", "note.md"]);
        await git(dir, ["update-index", "--skip-worktree", "note.md"]);
        await git(dir, ["add", "-N", "planned.md"]);

        const entries = parseGitIndex(
            new Uint8Array(readFileSync(path.join(dir, ".git/index")))
        );
        expect(
            entries.find((entry) => entry.path === "note.md")!.skipWorktree
        ).toBe(true);
        expect(
            entries.find((entry) => entry.path === "planned.md")!.intentToAdd
        ).toBe(true);
    });

    it("accepts an all-zero skipHash checksum trailer", async () => {
        const dir = await initRepo("obsidian-git-index-skiphash-");
        writeFileSync(path.join(dir, "note.md"), "x\n");
        await git(dir, ["add", "note.md"]);
        const raw = new Uint8Array(readFileSync(path.join(dir, ".git/index")));
        raw.fill(0, raw.byteLength - 20);
        const entries = parseGitIndex(raw);
        expect(entries.map((entry) => entry.path)).toEqual(["note.md"]);
    });

    it("rejects a split index", async () => {
        const dir = await initRepo("obsidian-git-index-split-");
        writeFileSync(path.join(dir, "note.md"), "x\n");
        await git(dir, ["add", "note.md"]);
        await git(dir, ["update-index", "--split-index"]);
        expect(() =>
            parseGitIndex(
                new Uint8Array(readFileSync(path.join(dir, ".git/index")))
            )
        ).toThrow(/split git indexes are not supported/);
    });
});

describe("writeGitIndex", () => {
    it("round-trips v2 entries and is accepted by native git", async () => {
        const dir = await initRepo("obsidian-git-index-write-");
        const content = "hello write\n";
        writeFileSync(path.join(dir, "note.md"), content);
        await git(dir, ["add", "note.md"]);
        await git(dir, ["commit", "-m", "base"]);
        const original = parseGitIndex(
            new Uint8Array(readFileSync(path.join(dir, ".git/index")))
        );

        const rewritten = await writeGitIndex(original);
        writeFileSync(path.join(dir, ".git/index"), rewritten);

        expect((await git(dir, ["ls-files"])).trim()).toBe("note.md");
        expect(await git(dir, ["hash-object", "note.md"])).toBe(
            original[0]!.hash
        );
        expect(
            (await git(dir, ["diff", "--cached", "--name-only"])).trim()
        ).toBe("");
        expect(parseGitIndex(rewritten)[0]!.path).toBe("note.md");
        expect(parseGitIndex(rewritten)[0]!.mode).toBe(GIT_FILEMODE_BLOB);
    });

    it("writes v3 when skip-worktree is set and native git honours it", async () => {
        const dir = await initRepo("obsidian-git-index-v3-");
        writeFileSync(path.join(dir, "note.md"), "keep\n");
        await git(dir, ["add", "note.md"]);
        await git(dir, ["commit", "-m", "base"]);
        const [note] = parseGitIndex(
            new Uint8Array(readFileSync(path.join(dir, ".git/index")))
        );
        const rewritten = await writeGitIndex([
            { ...note!, skipWorktree: true },
        ]);
        expect(rewritten.subarray(4, 8)[3]).toBe(3);
        writeFileSync(path.join(dir, ".git/index"), rewritten);
        expect(await git(dir, ["ls-files", "-v"])).toMatch(/^S note\.md$/m);
        const parsed = parseGitIndex(rewritten);
        expect(parsed[0]!.skipWorktree).toBe(true);
    });

    it("writes and re-parses paths longer than 0xFFF bytes", async () => {
        const longPath = `${"a".repeat(0x1000)}/note.md`;
        expect(new TextEncoder().encode(longPath).byteLength).toBeGreaterThan(
            0x0fff
        );
        const written = await writeGitIndex([blobEntry(longPath, { size: 0 })]);
        const parsed = parseGitIndex(written);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]!.path).toBe(longPath);
    });

    it("sorts by UTF-8 path then stage", () => {
        const b = blobEntry("b.md");
        const a3 = blobEntry("a.md", { stage: 3 });
        const a1 = blobEntry("a.md", { stage: 1 });
        expect(
            [b, a3, a1]
                .sort(compareIndexEntries)
                .map((entry) => [entry.path, entry.stage])
        ).toEqual([
            ["a.md", 1],
            ["a.md", 3],
            ["b.md", 0],
        ]);
    });
});

describe("index mutations", () => {
    it("upsert replaces conflict stages with a single stage-0 entry", () => {
        const conflicted = [
            blobEntry("note.md", { stage: 1, hash: "a".repeat(40) }),
            blobEntry("note.md", { stage: 2, hash: "b".repeat(40) }),
            blobEntry("note.md", { stage: 3, hash: "c".repeat(40) }),
            blobEntry("other.md"),
        ];
        const next = upsertStagedFile(
            conflicted,
            blobEntry("note.md", { hash: "d".repeat(40), size: 4 })
        );
        expect(
            next.filter((entry) => entry.path === "note.md").map((e) => e.stage)
        ).toEqual([0]);
        expect(next.some((entry) => entry.path === "other.md")).toBe(true);
    });

    it("removeIndexPath drops every stage for a path", () => {
        const entries = [
            blobEntry("note.md", { stage: 1 }),
            blobEntry("note.md", { stage: 2 }),
            blobEntry("keep.md"),
        ];
        expect(removeIndexPath(entries, "note.md").map((e) => e.path)).toEqual([
            "keep.md",
        ]);
    });
});
