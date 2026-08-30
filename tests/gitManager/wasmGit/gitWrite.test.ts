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
    gitObjectStore,
    parseGitConfigValue,
    serializeGitCommit,
    serializeGitTree,
    writeTreeFromIndex,
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
});
