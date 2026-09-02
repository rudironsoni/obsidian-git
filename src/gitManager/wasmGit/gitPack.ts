import { toHex, zlibInflate, type InflatedGitObject } from "./gitObject";

const IDX_V2_MAGIC = 0xff744f63;
const OBJ_COMMIT = 1;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_NAME = ["", "commit", "tree", "blob", "tag"] as const;

export type PackReader = (vaultPath: string) => Promise<Uint8Array>;

export interface PackPair {
    idxPath: string;
    packPath: string;
}

interface LoadedPack {
    pack: Uint8Array;
    offsetByHash: Map<string, number>;
    sortedOffsets: number[];
}

/** Pack `.idx` / `.pack` pairs from a vault `objects/pack` listing. */
export function listPackPairs(files: readonly string[]): PackPair[] {
    const packs = new Set(files.filter((file) => file.endsWith(".pack")));
    const pairs: PackPair[] = [];
    for (const file of files) {
        if (!file.endsWith(".idx")) continue;
        const packPath = `${file.slice(0, -4)}.pack`;
        if (packs.has(packPath)) {
            pairs.push({ idxPath: file, packPath });
        }
    }
    return pairs;
}

/**
 * Reads git objects out of pack files using the matching idx.
 * Pack bytes stay in memory for the plugin session.
 */
export class GitPackStore {
    private readonly loaded = new Map<string, LoadedPack>();
    private readonly objects = new Map<string, InflatedGitObject>();

    async get(
        hash: string,
        packs: readonly PackPair[],
        read: PackReader
    ): Promise<InflatedGitObject | undefined> {
        const key = hash.toLowerCase();
        const cached = this.objects.get(key);
        if (cached) return cached;
        for (const pair of packs) {
            const pack = await this.loadPack(pair, read);
            if (pack == undefined) continue;
            if (!pack.offsetByHash.has(key)) continue;
            const object = await this.readAtHash(pack, key, new Set());
            if (object) this.objects.set(key, object);
            return object;
        }
        return undefined;
    }

    clear(): void {
        this.loaded.clear();
        this.objects.clear();
    }

    private async loadPack(
        pair: PackPair,
        read: PackReader
    ): Promise<LoadedPack | undefined> {
        const existing = this.loaded.get(pair.packPath);
        if (existing) return existing;
        try {
            const idx = await read(pair.idxPath);
            const pack = await read(pair.packPath);
            const offsetByHash = parsePackIndex(idx);
            if (offsetByHash.size === 0) return undefined;
            const sortedOffsets = [...new Set(offsetByHash.values())].sort(
                (a, b) => a - b
            );
            const loaded: LoadedPack = { pack, offsetByHash, sortedOffsets };
            this.loaded.set(pair.packPath, loaded);
            return loaded;
        } catch {
            return undefined;
        }
    }

    private async readAtHash(
        pack: LoadedPack,
        hash: string,
        walking: Set<string>
    ): Promise<InflatedGitObject | undefined> {
        const cached = this.objects.get(hash);
        if (cached) return cached;
        if (walking.has(hash)) return undefined;
        const offset = pack.offsetByHash.get(hash);
        if (offset == undefined) return undefined;
        walking.add(hash);
        const object = await this.readAtOffset(pack, offset, walking);
        if (object) this.objects.set(hash, object);
        return object;
    }

    private async readAtOffset(
        pack: LoadedPack,
        offset: number,
        walking: Set<string>
    ): Promise<InflatedGitObject | undefined> {
        const meta = parsePackedObject(pack.pack, offset);
        if (meta == undefined) return undefined;
        const zlibEnd = nextPackOffset(
            pack.sortedOffsets,
            offset,
            pack.pack.byteLength
        );
        let inflated: Uint8Array;
        try {
            inflated = await zlibInflate(
                pack.pack.subarray(meta.zlibStart, zlibEnd)
            );
        } catch {
            return undefined;
        }
        if (meta.type >= OBJ_COMMIT && meta.type <= OBJ_TAG) {
            return { type: TYPE_NAME[meta.type]!, payload: inflated };
        }
        const base =
            meta.type === OBJ_OFS_DELTA && meta.baseOffset != undefined
                ? await this.readAtOffset(pack, meta.baseOffset, walking)
                : meta.type === OBJ_REF_DELTA && meta.baseHash != undefined
                  ? await this.readAtHash(pack, meta.baseHash, walking)
                  : undefined;
        if (base == undefined) return undefined;
        try {
            return {
                type: base.type,
                payload: applyGitDelta(base.payload, inflated),
            };
        } catch {
            return undefined;
        }
    }
}

export function parsePackIndex(idx: Uint8Array): Map<string, number> {
    if (idx.byteLength < 1028) return new Map();
    if (readU32(idx, 0) === IDX_V2_MAGIC) return parsePackIndexV2(idx);
    return parsePackIndexV1(idx);
}

/**
 * Git binary delta: copy/insert opcodes against a base object.
 * See Documentation/technical/pack-format.txt.
 */
