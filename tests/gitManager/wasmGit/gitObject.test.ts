import { describe, expect, it } from "vitest";
import {
    fromHex,
    gitBlobStore,
    hashGitBlob,
    inflateGitObject,
    parseGitTree,
    runPool,
    sha1Hex,
    toHex,
    writeGitLooseBlob,
    zlibDeflate,
    zlibInflate,
} from "../../../src/gitManager/wasmGit/gitObject";

describe("hashGitBlob", () => {
    it("matches git hash-object for the empty blob", async () => {
        expect(await hashGitBlob(new Uint8Array())).toBe(
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
    });

    it("matches git hash-object for a known blob", async () => {
        expect(await hashGitBlob(new TextEncoder().encode("hello\n"))).toBe(
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    });
});

describe("gitBlobStore", () => {
    it("prefixes content with blob <size>\\0", () => {
        const store = gitBlobStore(new Uint8Array([1, 2, 3]));
        expect(new TextDecoder().decode(store.subarray(0, 7))).toBe("blob 3\0");
        expect([...store.subarray(7)]).toEqual([1, 2, 3]);
    });
});

describe("zlib and git objects", () => {
    it("round-trips deflate/inflate", async () => {
        const input = new TextEncoder().encode("payload");
        expect(await zlibInflate(await zlibDeflate(input))).toEqual(input);
    });

    it("inflates a loose blob object", async () => {
        const store = gitBlobStore(new TextEncoder().encode("hi"));
        const inflated = await inflateGitObject(await zlibDeflate(store));
        expect(inflated.type).toBe("blob");
        expect(new TextDecoder().decode(inflated.payload)).toBe("hi");
    });

    it("parses a git tree", () => {
        const hash = fromHex("0123456789abcdef0123456789abcdef01234567");
        const prefix = new TextEncoder().encode("100644 file\0");
        const payload = new Uint8Array(prefix.byteLength + 20);
        payload.set(prefix);
        payload.set(hash, prefix.byteLength);
        expect(parseGitTree(payload)).toEqual([
            {
                mode: 0o100644,
                name: "file",
                hash: "0123456789abcdef0123456789abcdef01234567",
            },
        ]);
    });
});

describe("hex helpers", () => {
    it("round-trips a 20-byte object id", () => {
        const hex = "0123456789abcdef0123456789abcdef01234567";
        expect(toHex(fromHex(hex))).toBe(hex);
    });

    it("rejects malformed object ids", () => {
        expect(() => fromHex("abc")).toThrow(/invalid git object id/);
        expect(() => fromHex("x".repeat(40))).toThrow(/invalid git object id/);
    });
});

describe("writeGitLooseBlob", () => {
    it("writes a zlib-deflated loose object once", async () => {
        const files = new Map<string, Uint8Array>();
        const dirs = new Set<string>(["/repo/.git", "/repo/.git/objects"]);
        const fs = {
            analyzePath(filePath: string) {
                return {
                    exists: files.has(filePath) || dirs.has(filePath),
                };
            },
            mkdir(filePath: string) {
                dirs.add(filePath);
            },
            writeFile(filePath: string, data: Uint8Array) {
                files.set(filePath, data);
            },
        };
        const content = new TextEncoder().encode("hello\n");
        const hash = await writeGitLooseBlob(fs, "/repo/.git", content);
        expect(hash).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
        const objectPath = `/repo/.git/objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
        expect(files.has(objectPath)).toBe(true);
        const deflated = files.get(objectPath)!;
        const inflated = await inflate(deflated);
        expect(inflated).toEqual(gitBlobStore(content));
        expect(await sha1Hex(inflated)).toBe(hash);

        await writeGitLooseBlob(fs, "/repo/.git", content);
        expect(files.size).toBe(1);
    });
});

describe("runPool", () => {
    it("preserves order with a concurrency cap", async () => {
        const seen: number[] = [];
        const result = await runPool([1, 2, 3, 4, 5], 2, async (item) => {
            seen.push(item);
            await Promise.resolve();
            return item * 10;
        });
        expect(result).toEqual([10, 20, 30, 40, 50]);
        expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it("returns an empty array for no items", async () => {
        expect(
            await runPool([] as number[], 8, (item) => Promise.resolve(item))
        ).toEqual([]);
    });
});

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();
    await writer.write(data);
    await writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
