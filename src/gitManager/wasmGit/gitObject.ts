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
