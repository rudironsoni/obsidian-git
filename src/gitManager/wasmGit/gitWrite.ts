import type { GitIndexEntry } from "./gitIndex";
import { fromHex, sha1Hex, zlibDeflate, type GitTreeEntry } from "./gitObject";

const encoder = new TextEncoder();
export const GIT_FILEMODE_TREE = 0o040000;

export async function gitObjectStore(
    type: string,
    payload: Uint8Array
): Promise<{ hash: string; compressed: Uint8Array }> {
    const header = encoder.encode(`${type} ${payload.byteLength}\0`);
    const store = new Uint8Array(header.byteLength + payload.byteLength);
    store.set(header);
    store.set(payload, header.byteLength);
    return {
        hash: await sha1Hex(store),
        compressed: await zlibDeflate(store),
    };
}

/** Git sorts tree names with a trailing slash on directories. */
export function compareGitTreeEntries(
    a: GitTreeEntry,
    b: GitTreeEntry
): number {
    const left = gitTreeSortKey(a);
    const right = gitTreeSortKey(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function gitTreeSortKey(entry: GitTreeEntry): string {
    const isTree = (entry.mode & 0o170000) === 0o040000;
    return isTree ? `${entry.name}/` : entry.name;
}

export function serializeGitTree(entries: GitTreeEntry[]): Uint8Array {
    const sorted = [...entries].sort(compareGitTreeEntries);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (const entry of sorted) {
        const prefix = encoder.encode(
            `${entry.mode.toString(8)} ${entry.name}\0`
        );
        const hash = fromHex(entry.hash);
        const chunk = new Uint8Array(prefix.byteLength + 20);
        chunk.set(prefix);
        chunk.set(hash, prefix.byteLength);
        chunks.push(chunk);
        size += chunk.byteLength;
    }
    const payload = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return payload;
}

export interface GitSignature {
    name: string;
    email: string;
    epochSeconds: number;
    tz: string;
}

export function serializeGitCommit(args: {
    tree: string;
    parents: string[];
    author: GitSignature;
    committer: GitSignature;
    message: string;
}): Uint8Array {
    const lines = [`tree ${args.tree}`];
    for (const parent of args.parents) {
        lines.push(`parent ${parent}`);
    }
    lines.push(`author ${formatSignature(args.author)}`);
    lines.push(`committer ${formatSignature(args.committer)}`);
    const message = args.message.endsWith("\n")
        ? args.message
        : `${args.message}\n`;
    return encoder.encode(`${lines.join("\n")}\n\n${message}`);
}

function formatSignature(sig: GitSignature): string {
    return `${sig.name} <${sig.email}> ${sig.epochSeconds} ${sig.tz}`;
}

export function gitTimezoneOffset(date = new Date()): string {
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const abs = Math.abs(offset);
    const hours = String(Math.floor(abs / 60)).padStart(2, "0");
    const minutes = String(abs % 60).padStart(2, "0");
    return `${sign}${hours}${minutes}`;
}

interface TreeNode {
    blobs: GitTreeEntry[];
    dirs: Map<string, TreeNode>;
}

/**
 * Writes a git tree from stage-0 index entries, creating one tree object
 * per directory. Does not read the previous HEAD tree.
 */
export async function writeTreeFromIndex(
    entries: readonly GitIndexEntry[],
    writeObject: (type: string, payload: Uint8Array) => Promise<string>
): Promise<string> {
    const root: TreeNode = { blobs: [], dirs: new Map() };
    for (const entry of entries) {
        if (entry.stage !== 0) continue;
        insertIndexEntry(root, entry.path.split("/"), entry);
    }
    return writeTreeNode(root, writeObject);
}

function insertIndexEntry(
    node: TreeNode,
    parts: string[],
    entry: GitIndexEntry
): void {
    if (parts.length === 0) return;
    const name = parts[0]!;
    if (parts.length === 1) {
        node.blobs.push({
            mode: entry.mode,
            name,
            hash: entry.hash,
        });
        return;
    }
    let child = node.dirs.get(name);
    if (child == undefined) {
        child = { blobs: [], dirs: new Map() };
        node.dirs.set(name, child);
    }
    insertIndexEntry(child, parts.slice(1), entry);
}

async function writeTreeNode(
    node: TreeNode,
    writeObject: (type: string, payload: Uint8Array) => Promise<string>
): Promise<string> {
    const entries: GitTreeEntry[] = [...node.blobs];
    for (const [name, child] of node.dirs) {
        const hash = await writeTreeNode(child, writeObject);
        entries.push({ mode: GIT_FILEMODE_TREE, name, hash });
    }
    return writeObject("tree", serializeGitTree(entries));
}

export function parseGitConfigValue(
    content: string,
    dottedKey: string
): string | undefined {
    const dot = dottedKey.indexOf(".");
    if (dot <= 0) return undefined;
    const sectionName = dottedKey.slice(0, dot).toLowerCase();
    const keyName = dottedKey.slice(dot + 1).toLowerCase();
    let inSection = false;
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#") || line.startsWith(";")) {
            continue;
        }
        const section = line.match(/^\[([^\]]+)\]$/);
        if (section) {
            inSection =
                section[1]!.split(/\s/)[0]!.toLowerCase() === sectionName;
            continue;
        }
        if (!inSection) continue;
        const kv = line.match(/^([^=]+)=(.*)$/);
        if (!kv) continue;
        if (kv[1]!.trim().toLowerCase() === keyName) {
            return unwrapGitConfigValue(kv[2]!.trim());
        }
    }
    return undefined;
}

function unwrapGitConfigValue(value: string): string {
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
    ) {
        return value.slice(1, -1);
    }
    return value;
}

export function countIndexDiff(
    index: ReadonlyMap<string, GitIndexEntry>,
    headBlobs: ReadonlyMap<string, string> | undefined
): number {
    if (headBlobs == undefined) {
        return [...index.values()].filter((entry) => entry.stage === 0).length;
    }
    let n = 0;
    for (const [path, entry] of index) {
        if (entry.stage !== 0) continue;
        if (headBlobs.get(path) !== entry.hash) n += 1;
    }
    for (const path of headBlobs.keys()) {
        const entry = index.get(path);
        if (entry == undefined || entry.stage !== 0) n += 1;
    }
    return n;
}

export function looseObjectVaultPath(
    gitDirVaultPath: string,
    hash: string
): string {
    return `${gitDirVaultPath}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
}
