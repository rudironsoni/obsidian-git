const encoder = new TextEncoder();

export async function sha1Hex(data: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest("SHA-1", data);
    return toHex(new Uint8Array(digest));
}

/** `blob <size>\\0` + content, the payload `git hash-object` hashes. */
export function gitBlobStore(content: Uint8Array): Uint8Array {
    const header = encoder.encode(`blob ${content.byteLength}\0`);
    const store = new Uint8Array(header.byteLength + content.byteLength);
    store.set(header);
    store.set(content, header.byteLength);
    return store;
}

/** SHA-1 of a git blob, matching `git hash-object`. */
export async function hashGitBlob(content: Uint8Array): Promise<string> {
    return sha1Hex(gitBlobStore(content));
}

export interface MemDirFs {
    analyzePath(path: string): { exists: boolean };
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
}

/**
 * Writes a zlib-compressed git blob into `gitDir/objects` and returns its
 * SHA-1. Existing objects are left untouched (blobs are immutable).
 */
export async function writeGitLooseBlob(
    fs: MemDirFs,
    gitDir: string,
    content: Uint8Array
): Promise<string> {
    const store = gitBlobStore(content);
    const hash = await sha1Hex(store);
    const objectPath = `${gitDir}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
    if (!fs.analyzePath(objectPath).exists) {
        ensureDir(fs, parentOf(objectPath));
        fs.writeFile(objectPath, await zlibDeflate(store));
    }
    return hash;
}

export async function zlibInflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();
    try {
        await writer.write(data);
        await writer.close();
    } catch (error) {
        writer.abort(error).catch(() => undefined);
        throw error;
    }
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new CompressionStream("deflate");
    const writer = stream.writable.getWriter();
    try {
        await writer.write(data);
        await writer.close();
    } catch (error) {
        writer.abort(error).catch(() => undefined);
        throw error;
    }
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export function toHex(bytes: Uint8Array): string {
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i]!.toString(16).padStart(2, "0");
    }
    return hex;
}

export function fromHex(hex: string): Uint8Array {
    if (hex.length !== 40 || !/^[0-9a-f]{40}$/i.test(hex)) {
        throw new Error(`invalid git object id '${hex}'`);
    }
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

export interface InflatedGitObject {
    type: string;
    payload: Uint8Array;
}

export async function inflateGitObject(
    compressed: Uint8Array
): Promise<InflatedGitObject> {
    const store = await zlibInflate(compressed);
    let split = -1;
    for (let i = 0; i < store.byteLength; i++) {
        if (store[i] === 0) {
            split = i;
            break;
        }
    }
    if (split < 0) {
        throw new Error("git object is missing a header");
    }
    const header = new TextDecoder("utf-8").decode(store.subarray(0, split));
    const space = header.indexOf(" ");
    const type = space === -1 ? header : header.slice(0, space);
    return { type, payload: store.subarray(split + 1) };
}

export interface GitTreeEntry {
    mode: number;
    name: string;
    hash: string;
}

export function parseGitTree(payload: Uint8Array): GitTreeEntry[] {
    const entries: GitTreeEntry[] = [];
    let offset = 0;
    const decoder = new TextDecoder("utf-8");
    while (offset < payload.byteLength) {
        let space = offset;
        while (space < payload.byteLength && payload[space] !== 0x20) {
            space += 1;
        }
        let nul = space;
        while (nul < payload.byteLength && payload[nul] !== 0) {
            nul += 1;
        }
        if (nul + 20 >= payload.byteLength) break;
        const mode = Number.parseInt(
            decoder.decode(payload.subarray(offset, space)),
            8
        );
        const name = decoder.decode(payload.subarray(space + 1, nul));
        const hash = toHex(payload.subarray(nul + 1, nul + 21));
        entries.push({ mode, name, hash });
        offset = nul + 21;
    }
    return entries;
}

function ensureDir(fs: MemDirFs, path: string): void {
    if (path === "" || path === "/" || fs.analyzePath(path).exists) return;
    ensureDir(fs, parentOf(path));
    fs.mkdir(path);
}

/** Runs `fn` over `items` with at most `concurrency` tasks in flight. */
export async function runPool<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index]!, index);
        }
    };
    const workers = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

function parentOf(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "" : path.substring(0, index);
}
