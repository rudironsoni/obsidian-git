import { describe, expect, it } from "vitest";
import {
    GIT_FILEMODE_BLOB,
    type GitIndexEntry,
} from "../../../src/gitManager/wasmGit/gitIndex";
import {
    inflateGitObject,
    parseGitTree,
} from "../../../src/gitManager/wasmGit/gitObject";
import {
    compareGitTreeEntries,
    countUnpushedFromReflog,
    gitObjectStore,
    listGitConfigSubsections,
    parseGitConfigValue,
    parsePackedRefs,
    parseReflogUnixSeconds,
    removeGitConfigSection,
    upsertGitConfigValue,
    serializeGitCommit,
    serializeGitTree,
    writeTreeFromIndex,
    writeTreeObjects,
} from "../../../src/gitManager/wasmGit/gitWrite";

function blob(path: string, hash: string): GitIndexEntry {
    return {
        path,
        hash,
        size: 1,
        mtimeSeconds: 1,
        stage: 0,
        mode: GIT_FILEMODE_BLOB,
    };
}

describe("serializeGitTree", () => {
    it("sorts a tree after a blob with the same prefix", () => {
        const blobEntry = {
            mode: 0o100644,
            name: "a",
            hash: "0123456789abcdef0123456789abcdef01234567",
        };
        const treeEntry = {
            mode: 0o040000,
            name: "a",
            hash: "fedcba9876543210fedcba9876543210fedcba98",
        };
        expect(compareGitTreeEntries(blobEntry, treeEntry)).toBeLessThan(0);
        const payload = serializeGitTree([treeEntry, blobEntry]);
        expect(parseGitTree(payload).map((entry) => entry.name)).toEqual([
            "a",
            "a",
        ]);
        expect(parseGitTree(payload).map((entry) => entry.mode)).toEqual([
            0o100644, 0o040000,
        ]);
    });
});

describe("gitObjectStore", () => {
    it("matches the empty tree hash", async () => {
        const { hash, compressed } = await gitObjectStore(
            "tree",
            new Uint8Array()
        );
        expect(hash).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
        const inflated = await inflateGitObject(compressed);
        expect(inflated.type).toBe("tree");
        expect(inflated.payload.byteLength).toBe(0);
    });
});

describe("writeTreeFromIndex", () => {
    it("writes nested trees from index paths", async () => {
        const written: { type: string; payload: Uint8Array }[] = [];
        const hash = await writeTreeFromIndex(
            [
                blob("dir/a.md", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                blob("b.md", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            ],
            async (type, payload) => {
                written.push({ type, payload });
                const stored = await gitObjectStore(type, payload);
                return stored.hash;
            }
        );
        expect(written.some((item) => item.type === "tree")).toBe(true);
        expect(hash).toMatch(/^[0-9a-f]{40}$/);
        const root = written[written.length - 1]!;
        const names = parseGitTree(root.payload).map((entry) => entry.name);
        expect(names.sort()).toEqual(["b.md", "dir"]);
    });

    it("returns compressed tree objects", async () => {
        const built = await writeTreeObjects([
            blob("dir/a.md", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            blob("b.md", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ]);
        expect(built.tree).toMatch(/^[0-9a-f]{40}$/);
        expect(built.objects.length).toBeGreaterThan(0);
        expect(built.objects.some((object) => object.hash === built.tree)).toBe(
            true
        );
    });
});

describe("serializeGitCommit", () => {
    it("writes a git commit payload", () => {
        const payload = serializeGitCommit({
            tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            parents: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            author: {
                name: "Test User",
                email: "test@example.com",
                epochSeconds: 1_700_000_000,
                tz: "+0000",
            },
            committer: {
                name: "Test User",
                email: "test@example.com",
                epochSeconds: 1_700_000_000,
                tz: "+0000",
            },
            message: "hello",
        });
        const text = new TextDecoder().decode(payload);
        expect(text).toContain("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904");
        expect(text).toContain(
            "parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        expect(text).toContain("hello\n");
    });
});

describe("parseGitConfigValue", () => {
    it("reads a dotted key", () => {
        const content = "[user]\n\tname = Test User\n\temail = a@b.c\n";
        expect(parseGitConfigValue(content, "user.name")).toBe("Test User");
        expect(parseGitConfigValue(content, "user.email")).toBe("a@b.c");
        expect(parseGitConfigValue(content, "core.filemode")).toBeUndefined();
    });

    it("reads a subsection key", () => {
        const content = [
            '[branch "main"]',
            "\tremote = origin",
            "\tmerge = refs/heads/main",
            '[remote "origin"]',
            "\turl = https://github.com/example/repo.git",
            "",
        ].join("\n");
        expect(parseGitConfigValue(content, "branch.main.remote")).toBe(
            "origin"
        );
        expect(parseGitConfigValue(content, "branch.main.merge")).toBe(
            "refs/heads/main"
        );
        expect(parseGitConfigValue(content, "remote.origin.url")).toBe(
            "https://github.com/example/repo.git"
        );
        expect(listGitConfigSubsections(content, "remote")).toEqual(["origin"]);
    });

    it("upserts and removes a remote section", () => {
        let content = "[user]\n\tname = Test User\n";
        content = upsertGitConfigValue(
            content,
            "remote.origin.url",
            "https://example.com/a.git"
        );
        expect(parseGitConfigValue(content, "remote.origin.url")).toBe(
            "https://example.com/a.git"
        );
        content = upsertGitConfigValue(
            content,
            "remote.origin.url",
            "https://example.com/b.git"
        );
        expect(parseGitConfigValue(content, "remote.origin.url")).toBe(
            "https://example.com/b.git"
        );
        content = removeGitConfigSection(content, "remote", "origin");
        expect(
            parseGitConfigValue(content, "remote.origin.url")
        ).toBeUndefined();
        expect(parseGitConfigValue(content, "user.name")).toBe("Test User");
    });
});

describe("parsePackedRefs", () => {
    it("skips comments and peeled tags", () => {
        const content = [
            "# pack-refs with: peeled",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/remotes/origin/main",
            "^cccccccccccccccccccccccccccccccccccccccc",
            "",
        ].join("\n");
        const refs = parsePackedRefs(content);
        expect(refs.get("refs/heads/main")).toBe(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        expect(refs.get("refs/remotes/origin/main")).toBe(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        expect(refs.size).toBe(2);
    });
});

describe("reflog helpers", () => {
    it("reads the timestamp and unpushed count", () => {
        const tracking = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const first = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const second = "cccccccccccccccccccccccccccccccccccccccc";
        const content = [
            `${tracking} ${first} Test <t@e.c> 1700000000 +0000\tcommit: one`,
            `${first} ${second} Test <t@e.c> 1700000001 +0000\tcommit: two`,
            "",
        ].join("\n");
        expect(parseReflogUnixSeconds(content.split("\n")[1]!)).toBe(
            1700000001
        );
        expect(countUnpushedFromReflog(content, tracking)).toBe(2);
        expect(countUnpushedFromReflog(content, second)).toBe(0);
    });
});
