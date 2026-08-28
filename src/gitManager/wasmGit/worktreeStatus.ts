import type { FileStatusResult, Status } from "../../types";
import type { GitIndexEntry } from "./gitIndex";
import type { GitIgnore } from "./gitIgnore";
import type { ParsedNameStatusEntry } from "./parsers";
import type { MirrorAdapter } from "./vaultMirror";

export { hashGitBlob } from "./gitObject";

export interface VaultFileMeta {
    size: number;
    mtimeMs: number;
}

/**
 * Walks the vault worktree collecting file metadata and `.gitignore` paths.
 *
 * File contents are never read: that is the whole point of this walk. The
 * caller hashes an individual file only when the index size matches but the
 * mtime does not, so peak memory stays at one file plus the `.git` mirror.
 */
/**
 * Obsidian's vault adapter uses `""` for the vault root. `"/"` is not a
 * vault path and can miss every file during status.
 */
export function vaultListPath(dir: string): string {
    return dir === "/" ? "" : dir;
}

export async function walkWorktreeMeta(
    adapter: MirrorAdapter,
    worktreeRoot: string,
    opts: {
        exclude: (relativePath: string) => boolean;
        ignore: GitIgnore;
        /** Paths that must be included even if a gitignore rule matches. */
        keep: (relativePath: string) => boolean;
        readText: (vaultPath: string) => Promise<string>;
    }
): Promise<Map<string, VaultFileMeta>> {
    const files = new Map<string, VaultFileMeta>();
    const root = vaultListPath(worktreeRoot);
    if (!(await adapter.exists(root))) {
        return files;
    }
    const pending: string[] = [root];
    while (pending.length > 0) {
        const dir = pending.pop()!;
        const listing = await adapter.list(vaultListPath(dir));
        const relativeDir = toRelative(worktreeRoot, dir || "");
        const gitignore = listing.files.find(
            (file) => toRelative(worktreeRoot, file) === joinIgnore(relativeDir)
        );
        if (gitignore) {
            opts.ignore.addFile(relativeDir, await opts.readText(gitignore));
        }
        for (const folder of listing.folders) {
            const relativePath = toRelative(worktreeRoot, folder);
            if (opts.exclude(relativePath)) continue;
            if (
                opts.ignore.canSkipDirectory(relativePath) &&
                !opts.keep(relativePath)
            ) {
                continue;
            }
            pending.push(folder);
        }
        for (const file of listing.files) {
            const relativePath = toRelative(worktreeRoot, file);
            if (opts.exclude(relativePath)) continue;
            if (
                opts.ignore.ignoresPathOrParent(relativePath) &&
                !opts.keep(relativePath)
            ) {
                continue;
            }
            const stat = await adapter.stat(file);
            if (stat?.type !== "file") continue;
            files.set(relativePath, {
                size: stat.size,
                mtimeMs: stat.mtime,
            });
        }
    }
    return files;
}

function joinIgnore(relativeDir: string): string {
    return relativeDir === "" ? ".gitignore" : `${relativeDir}/.gitignore`;
}

function toRelative(worktreeRoot: string, vaultPath: string): string {
    if (worktreeRoot === "") return vaultPath;
    if (vaultPath === worktreeRoot) return "";
    return vaultPath.startsWith(`${worktreeRoot}/`)
        ? vaultPath.substring(worktreeRoot.length + 1)
        : vaultPath;
}

/**
 * Classifies worktree files against the index without a MEMFS copy of the
 * vault. Files whose size and mtime already match the index are left unread.
 * Same-size files with a different mtime are hashed one at a time.
 */
export async function diffWorktreeAgainstIndex(args: {
    index: ReadonlyMap<string, GitIndexEntry>;
    vaultFiles: ReadonlyMap<string, VaultFileMeta>;
    hashFile: (path: string) => Promise<string>;
}): Promise<{ modified: string[]; deleted: string[] }> {
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [path, entry] of args.index) {
        const vault = args.vaultFiles.get(path);
        if (!vault) {
            deleted.push(path);
            continue;
        }
        if (vault.size !== entry.size) {
            modified.push(path);
            continue;
        }
        if (Math.floor(vault.mtimeMs / 1000) === entry.mtimeSeconds) {
            continue;
        }
        if ((await args.hashFile(path)) !== entry.hash) {
            modified.push(path);
        }
    }
    return { modified, deleted };
}

export function collectUntracked(
    vaultFiles: ReadonlyMap<string, VaultFileMeta>,
    index: ReadonlyMap<string, GitIndexEntry>
): string[] {
    const untracked: string[] = [];
    for (const path of vaultFiles.keys()) {
        if (!index.has(path)) untracked.push(path);
    }
    return untracked;
}

/**
 * Collapses fully untracked directories to `dir/`, matching
 * `git status -s` without `-uall`.
 */
export function collapseUntrackedDirectories(
    untracked: string[],
    tracked: Iterable<string>
): string[] {
    const trackedPaths = new Set(tracked);
    const collapsed = new Set<string>();
    for (const path of untracked) {
        const parts = path.split("/");
        let prefix: string | undefined;
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join("/");
            if (!hasTrackedUnder(trackedPaths, dir)) {
                prefix = `${dir}/`;
                break;
            }
        }
        collapsed.add(prefix ?? path);
    }
    return [...collapsed];
}

function hasTrackedUnder(tracked: Set<string>, dir: string): boolean {
    const prefix = `${dir}/`;
    for (const path of tracked) {
        if (path === dir || path.startsWith(prefix)) return true;
    }
    return false;
}

export function composeStatus(args: {
    staged: ParsedNameStatusEntry[];
    modified: string[];
    deleted: string[];
    untracked: string[];
    conflicted: string[];
    toVaultPath: (repoPath: string) => string;
    pathFilter?: string;
}): Status {
    const stagedByPath = new Map(
        args.staged.map((entry) => [entry.path, entry.type])
    );
    const workingDirByPath = new Map<string, string>();
    for (const path of args.modified) workingDirByPath.set(path, "M");
    for (const path of args.deleted) workingDirByPath.set(path, "D");
    for (const path of args.untracked) workingDirByPath.set(path, "U");

    const paths = new Set<string>([
        ...stagedByPath.keys(),
        ...workingDirByPath.keys(),
        ...args.conflicted,
    ]);

    const all: FileStatusResult[] = [];
    const changed: FileStatusResult[] = [];
    const staged: FileStatusResult[] = [];
    for (const path of paths) {
        if (
            args.pathFilter != undefined &&
            path !== args.pathFilter &&
            !path.startsWith(`${args.pathFilter}/`)
        ) {
            continue;
        }
        const conflicted = args.conflicted.includes(path);
        const untracked = workingDirByPath.get(path) === "U";
        const entry: FileStatusResult = {
            path,
            vaultPath: args.toVaultPath(path),
            index: conflicted
                ? "U"
                : untracked
                  ? "U"
                  : stagedByPath.get(path) ?? " ",
            workingDir: conflicted
                ? "U"
                : untracked
                  ? "U"
                  : workingDirByPath.get(path) ?? " ",
        };
        if (entry.workingDir !== " ") changed.push(entry);
        if (entry.index !== " " && entry.index !== "U") staged.push(entry);
        if (entry.index !== " " || entry.workingDir !== " ") all.push(entry);
    }
    return { all, changed, staged, conflicted: args.conflicted };
}
