import { fromHex, sha1Hex, toHex } from "./gitObject";

/** Regular file, matching `core.filemode = false`. */
export const GIT_FILEMODE_BLOB = 0o100644;
/** Executable file. */
export const GIT_FILEMODE_BLOB_EXECUTABLE = 0o100755;
/** Symbolic link. */
export const GIT_FILEMODE_LINK = 0o120000;
/** Submodule gitlink. */
export const GIT_FILEMODE_COMMIT = 0o160000;

/** One stage-0 (or unmerged) entry from a git index file. */
export interface GitIndexEntry {
    path: string;
    /** Object id of the blob (or gitlink) in the index. */
    hash: string;
    size: number;
    /** Index-cached modification time, in Unix seconds. */
    mtimeSeconds: number;
    mtimeNanoseconds?: number;
    ctimeSeconds?: number;
    ctimeNanoseconds?: number;
    dev?: number;
    ino?: number;
    uid?: number;
    gid?: number;
    /** Merge stage: 0 is normal, 1–3 are unmerged sides. */
    stage: number;
    /** git file mode (e.g. 0o100644, or 0o160000 for a gitlink). */
    mode: number;
    assumeValid?: boolean;
    skipWorktree?: boolean;
    intentToAdd?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

const CE_NAMEMASK = 0x0fff;
const CE_STAGESHIFT = 12;
const CE_EXTENDED = 0x4000;
const CE_VALID = 0x8000;
const CE_INTENT_TO_ADD_EXT = 0x2000;
const CE_SKIP_WORKTREE_EXT = 0x4000;
const SPLIT_INDEX_SIG = "link";

/**
 * Parses a git index (`DIRC`) buffer.
 *
 * Versions 2, 3, and 4 are accepted. v4 is prefix-compressed and unpadded;
 * we still always write a clean v2/v3 index so wasm-git never has to load a
 * native-git v4 file. Split indexes (`link` extension) are rejected.
 */
export function parseGitIndex(data: Uint8Array): GitIndexEntry[] {
    if (data.byteLength < 32) {
        throw new Error("git index is truncated");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (readAscii(data, 0, 4) !== "DIRC") {
        throw new Error("not a git index (missing DIRC header)");
    }
    const version = view.getUint32(4, false);
    if (version !== 2 && version !== 3 && version !== 4) {
        throw new Error(`unsupported git index version ${version}`);
    }
    const count = view.getUint32(8, false);
    const checksumStart = data.byteLength - 20;
    const entries: GitIndexEntry[] = [];
    let offset = 12;
    let previousPath = new Uint8Array(0);
    for (let i = 0; i < count; i++) {
        const parsed = parseIndexEntry(
            data,
            view,
            offset,
            version,
            previousPath,
            checksumStart
        );
        entries.push(parsed.entry);
        offset = parsed.offset;
        previousPath = parsed.pathBytes;
    }
    skipIndexExtensions(data, view, offset, checksumStart);
    return entries;
}

export function isGitlink(mode: number): boolean {
    return (mode & 0xf000) === 0xe000;
}

/** Sort by UTF-8 path bytes, then merge stage, matching git's index order. */
export function compareIndexEntries(
    a: GitIndexEntry,
    b: GitIndexEntry
): number {
    const byPath = compareUtf8(a.path, b.path);
    if (byPath !== 0) return byPath;
    return a.stage - b.stage;
}

/**
 * Replaces every index entry for `path` (including conflict stages) with a
 * single stage-0 blob entry.
 */
export function upsertStagedFile(
    entries: GitIndexEntry[],
    entry: GitIndexEntry
): GitIndexEntry[] {
    const next = entries.filter((item) => item.path !== entry.path);
    next.push(entry);
    next.sort(compareIndexEntries);
    return next;
}

/** Drops every index entry for `path`, including conflict stages. */
export function removeIndexPath(
    entries: GitIndexEntry[],
    path: string
): GitIndexEntry[] {
    return entries.filter((entry) => entry.path !== path);
}

/**
 * Serializes a clean git index. Version 3 is used only when at least one
 * entry needs skip-worktree or intent-to-add; otherwise version 2. Native
 * extensions (cache-tree, untracked-cache, fsmonitor, split-index) are
 * omitted: wasm-git does not need them, and they crash it on a native index.
 */
export async function writeGitIndex(
    entries: GitIndexEntry[]
): Promise<Uint8Array> {
    const sorted = [...entries].sort(compareIndexEntries);
    const needsV3 = sorted.some(
        (entry) => entry.skipWorktree === true || entry.intentToAdd === true
    );
    const version = needsV3 ? 3 : 2;
    const encoded = sorted.map((entry) => encodeIndexEntry(entry, version));
    const bodySize = encoded.reduce((sum, item) => sum + item.byteLength, 0);
    const data = new Uint8Array(12 + bodySize + 20);
    const view = new DataView(data.buffer);
    data[0] = 0x44; // D
    data[1] = 0x49; // I
    data[2] = 0x52; // R
    data[3] = 0x43; // C
    view.setUint32(4, version, false);
    view.setUint32(8, sorted.length, false);
    let offset = 12;
    for (const bytes of encoded) {
        data.set(bytes, offset);
        offset += bytes.byteLength;
    }
    const digest = await sha1Hex(data.subarray(0, offset));
    data.set(fromHex(digest), offset);
    return data;
}

function parseIndexEntry(
    data: Uint8Array,
    view: DataView,
    offset: number,
    version: number,
    previousPath: Uint8Array,
    checksumStart: number
): { entry: GitIndexEntry; offset: number; pathBytes: Uint8Array } {
    const start = offset;
    if (start + 62 > checksumStart) {
        throw new Error("git index is truncated");
    }
    const ctimeSeconds = view.getUint32(start, false);
    const ctimeNanoseconds = view.getUint32(start + 4, false);
    const mtimeSeconds = view.getUint32(start + 8, false);
    const mtimeNanoseconds = view.getUint32(start + 12, false);
    const dev = view.getUint32(start + 16, false);
    const ino = view.getUint32(start + 20, false);
    const mode = view.getUint32(start + 24, false);
    const uid = view.getUint32(start + 28, false);
    const gid = view.getUint32(start + 32, false);
    const size = view.getUint32(start + 36, false);
    const hash = toHex(data.subarray(start + 40, start + 60));
    const flags = view.getUint16(start + 60, false);
    const assumeValid = (flags & CE_VALID) !== 0;
    const extended = (flags & CE_EXTENDED) !== 0;
    const stage = (flags >> CE_STAGESHIFT) & 0x3;
    const nameLength = flags & CE_NAMEMASK;
    offset = start + 62;
    let skipWorktree = false;
    let intentToAdd = false;
    if (extended) {
        if (version < 3) {
            throw new Error("extended index entry in a v2 index");
        }
        if (offset + 2 > checksumStart) {
            throw new Error("git index is truncated");
        }
        const extra = view.getUint16(offset, false);
        offset += 2;
        intentToAdd = (extra & CE_INTENT_TO_ADD_EXT) !== 0;
        skipWorktree = (extra & CE_SKIP_WORKTREE_EXT) !== 0;
    }
    let pathBytes: Uint8Array;
    if (version === 4) {
        const strip = decodeGitVarint(data, offset, checksumStart);
        offset = strip.next;
        const end = findNull(data, offset, checksumStart);
        const remainder = data.subarray(offset, end);
        offset = end + 1;
        if (strip.value > previousPath.byteLength) {
            throw new Error(
                "git index v4 path prefix is longer than previous path"
            );
        }
        const prefixLen = previousPath.byteLength - strip.value;
        pathBytes = new Uint8Array(prefixLen + remainder.byteLength);
        pathBytes.set(previousPath.subarray(0, prefixLen));
        pathBytes.set(remainder, prefixLen);
    } else if (nameLength === CE_NAMEMASK) {
        const end = findNull(data, offset, checksumStart);
        pathBytes = data.slice(offset, end);
        offset = end + 1;
    } else {
        if (offset + nameLength + 1 > checksumStart) {
            throw new Error("git index is truncated");
        }
        pathBytes = data.slice(offset, offset + nameLength);
        offset += nameLength + 1;
    }
    if (version !== 4) {
        const unpadded = offset - start;
        offset = start + Math.ceil(unpadded / 8) * 8;
        if (offset > checksumStart) {
            throw new Error("git index is truncated");
        }
    }
    return {
        entry: {
            path: decodePath(pathBytes),
            hash,
            size,
            mtimeSeconds,
            mtimeNanoseconds,
            ctimeSeconds,
            ctimeNanoseconds,
            dev,
            ino,
            uid,
            gid,
            stage,
            mode,
            assumeValid,
            skipWorktree,
            intentToAdd,
        },
        offset,
        pathBytes,
    };
}

function encodeIndexEntry(entry: GitIndexEntry, version: number): Uint8Array {
    const pathBytes = encoder.encode(entry.path);
    const extended =
        version >= 3 &&
        (entry.skipWorktree === true || entry.intentToAdd === true);
    const header = 62 + (extended ? 2 : 0);
    const unpadded = header + pathBytes.byteLength + 1;
    const padded = Math.ceil(unpadded / 8) * 8;
    const data = new Uint8Array(padded);
    const view = new DataView(data.buffer);
    const ctime = entry.ctimeSeconds ?? entry.mtimeSeconds;
    view.setUint32(0, ctime, false);
    view.setUint32(4, entry.ctimeNanoseconds ?? 0, false);
    view.setUint32(8, entry.mtimeSeconds, false);
    view.setUint32(12, entry.mtimeNanoseconds ?? 0, false);
    view.setUint32(16, entry.dev ?? 0, false);
    view.setUint32(20, entry.ino ?? 0, false);
    view.setUint32(24, entry.mode, false);
    view.setUint32(28, entry.uid ?? 0, false);
    view.setUint32(32, entry.gid ?? 0, false);
    view.setUint32(36, entry.size, false);
    data.set(fromHex(entry.hash), 40);
    let flags =
        ((entry.stage & 0x3) << CE_STAGESHIFT) |
        Math.min(pathBytes.byteLength, CE_NAMEMASK);
    if (entry.assumeValid === true) flags |= CE_VALID;
    if (extended) flags |= CE_EXTENDED;
    view.setUint16(60, flags, false);
    let offset = 62;
    if (extended) {
        let extra = 0;
        if (entry.intentToAdd === true) extra |= CE_INTENT_TO_ADD_EXT;
        if (entry.skipWorktree === true) extra |= CE_SKIP_WORKTREE_EXT;
        view.setUint16(offset, extra, false);
        offset += 2;
    }
    data.set(pathBytes, offset);
    data[offset + pathBytes.byteLength] = 0;
    return data;
}

function skipIndexExtensions(
    data: Uint8Array,
    view: DataView,
    offset: number,
    checksumStart: number
): void {
    while (offset + 8 <= checksumStart) {
        const signature = readAscii(data, offset, 4);
        const size = view.getUint32(offset + 4, false);
        offset += 8;
        if (offset + size > checksumStart) {
            throw new Error(`git index extension '${signature}' is truncated`);
        }
        if (signature === SPLIT_INDEX_SIG) {
            throw new Error(
                "split git indexes are not supported; run `git update-index --no-split-index`"
            );
        }
        offset += size;
    }
    if (offset !== checksumStart) {
        throw new Error("git index has trailing garbage before checksum");
    }
}

/**
 * Git's cache-entry varint: 7 data bits per byte, continuation in the high
 * bit, and a +1 between bytes so the encoding is unambiguous.
 */
export function decodeGitVarint(
    data: Uint8Array,
    offset: number,
    end: number
): { value: number; next: number } {
    if (offset >= end) {
        throw new Error("unterminated git varint");
    }
    let current = data[offset]!;
    let value = current & 127;
    let next = offset + 1;
    while (current & 128) {
        value += 1;
        if (next >= end) {
            throw new Error("unterminated git varint");
        }
        current = data[next]!;
        next += 1;
        value = (value << 7) + (current & 127);
    }
    return { value, next };
}

function compareUtf8(a: string, b: string): number {
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
        const delta = left[i]! - right[i]!;
        if (delta !== 0) return delta;
    }
    return left.length - right.length;
}

function readAscii(data: Uint8Array, start: number, length: number): string {
    return String.fromCharCode(...data.subarray(start, start + length));
}

function findNull(data: Uint8Array, start: number, end: number): number {
    const found = data.indexOf(0, start);
    if (found < 0 || found >= end) {
        throw new Error("unterminated path in git index");
    }
    return found;
}

function decodePath(bytes: Uint8Array): string {
    return decoder.decode(bytes);
}
