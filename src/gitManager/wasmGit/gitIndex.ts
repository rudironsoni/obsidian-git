/** One stage-0 (or unmerged) entry from a git index file. */
export interface GitIndexEntry {
    path: string;
    /** Object id of the blob in the index. */
    hash: string;
    size: number;
    /** Index-cached modification time, in Unix seconds. */
    mtimeSeconds: number;
    /** Merge stage: 0 is normal, 1–3 are unmerged sides. */
    stage: number;
}

/**
 * Parses a git index (`DIRC`) buffer.
 *
 * Only versions 2 and 3 are supported: those are what git writes by default
 * and what wasm-git produces. The path, size, mtime, and object id are
 * enough to decide whether a vault file matches the index without copying
 * the file into the in-memory worktree.
 */
export function parseGitIndex(data: Uint8Array): GitIndexEntry[] {
    if (data.byteLength < 12) {
        throw new Error("git index is truncated");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (readAscii(data, 0, 4) !== "DIRC") {
        throw new Error("not a git index (missing DIRC header)");
    }
    const version = view.getUint32(4, false);
    if (version !== 2 && version !== 3) {
        throw new Error(`unsupported git index version ${version}`);
    }
    const count = view.getUint32(8, false);
    const entries: GitIndexEntry[] = [];
    let offset = 12;
    for (let i = 0; i < count; i++) {
        const start = offset;
        if (start + 62 > data.byteLength) {
            throw new Error("git index is truncated");
        }
        const mtimeSeconds = view.getUint32(start + 8, false);
        const mode = view.getUint32(start + 24, false);
        const size = view.getUint32(start + 36, false);
        const hash = toHex(data.subarray(start + 40, start + 60));
        const flags = view.getUint16(start + 60, false);
        const stage = (flags >> 12) & 0x3;
        offset = start + 62;
        const extended = (flags & 0x4000) !== 0;
        if (extended) {
            if (version < 3) {
                throw new Error("extended index entry in a v2 index");
            }
            offset += 2;
        }
        const nameLength = flags & 0x0fff;
        let path: string;
        if (nameLength === 0x0fff) {
            const end = findNull(data, offset);
            path = decodePath(data.subarray(offset, end));
            offset = end + 1;
        } else {
            path = decodePath(data.subarray(offset, offset + nameLength));
            offset += nameLength + 1;
        }
        // Entries are padded to an 8-byte multiple from their start.
        const unpadded = offset - start;
        offset = start + Math.ceil(unpadded / 8) * 8;
        // gitlinks (submodules) are not files we can hash against the vault.
        if ((mode & 0xf000) === 0xe000) continue;
        entries.push({ path, hash, size, mtimeSeconds, stage });
    }
    return entries;
}

function readAscii(data: Uint8Array, start: number, length: number): string {
    return String.fromCharCode(...data.subarray(start, start + length));
}

function findNull(data: Uint8Array, start: number): number {
    const end = data.indexOf(0, start);
    if (end < 0) throw new Error("unterminated path in git index");
    return end;
}

function decodePath(bytes: Uint8Array): string {
    return new TextDecoder("utf-8").decode(bytes);
}

function toHex(bytes: Uint8Array): string {
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i]!.toString(16).padStart(2, "0");
    }
    return hex;
}
