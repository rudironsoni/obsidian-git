import type { Lg2FS } from "wasm-git/lg2_async.js";

export interface MemDumpFile {
    path: string;
    data: Uint8Array;
    mtime: number;
}

export const LG2_DUMP_ROOTS = ["/repo", "/home/web_user"];

export interface MemDump {
    dirs: string[];
    files: MemDumpFile[];
}

const SKIP = new Set([".", ".."]);

export function dumpMemRoots(fs: Lg2FS, roots: readonly string[]): MemDump {
    const dirs: string[] = [];
    const files: MemDumpFile[] = [];
    for (const root of roots) {
        dumpPath(fs, root, dirs, files);
    }
    return { dirs, files };
}

export function applyMemDump(
    fs: Lg2FS,
    roots: readonly string[],
    dump: MemDump
): void {
    const keep = new Set(dump.files.map((file) => file.path));
    const current = dumpMemRoots(fs, roots);
    for (const file of current.files) {
        if (!keep.has(file.path) && fs.analyzePath(file.path).exists) {
            fs.unlink(file.path);
        }
    }
    loadMemDump(fs, dump);
}

export function loadMemDump(fs: Lg2FS, dump: MemDump): void {
    for (const dir of dump.dirs) {
        ensureDir(fs, dir);
    }
    for (const file of dump.files) {
        ensureDir(fs, parentOf(file.path));
        fs.writeFile(file.path, file.data);
        fs.utime(file.path, file.mtime, file.mtime);
    }
}

function dumpPath(
    fs: Lg2FS,
    path: string,
    dirs: string[],
    files: MemDumpFile[]
): void {
    if (!fs.analyzePath(path).exists) return;
    const stat = fs.stat(path);
    if (fs.isDir(stat.mode)) {
        dirs.push(path);
        for (const name of fs.readdir(path)) {
            if (SKIP.has(name)) continue;
            dumpPath(fs, `${path}/${name}`, dirs, files);
        }
        return;
    }
    if (fs.isFile(stat.mode)) {
        files.push({
            path,
            data: fs.readFile(path),
            mtime: stat.mtime.getTime(),
        });
    }
}

function ensureDir(fs: Lg2FS, path: string): void {
    if (path === "" || path === "/" || fs.analyzePath(path).exists) return;
    ensureDir(fs, parentOf(path));
    fs.mkdir(path);
}

function parentOf(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.substring(0, index);
}
