import { describe, expect, it } from "vitest";
import { GitCpu } from "../../../src/gitManager/wasmGit/gitCpu";
import { hashGitBlob } from "../../../src/gitManager/wasmGit/gitObject";
import { GIT_FILEMODE_BLOB } from "../../../src/gitManager/wasmGit/gitIndex";

describe("GitCpu", () => {
    it("hashes blobs without a worker in tests", async () => {
        const cpu = new GitCpu();
        const content = new TextEncoder().encode("hello\n");
        expect(await cpu.hashGitBlob(content)).toBe(await hashGitBlob(content));
        cpu.terminate();
    });

    it("builds tree objects and an index", async () => {
        const cpu = new GitCpu();
        const entries = [
            {
                path: "note.md",
                hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                size: 1,
                mtimeSeconds: 1,
                stage: 0,
                mode: GIT_FILEMODE_BLOB,
            },
        ];
        const tree = await cpu.writeTreeFromIndex(entries);
        expect(tree.tree).toMatch(/^[0-9a-f]{40}$/);
        expect(tree.objects.length).toBeGreaterThan(0);
        const index = await cpu.writeGitIndex(entries);
        expect(index.byteLength).toBeGreaterThan(12);
        cpu.terminate();
    });
});
