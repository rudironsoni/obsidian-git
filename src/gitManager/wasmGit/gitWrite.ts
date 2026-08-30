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

/**
 * Builds the commit trees in memory and returns every new object. The
 * caller writes them to the vault. SHA-1 and zlib run in a worker.
 */
export async function writeTreeObjects(
    entries: readonly GitIndexEntry[]
): Promise<{
    tree: string;
    objects: { hash: string; compressed: Uint8Array }[];
}> {
    const objects: { hash: string; compressed: Uint8Array }[] = [];
    const seen = new Set<string>();
    const tree = await writeTreeFromIndex(entries, async (type, payload) => {
        const stored = await gitObjectStore(type, payload);
        if (!seen.has(stored.hash)) {
            seen.add(stored.hash);
            objects.push(stored);
        }
        return stored.hash;
    });
    return { tree, objects };
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
    const parsedKey = splitGitConfigKey(dottedKey);
    if (parsedKey == undefined) return undefined;
    let inSection = false;
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#") || line.startsWith(";")) {
            continue;
        }
        const section = parseGitConfigSectionHeader(line);
        if (section) {
            inSection =
                section.section === parsedKey.section &&
                section.subsection === parsedKey.subsection;
            continue;
        }
        if (!inSection) continue;
        const kv = line.match(/^([^=]+)=(.*)$/);
        if (!kv) continue;
        if (kv[1]!.trim().toLowerCase() === parsedKey.key) {
            return unwrapGitConfigValue(kv[2]!.trim());
        }
    }
    return undefined;
}

/** Subsection names under `[section "name"]`, e.g. remotes. */
export function listGitConfigSubsections(
    content: string,
    sectionName: string
): string[] {
    const wanted = sectionName.toLowerCase();
    const names: string[] = [];
    const seen = new Set<string>();
    for (const raw of content.split("\n")) {
        const section = parseGitConfigSectionHeader(raw.trim());
        if (!section || section.section !== wanted || !section.subsection) {
            continue;
        }
        if (seen.has(section.subsection)) continue;
        seen.add(section.subsection);
        names.push(section.subsection);
    }
    return names;
}

function splitGitConfigKey(
    dottedKey: string
):
    | { section: string; subsection: string | undefined; key: string }
    | undefined {
    const parts = dottedKey.split(".");
    if (parts.length < 2) return undefined;
    const section = parts[0]!.toLowerCase();
    const key = parts[parts.length - 1]!.toLowerCase();
    if (!section || !key) return undefined;
    const subsection =
        parts.length === 2 ? undefined : parts.slice(1, -1).join(".");
    return { section, subsection, key };
}

function parseGitConfigSectionHeader(
    line: string
): { section: string; subsection: string | undefined } | undefined {
    const quoted = line.match(/^\[([^\s\]]+)\s+"(.*)"\]$/);
    if (quoted) {
        return { section: quoted[1]!.toLowerCase(), subsection: quoted[2] };
    }
    const dotted = line.match(/^\[([^\s.\]]+)\.([^\]]+)\]$/);
    if (dotted) {
        return { section: dotted[1]!.toLowerCase(), subsection: dotted[2] };
    }
    const plain = line.match(/^\[([^\s\]]+)\]$/);
    if (plain) {
        return { section: plain[1]!.toLowerCase(), subsection: undefined };
    }
    return undefined;
}

export function upsertGitConfigValue(
    content: string,
    dottedKey: string,
    value: string
): string {
    const parsedKey = splitGitConfigKey(dottedKey);
    if (parsedKey == undefined) return content;
    const lines = content.split("\n");
    let inSection = false;
    let sectionIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        const section = parseGitConfigSectionHeader(line);
        if (section) {
            inSection =
                section.section === parsedKey.section &&
                section.subsection === parsedKey.subsection;
            if (inSection) sectionIndex = i;
            continue;
        }
        if (!inSection) continue;
        const kv = line.match(/^([^=]+)=(.*)$/);
        if (!kv) continue;
        if (kv[1]!.trim().toLowerCase() !== parsedKey.key) continue;
        const indent = lines[i]!.match(/^\s*/)?.[0] ?? "\t";
        lines[i] = `${indent}${kv[1]!.trim()} = ${value}`;
        return joinGitConfigLines(lines);
    }
    const assignment = `\t${parsedKey.key} = ${value}`;
    if (sectionIndex >= 0) {
        lines.splice(sectionIndex + 1, 0, assignment);
        return joinGitConfigLines(lines);
    }
    const header = parsedKey.subsection
        ? `[${parsedKey.section} "${parsedKey.subsection}"]`
        : `[${parsedKey.section}]`;
    const suffix = content.trim().length === 0 ? [] : [""];
    const trimmed =
        lines.length > 0 && lines[lines.length - 1] === ""
            ? lines.slice(0, -1)
            : lines;
    return joinGitConfigLines([...trimmed, ...suffix, header, assignment, ""]);
}

export function removeGitConfigSection(
    content: string,
    sectionName: string,
    subsection?: string
): string {
    const wanted = sectionName.toLowerCase();
    const lines = content.split("\n");
    const kept: string[] = [];
    let skipping = false;
    for (const raw of lines) {
        const section = parseGitConfigSectionHeader(raw.trim());
        if (section) {
            skipping =
                section.section === wanted && section.subsection === subsection;
            if (skipping) continue;
        }
        if (skipping) continue;
        kept.push(raw);
    }
    return joinGitConfigLines(kept);
}

function joinGitConfigLines(lines: string[]): string {
    let text = lines.join("\n");
    if (!text.endsWith("\n")) text += "\n";
    return text.replace(/\n{3,}/g, "\n\n");
}

export function parsePackedRefs(content: string): Map<string, string> {
    const refs = new Map<string, string>();
    for (const line of content.split("\n")) {
        if (line.startsWith("#") || line.startsWith("^")) continue;
        const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/i);
        if (!match) continue;
        refs.set(match[2]!, match[1]!.toLowerCase());
    }
    return refs;
}

/** Unix seconds from a reflog line, or undefined if the line is not a reflog. */
export function parseReflogUnixSeconds(line: string): number | undefined {
    const match = line.match(
        /^[0-9a-f]{40} [0-9a-f]{40} .* (\d+) [+-]\d{4}\t/i
    );
    if (!match) return undefined;
    const epoch = Number.parseInt(match[1]!, 10);
    return Number.isFinite(epoch) ? epoch : undefined;
}

export function countUnpushedFromReflog(
    content: string,
    trackingHash: string
): number | undefined {
    const wanted = trackingHash.toLowerCase();
    const lines = content.split("\n").filter((line) => line.length > 0);
    let count = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i]!.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) /i);
        if (!match) continue;
        const oldHash = match[1]!.toLowerCase();
        const newHash = match[2]!.toLowerCase();
        if (newHash === wanted) return count;
        count += 1;
        if (oldHash === wanted) return count;
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