export function applyGitDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
    let pos = 0;
    const sourceSize = readDeltaSize(delta, () => pos++);
    const targetSize = readDeltaSize(delta, () => pos++);
    if (sourceSize !== base.byteLength) {
        throw new Error("git delta source size does not match the base");
    }
    const target = new Uint8Array(targetSize);
    let out = 0;
    while (pos < delta.byteLength) {
        const opcode = delta[pos++]!;
        if (opcode & 0x80) {
            let copyOffset = 0;
            let copySize = 0;
            if (opcode & 0x01) copyOffset |= delta[pos++]!;
            if (opcode & 0x02) copyOffset |= (delta[pos++]! << 8) >>> 0;
            if (opcode & 0x04) copyOffset |= (delta[pos++]! << 16) >>> 0;
            if (opcode & 0x08) copyOffset += (delta[pos++]! ?? 0) * 0x1000000;
            if (opcode & 0x10) copySize |= delta[pos++]!;
            if (opcode & 0x20) copySize |= (delta[pos++]! << 8) >>> 0;
            if (opcode & 0x40) copySize |= (delta[pos++]! << 16) >>> 0;
            if (copySize === 0) copySize = 0x10000;
            if (
                copyOffset + copySize > base.byteLength ||
                out + copySize > target.byteLength
            ) {
                throw new Error("git delta copy is out of bounds");
            }
            target.set(base.subarray(copyOffset, copyOffset + copySize), out);
            out += copySize;
        } else if (opcode !== 0) {
            if (
                pos + opcode > delta.byteLength ||
                out + opcode > target.byteLength
            ) {
                throw new Error("git delta insert is out of bounds");
            }
            target.set(delta.subarray(pos, pos + opcode), out);
            pos += opcode;
            out += opcode;
        } else {
            throw new Error("git delta opcode 0 is reserved");
        }
    }
    if (out !== targetSize) {
        throw new Error("git delta output size does not match the header");
    }
    return target;
}

function parsePackIndexV2(idx: Uint8Array): Map<string, number> {
    if (readU32(idx, 4) !== 2) return new Map();
    const count = readU32(idx, 8 + 255 * 4);
    const namesOff = 8 + 1024;
    const crcOff = namesOff + count * 20;
    const offOff = crcOff + count * 4;
    const largeOff = offOff + count * 4;
    if (idx.byteLength < largeOff) return new Map();
    const map = new Map<string, number>();
    for (let i = 0; i < count; i++) {
        const hash = toHex(
            idx.subarray(namesOff + i * 20, namesOff + i * 20 + 20)
        );
        const raw = readU32(idx, offOff + i * 4);
        if (raw & 0x80000000) {
            const largeIndex = raw & 0x7fffffff;
            const offset = readU64(idx, largeOff + largeIndex * 8);
            if (offset == undefined) return new Map();
            map.set(hash, offset);
        } else {
            map.set(hash, raw);
        }
    }
    return map;
}

function parsePackIndexV1(idx: Uint8Array): Map<string, number> {
    const count = readU32(idx, 255 * 4);
    const entriesOff = 1024;
    if (idx.byteLength < entriesOff + count * 24 + 40) return new Map();
    const map = new Map<string, number>();
    for (let i = 0; i < count; i++) {
        const entry = entriesOff + i * 24;
        const offset = readU32(idx, entry);
        const hash = toHex(idx.subarray(entry + 4, entry + 24));
        map.set(hash, offset);
    }
    return map;
}

function parsePackedObject(
    pack: Uint8Array,
    offset: number
):
    | {
          type: number;
          zlibStart: number;
          baseOffset?: number;
          baseHash?: string;
      }
    | undefined {
    if (offset < 12 || offset >= pack.byteLength) return undefined;
    let pos = offset;
    let byte = pack[pos++]!;
    const type = (byte >> 4) & 7;
    let shift = 4;
    while (byte & 0x80) {
        if (pos >= pack.byteLength) return undefined;
        byte = pack[pos++]!;
        shift += 7;
        if (shift > 32) return undefined;
    }
    if (type === OBJ_OFS_DELTA) {
        if (pos >= pack.byteLength) return undefined;
        byte = pack[pos++]!;
        let baseOffset = byte & 0x7f;
        while (byte & 0x80) {
            if (pos >= pack.byteLength) return undefined;
            byte = pack[pos++]!;
            baseOffset += 1;
            baseOffset = baseOffset * 128 + (byte & 0x7f);
        }
        if (baseOffset <= 0 || baseOffset > offset) return undefined;
        return {
            type,
            zlibStart: pos,
            baseOffset: offset - baseOffset,
        };
    }
    if (type === OBJ_REF_DELTA) {
        if (pos + 20 > pack.byteLength) return undefined;
        return {
            type,
            zlibStart: pos + 20,
            baseHash: toHex(pack.subarray(pos, pos + 20)),
        };
    }
    if (type < OBJ_COMMIT || type > OBJ_TAG) return undefined;
    return { type, zlibStart: pos };
}

function nextPackOffset(
    sorted: readonly number[],
    offset: number,
    packLength: number
): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid]! <= offset) lo = mid + 1;
        else hi = mid;
    }
    const packEnd = packLength >= 20 ? packLength - 20 : packLength;
    return lo < sorted.length ? sorted[lo]! : packEnd;
}

function readDeltaSize(delta: Uint8Array, next: () => number): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
        const index = next();
        if (index >= delta.byteLength) {
            throw new Error("git delta size is truncated");
        }
        byte = delta[index]!;
        result += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return result;
}

function readU32(data: Uint8Array, offset: number): number {
    return (
        ((data[offset]! << 24) |
            (data[offset + 1]! << 16) |
            (data[offset + 2]! << 8) |
            data[offset + 3]!) >>>
        0
    );
}

function readU64(data: Uint8Array, offset: number): number | undefined {
    if (offset + 8 > data.byteLength) return undefined;
    const hi = readU32(data, offset);
    const lo = readU32(data, offset + 4);
    if (hi > 0x1fffff) return undefined;
    return hi * 0x100000000 + lo;
}
