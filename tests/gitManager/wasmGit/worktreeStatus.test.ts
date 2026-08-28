import { describe, expect, it } from "vitest";
import {
    GIT_FILEMODE_BLOB,
    type GitIndexEntry,
} from "../../../src/gitManager/wasmGit/gitIndex";
import { GitIgnore } from "../../../src/gitManager/wasmGit/gitIgnore";
import {
    collapseUntrackedDirectories,
    collectUntracked,
    composeStatus,
    diffWorktreeAgainstIndex,
    hashGitBlob,
    walkWorktreeMeta,
} from "../../../src/gitManager/wasmGit/worktreeStatus";

function entry(
    path: string,
    args: Partial<GitIndexEntry> & { hash: string; size: number }
): GitIndexEntry {
    return {
        path,
        mtimeSeconds: 1_700_000_000,
        stage: 0,
        mode: GIT_FILEMODE_BLOB,
        ...args,
    };
}

describe("hashGitBlob", () => {
    it("matches the well-known empty blob hash", async () => {
        expect(await hashGitBlob(new Uint8Array())).toBe(
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
    });
});

describe("diffWorktreeAgainstIndex", () => {
    it("does not hash files whose size and mtime already match", async () => {
        const hashed: string[] = [];
        const index = new Map([
            [
                "note.md",
                entry("note.md", {
                    hash: "abc",
                    size: 4,
                    mtimeSeconds: 100,
                }),
            ],
        ]);
        const result = await diffWorktreeAgainstIndex({
            index,
            vaultFiles: new Map([["note.md", { size: 4, mtimeMs: 100_500 }]]),
            hashFile: (path) => {
                hashed.push(path);
                return Promise.resolve("abc");
            },
        });
        expect(result).toEqual({ modified: [], deleted: [] });
        expect(hashed).toEqual([]);
    });

    it("treats a size change as modified without hashing", async () => {
        const hashed: string[] = [];
        const result = await diffWorktreeAgainstIndex({
            index: new Map([
                ["note.md", entry("note.md", { hash: "abc", size: 4 })],
            ]),
            vaultFiles: new Map([["note.md", { size: 8, mtimeMs: 1 }]]),
            hashFile: (path) => {
                hashed.push(path);
                return Promise.resolve("abc");
            },
        });
        expect(result.modified).toEqual(["note.md"]);
        expect(hashed).toEqual([]);
    });

    it("hashes same-size files when the mtime differs", async () => {
        const result = await diffWorktreeAgainstIndex({
            index: new Map([
                [
                    "note.md",
                    entry("note.md", {
                        hash: "old",
                        size: 4,
                        mtimeSeconds: 10,
                    }),
                ],
            ]),
            vaultFiles: new Map([["note.md", { size: 4, mtimeMs: 20_000 }]]),
            hashFile: () => Promise.resolve("new"),
        });
        expect(result.modified).toEqual(["note.md"]);
    });

    it("reports index entries missing from the vault as deleted", async () => {
        const result = await diffWorktreeAgainstIndex({
            index: new Map([
                ["gone.md", entry("gone.md", { hash: "abc", size: 1 })],
            ]),
            vaultFiles: new Map(),
            hashFile: () => Promise.resolve(""),
        });
        expect(result.deleted).toEqual(["gone.md"]);
    });
});

describe("collectUntracked and collapseUntrackedDirectories", () => {
    it("lists vault files that are not in the index", () => {
        expect(
            collectUntracked(
                new Map([
                    ["note.md", { size: 1, mtimeMs: 0 }],
                    ["new.md", { size: 1, mtimeMs: 0 }],
                ]),
                new Map([["note.md", entry("note.md", { hash: "a", size: 1 })]])
            )
        ).toEqual(["new.md"]);
    });

    it("collapses a directory that contains only untracked files", () => {
        expect(
            collapseUntrackedDirectories(
                ["newdir/a.md", "newdir/b.md", "loose.md"],
                ["note.md"]
            ).sort()
        ).toEqual(["loose.md", "newdir/"]);
    });

    it("does not collapse a directory that also has a tracked file", () => {
        expect(
            collapseUntrackedDirectories(["newdir/a.md"], ["newdir/keep.md"])
        ).toEqual(["newdir/a.md"]);
    });
});

describe("composeStatus", () => {
    it("combines staged, unstaged, untracked, and conflicted paths", () => {
        const status = composeStatus({
            staged: [{ type: "A", path: "staged.md" }],
            modified: ["changed.md"],
            deleted: ["deleted.md"],
            untracked: ["new.md"],
            conflicted: ["conflict.md"],
            toVaultPath: (path) => path,
        });
        const byPath = Object.fromEntries(
            status.all.map((file) => [file.path, file])
        );
        expect(byPath["staged.md"]).toMatchObject({
            index: "A",
            workingDir: " ",
        });
        expect(byPath["changed.md"]).toMatchObject({
            index: " ",
            workingDir: "M",
        });
        expect(byPath["deleted.md"]).toMatchObject({
            index: " ",
            workingDir: "D",
        });
        expect(byPath["new.md"]).toMatchObject({
            index: "U",
            workingDir: "U",
        });
        expect(byPath["conflict.md"]).toMatchObject({
            index: "U",
            workingDir: "U",
        });
        expect(status.changed.map((file) => file.path).sort()).toEqual([
            "changed.md",
            "conflict.md",
            "deleted.md",
            "new.md",
        ]);
        expect(status.staged.map((file) => file.path)).toEqual(["staged.md"]);
        expect(status.conflicted).toEqual(["conflict.md"]);
    });
});

describe("walkWorktreeMeta", () => {
    it("lists the vault root as empty string, not slash", async () => {
        const listed: string[] = [];
        const adapter = {
            exists: (path: string) => {
                if (path === "/" || path === ".") return Promise.resolve(false);
                return Promise.resolve(path === "");
            },
            list: (path: string) => {
                listed.push(path);
                if (path !== "") {
                    throw new Error(`unexpected list path ${path}`);
                }
                return Promise.resolve({
                    files: ["Changed.md"],
                    folders: [] as string[],
                });
            },
            stat: (path: string) =>
                Promise.resolve(
                    path === "Changed.md"
                        ? { type: "file" as const, mtime: 1, size: 4 }
                        : null
                ),
            readBinary: () => Promise.resolve(new ArrayBuffer(0)),
            writeBinary: () => Promise.resolve(),
            mkdir: () => Promise.resolve(),
            remove: () => Promise.resolve(),
            rmdir: () => Promise.resolve(),
        };
        const ignore = new GitIgnore();
        const files = await walkWorktreeMeta(adapter, "", {
            exclude: () => false,
            ignore,
            keep: () => false,
            readText: () => Promise.resolve(""),
        });
        expect(listed).toEqual([""]);
        expect([...files.keys()]).toEqual(["Changed.md"]);
    });
});
