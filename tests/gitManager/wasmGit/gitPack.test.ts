import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
    applyGitDelta,
    GitPackStore,
    listPackPairs,
} from "../../../src/gitManager/wasmGit/gitPack";
import { git } from "../../helpers/gitCli";
import { withCleanup } from "../../helpers/cleanup";
import {
    cleanupTempDirectory,
    createTempDirectory,
} from "../../helpers/gitRepo";

describe("listPackPairs", () => {
    it("pairs idx files with their pack files", () => {
        expect(
            listPackPairs([
                "objects/pack/pack-aa.idx",
                "objects/pack/pack-aa.pack",
                "objects/pack/pack-aa.keep",
                "objects/pack/pack-bb.idx",
            ])
        ).toEqual([
            {
                idxPath: "objects/pack/pack-aa.idx",
                packPath: "objects/pack/pack-aa.pack",
            },
        ]);
    });
});

describe("applyGitDelta", () => {
    it("copies the base and inserts bytes", () => {
        const base = new TextEncoder().encode("hello world");
        // source size 11, target size 16, copy 11 bytes from 0, insert " now!"
        const delta = Uint8Array.from([
            11,
            16,
            0x80 | 0x01 | 0x10,
            0,
            11,
            5,
            ...new TextEncoder().encode(" now!"),
        ]);
        expect(new TextDecoder().decode(applyGitDelta(base, delta))).toBe(
            "hello world now!"
        );
    });
});

describe("GitPackStore", () => {
    it("reads a packed commit and tree after git repack", async () => {
        const dir = createTempDirectory("obsidian-git-pack-");
        withCleanup({ cleanup: () => cleanupTempDirectory(dir) });
        await git(dir, ["init", "--initial-branch=main", "."]);
        await git(dir, ["config", "user.name", "Test User"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        writeFileSync(path.join(dir, "note.md"), "base\n");
        await git(dir, ["add", "note.md"]);
        await git(dir, ["commit", "-m", "base"]);
        writeFileSync(path.join(dir, "note.md"), "base plus a little more\n");
        await git(dir, ["add", "note.md"]);
        await git(dir, ["commit", "-m", "edit"]);
        await git(dir, ["repack", "-Ad"]);
        await git(dir, ["prune-packed"]);

        const head = await git(dir, ["rev-parse", "HEAD"]);
        expect(
            existsSync(
                path.join(
                    dir,
                    ".git",
                    "objects",
                    head.slice(0, 2),
                    head.slice(2)
                )
            )
        ).toBe(false);

        const packDir = path.join(dir, ".git", "objects", "pack");
        const files = readdirSync(packDir).map(
            (name) => `.git/objects/pack/${name}`
        );
        const store = new GitPackStore();
        const readPack = (vaultPath: string): Promise<Uint8Array> =>
            Promise.resolve(
                new Uint8Array(readFileSync(path.join(dir, vaultPath)))
            );
        const commit = await store.get(head, listPackPairs(files), readPack);
        expect(commit?.type).toBe("commit");
        const tree = new TextDecoder()
            .decode(commit!.payload)
            .match(/^tree ([0-9a-f]{40})/m)?.[1];
        expect(tree).toBe(await git(dir, ["rev-parse", "HEAD^{tree}"]));

        const blobHash = await git(dir, ["rev-parse", "HEAD:note.md"]);
        const blob = await store.get(blobHash, listPackPairs(files), readPack);
        expect(blob?.type).toBe("blob");
        expect(new TextDecoder().decode(blob!.payload)).toBe(
            "base plus a little more\n"
        );
    });
});
