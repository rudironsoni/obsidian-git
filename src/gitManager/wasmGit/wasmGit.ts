import { Notice, normalizePath, Platform } from "obsidian";
import type ObsidianGit from "../../main";
import type {
    Blame,
    BranchInfo,
    DiffFile,
    FileStatusResult,
    LogEntry,
    Status,
    SyncMethod,
    UnstagedFile,
    WalkDifference,
} from "../../types";
import { GitOperation, NoNetworkError, UserCanceledError } from "../../types";
import { GeneralModal } from "../../ui/modals/generalModal";
import { splitRemoteBranch } from "../../utils";
import { GitManager } from "../gitManager";
import { HttpStatusError, WasmGitHttpBridge } from "./httpBridge";
import { containsLg2Error, Lg2 } from "./lg2";
import type { LfsAttributeRule, LfsPointer } from "./lfs";
import {
    hashLfsContent,
    isLfsTracked,
    lfsBatch,
    lfsBatchEndpoint,
    lfsTransfer,
    parseGitAttributes,
    parseLfsConfigUrl,
    parseLfsPointer,
    serializeLfsPointer,
} from "./lfs";
import type { RebaseHost } from "./rebase";
import { RebaseConflictError, rebaseOnto } from "./rebase";
import { GitIgnore } from "./gitIgnore";
import {
    GIT_FILEMODE_BLOB,
    isGitlink,
    parseGitIndex,
    removeIndexPath,
    upsertStagedFile,
    type GitIndexEntry,
} from "./gitIndex";
import {
    hashGitBlob,
    inflateGitObject,
    parseGitTree,
    runPool,
    writeGitLooseBlob,
} from "./gitObject";
import { GitPackStore, listPackPairs } from "./gitPack";
import type { ParsedCommitObject, ParsedNameStatusEntry } from "./parsers";
import {
    applyUnifiedPatch,
    extractFileDiff,
    extractPatchPath,
    parseBlame,
    parseCommitObject,
    parseForEachRef,
    parseLog,
    parseLsRemote,
    parseLsTree,
    parseNameStatus,
    parseRemoteVerbose,
    removeConfigKey,
    resolveConflictMarkers,
    splitCommandLine,
    toPorcelainBlame,
} from "./parsers";
import type { MirrorAdapter } from "./vaultMirror";
import { VaultMirror } from "./vaultMirror";
import { isGitDirSkippedOnSyncIn } from "./gitObjectPayload";
import { GitCpu } from "./gitCpu";
import {
    countIndexDiff,
    countUnpushedFromReflog,
    gitTimezoneOffset,
    listGitConfigSubsections,
    looseObjectVaultPath,
    parseGitConfigValue,
    parsePackedRefs,
    parseReflogUnixSeconds,
    removeGitConfigSection,
    serializeGitCommit,
    upsertGitConfigValue,
    type GitSignature,
} from "./gitWrite";
import {
    collapseUntrackedDirectories,
    collectUntracked,
    composeStatus,
    diffWorktreeAgainstIndex,
    walkWorktreeMeta,
    type VaultFileMeta,
} from "./worktreeStatus";

const MEM_ROOT = "/repo";
const MEM_GITDIR = `${MEM_ROOT}/.git`;
/** Maximum number of paths passed to a single lg2 invocation. */
const PATH_BATCH_SIZE = 50;
/** Concurrent vault reads / loose-object writes while staging. */
const BLOB_WRITE_CONCURRENCY = 8;

/**
 * Sole Git backend for desktop and mobile, powered by wasm-git (libgit2
 * compiled to WebAssembly).
 *
 * The engine runs against an in-memory filesystem that is kept in sync with
 * the vault by {@link VaultMirror}: the working tree is re-synced from the
 * vault before every operation that reads or writes it, and both the working
 * tree and the `.git` directory are persisted back to the vault after
 * mutating operations. Operations that only inspect repository state go
 * through {@link readGitDir} and skip the working-tree sync entirely.
 * `status` walks vault metadata and hashes only files that might have
 * changed, so it never copies the whole vault into memory.
 * Commands are serialized through {@link Lg2}'s mutex on the plugin thread
 * because Obsidian's adapter and `requestUrl` are main-thread APIs.
 * Remote access goes through {@link WasmGitHttpBridge} on top of Obsidian's
 * `requestUrl`, so HTTPS remotes work without CORS restrictions.
 */
export class WasmGit extends GitManager {
    private readonly httpBridge = new WasmGitHttpBridge();
    private readonly cpu = new GitCpu();
    private readonly lg2 = new Lg2(this.httpBridge, this.cpu);
    private worktreeMirror: VaultMirror | undefined;
    private gitDirMirror: VaultMirror | undefined;
    private gitDirLoaded = false;
    /** True after pack/loose objects have been paged into MEMFS. */
    private gitOdbLoaded = false;
    private readonly packStore = new GitPackStore();
    /**
     * In-flight {@link ensureReady}. Concurrent callers (Source Control
     * `status-changed` plus the status bar `refreshed` listener) must share
     * one lg2 init and one `.git` metadata `syncIn`. Two copies jetsam iOS.
     */
    private ensureReadyPromise: Promise<void> | undefined;
    private readonly noticeLength = 999_999;
    /**
     * Nested Git operations (commitAll → stageAll + commit) increment this
     * so only the outermost caller reports the error to the user.
     */
    private silenceErrors = 0;

    constructor(plugin: ObsidianGit) {
        super(plugin);
        this.httpBridge.getAuthHeader = () => {
            const username = this.plugin.localStorage.getUsername();
            const password = this.plugin.localStorage.getPassword();
            if (!username || !password) return undefined;
            return "Basic " + btoa(`${username}:${password}`);
        };
        this.cpu.getAuthHeader = () => this.httpBridge.getAuthHeader();
        this.cpu.onEvent = (event, data) => {
            this.plugin.crashLog?.log(event, data);
        };
    }

    // ------------------------------------------------------------------
    // Setup and synchronization plumbing
    // ------------------------------------------------------------------

    private get adapter(): MirrorAdapter {
        return this.app.vault.adapter;
    }

    private getGitDirVaultPath(): string {
        return normalizePath(
            this.getRelativeVaultPath(this.plugin.settings.gitDir || ".git")
        );
    }

    private isExcludedWorktreePath(relativePath: string): boolean {
        const gitDirVaultPath = this.getGitDirVaultPath();
        const basePath = this.plugin.settings.basePath;
        const gitDirInsideWorktree =
            basePath === ""
                ? gitDirVaultPath
                : gitDirVaultPath.startsWith(`${basePath}/`)
                  ? gitDirVaultPath.substring(basePath.length + 1)
                  : undefined;
        return (
            gitDirInsideWorktree != undefined &&
            (relativePath === gitDirInsideWorktree ||
                relativePath.startsWith(`${gitDirInsideWorktree}/`))
        );
    }

    private buildMirrors(): void {
        const gitDirVaultPath = this.getGitDirVaultPath();
        this.worktreeMirror = new VaultMirror(
            this.adapter,
            this.lg2.fs,
            this.plugin.settings.basePath,
            MEM_ROOT,
            (relativePath) => this.isExcludedWorktreePath(relativePath)
        );
        this.gitDirMirror = new VaultMirror(
            this.adapter,
            this.lg2.fs,
            gitDirVaultPath,
            MEM_GITDIR,
            () => false,
            isGitDirSkippedOnSyncIn
        );
        this.gitDirLoaded = false;
        this.gitOdbLoaded = false;
    }

    private async ensureReady(): Promise<void> {
        if (this.ensureReadyPromise) {
            await this.ensureReadyPromise;
            return;
        }
        this.ensureReadyPromise = this.ensureReadyInternal();
        try {
            await this.ensureReadyPromise;
        } finally {
            this.ensureReadyPromise = undefined;
        }
    }

    private async ensureReadyInternal(): Promise<void> {
        this.plugin.crashLog?.log("ensureReady", {
            lg2: this.lg2.initialized,
            gitDirLoaded: this.gitDirLoaded,
        });
        if (!this.lg2.initialized) {
            this.plugin.crashLog?.log("lg2-init-start");
            await this.lg2.init();
            this.plugin.crashLog?.log("lg2-init-done");
            // A WASM trap unloads the module and invalidates any FS handles
            // the mirrors still hold, so they must be rebuilt from scratch.
            this.discardMirrors();
            this.buildMirrors();
        } else if (!this.worktreeMirror || !this.gitDirMirror) {
            this.buildMirrors();
        }
        if (!this.gitDirLoaded) {
            // The .git directory is loaded once per session and treated as
            // owned by this engine afterwards; only git itself modifies it.
            this.plugin.crashLog?.log("gitDir-syncIn-start", {
                payloads: false,
            });
            await this.gitDirMirror!.syncIn();
            this.gitDirLoaded = true;
            this.ensureGitObjectDirs();
            await this.normalizeRepoConfig();
            this.plugin.crashLog?.log("gitDir-syncIn-done", {
                payloads: false,
            });
        }
    }

    /**
     * Pages pack and loose objects into MEMFS. Status never calls this.
     * libgit2 commands that read the ODB (log, commit, cat-file, …) do.
     */
    private async ensureOdb(): Promise<void> {
        await this.ensureReady();
        if (this.gitOdbLoaded) return;
        this.plugin.crashLog?.log("gitDir-odb-sync-start");
        await this.gitDirMirror!.importSubtree("objects");
        this.gitOdbLoaded = true;
        this.plugin.crashLog?.log("gitDir-odb-sync-done");
    }

    private ensureGitObjectDirs(): void {
        const objects = `${MEM_GITDIR}/objects`;
        const pack = `${objects}/pack`;
        if (!this.lg2.fs.analyzePath(objects).exists) {
            this.lg2.fs.mkdir(objects);
        }
        if (!this.lg2.fs.analyzePath(pack).exists) {
            this.lg2.fs.mkdir(pack);
        }
    }

    /**
     * Repositories created by native git on desktop record
     * `core.filemode = true`. The in-memory filesystem reports one fixed mode
     * for every file, which would make all tracked files appear modified, so
     * the flag is forced off once per session.
     */
    private async normalizeRepoConfig(): Promise<void> {
        const configPath = `${MEM_GITDIR}/config`;
        if (!this.lg2.fs.analyzePath(configPath).exists) return;
        const content = this.lg2.fs.readFile(configPath, {
            encoding: "utf8",
        });
        const normalized = content.replace(
            /^(\s*filemode\s*=\s*)true\s*$/im,
            "$1false"
        );
        if (normalized !== content) {
            this.lg2.fs.writeFile(configPath, normalized);
            await this.gitDirMirror!.syncOut();
        }
    }

    private async syncIn(): Promise<void> {
        await this.ensureReady();
        await this.worktreeMirror!.syncIn();
    }

    private async syncOut(): Promise<void> {
        if (!this.lg2.initialized) {
            this.discardMirrors();
            return;
        }
        await this.smudgeLfsWorktree();
        await this.worktreeMirror!.syncOut();
        await this.gitDirMirror!.syncOut();
    }

    private discardMirrors(): void {
        this.worktreeMirror = undefined;
        this.gitDirMirror = undefined;
        this.gitDirLoaded = false;
        this.gitOdbLoaded = false;
    }

    /**
     * Runs a read-only command that only inspects the repository state in
     * `.git` (refs, history, index, and object contents) and never the
     * working tree, so the vault's files are not mirrored into memory.
     *
     * This distinction is critical on mobile: mirroring every vault file
     * just to answer e.g. `rev-parse HEAD` makes plugin startup and every
     * status-bar or history refresh scale with the vault size. On iOS the
     * resulting memory spike gets the app killed and relaunched in a loop
     * as soon as the plugin is enabled.
     */
    private async readGitDir(
        args: string[],
        opts?: { ignoreErrors?: boolean }
    ): Promise<{ stdout: string; stderr: string }> {
        await this.ensureOdb();
        return this.lg2.run(MEM_ROOT, args, opts);
    }

    /**
     * Runs a mutating command and persists the in-memory changes back to the
     * vault, including when the command fails, so the vault never diverges
     * from what git already wrote (e.g. partial merges).
     */
    private async mutate(
        args: string[],
        opts?: {
            ignoreErrors?: boolean;
            onProgress?: (line: string) => void;
            /**
             * `"none"` skips the working-tree mirror: the command only
             * reads or writes `.git` (commit, reset --soft, push, fetch,
             * remotes, tags). Default `"all"` keeps the previous full
             * sync for commands that rewrite many worktree files.
             */
            worktree?: "all" | "none";
        }
    ): Promise<{ stdout: string; stderr: string }> {
        if (opts?.worktree === "none") {
            await this.ensureOdb();
        } else {
            await this.syncIn();
            await this.ensureOdb();
        }
        try {
            return await this.lg2.run(MEM_ROOT, args, opts);
        } finally {
            if (!this.lg2.initialized) {
                this.discardMirrors();
            } else if (opts?.worktree === "none") {
                await this.gitDirMirror!.syncOut();
            } else {
                await this.syncOut();
            }
        }
    }

    /**
     * Retries `fn` once with freshly prompted credentials when the remote
     * rejects the current ones, mirroring the isomorphic-git behavior.
     */
    private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            if (!(error instanceof HttpStatusError) || !error.isAuthFailure) {
                throw error;
            }
            new Notice(
                "Authentication failed. Please try with different credentials"
            );
            const username = await new GeneralModal(this.plugin, {
                placeholder: "Specify your username",
            }).openAndGetResult();
            if (username) {
                const password = await new GeneralModal(this.plugin, {
                    placeholder: "Specify your password/personal access token",
                    obscure: true,
                }).openAndGetResult();
                if (password) {
                    this.plugin.localStorage.setUsername(username);
                    this.plugin.localStorage.setPassword(password);
                    return await fn();
                }
            }
            throw new UserCanceledError();
        }
    }

    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------

    async status(opts?: { path?: string }): Promise<Status> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        try {
            const status = await this.computeStatus(opts?.path);
            window.clearTimeout(timeout);
            notice?.hide();
            return status;
        } catch (error) {
            window.clearTimeout(timeout);
            notice?.hide();
            this.reportError(error);
            throw error;
        }
    }

    /**
     * Builds a {@link Status} from the git index, vault metadata, and
     * per-file hashes of the files that might have changed. Does not start
     * wasm or copy `.git` into MEMFS: that path jetsams iOS on refresh/sync.
     */
    private async computeStatus(pathFilter?: string): Promise<Status> {
        this.plugin.crashLog?.log("computeStatus");
        if (Platform.isMobileApp) {
            new Notice("Git: checking status…", 5000);
        }
        const indexEntries = await this.readIndexEntriesFromVault();
        this.plugin.crashLog?.log("computeStatus-index", {
            entries: indexEntries.length,
        });
        const index = new Map(
            indexEntries
                .filter((entry) => entry.stage === 0 && !isGitlink(entry.mode))
                .map((entry) => [entry.path, entry])
        );
        const conflicted = [
            ...new Set(
                indexEntries
                    .filter((entry) => entry.stage > 0)
                    .map((entry) => entry.path)
            ),
        ];

        const ignore = new GitIgnore();
        ignore.addFile("", `${this.app.vault.configDir}/\n`);
        const excludePath = normalizePath(
            `${this.getGitDirVaultPath()}/info/exclude`
        );
        if (await this.adapter.exists(excludePath)) {
            ignore.addFile("", await this.readVaultText(excludePath));
        }

        const trackedDirs = new Set<string>();
        for (const repoPath of index.keys()) {
            const parts = repoPath.split("/");
            for (let i = 1; i < parts.length; i++) {
                trackedDirs.add(parts.slice(0, i).join("/"));
            }
        }

        const vaultFiles = Platform.isMobileApp
            ? await this.statTrackedVaultFiles(index)
            : await walkWorktreeMeta(
                  this.adapter,
                  this.plugin.settings.basePath,
                  {
                      exclude: (relativePath) =>
                          this.isExcludedWorktreePath(relativePath),
                      ignore,
                      keep: (relativePath) =>
                          index.has(relativePath) ||
                          trackedDirs.has(relativePath),
                      readText: (vaultPath) => this.readVaultText(vaultPath),
                  }
              );
        this.plugin.crashLog?.log("computeStatus-worktree", {
            files: vaultFiles.size,
            mobile: Platform.isMobileApp,
        });

        const { modified, deleted } = await diffWorktreeAgainstIndex({
            index,
            vaultFiles,
            hashFile: (repoPath) => this.hashVaultFile(repoPath),
        });
        this.plugin.crashLog?.log("computeStatus-diff", {
            modified: modified.length,
            deleted: deleted.length,
        });
        const untracked = Platform.isMobileApp
            ? []
            : collectUntracked(vaultFiles, index);
        const staged = Platform.isMobileApp
            ? []
            : await this.diffIndexToHead(index);
        this.plugin.crashLog?.log("computeStatus-done", {
            untracked: untracked.length,
            staged: staged.length,
        });

        return composeStatus({
            staged,
            modified,
            deleted,
            untracked,
            conflicted,
            toVaultPath: (repoPath) => this.getRelativeVaultPath(repoPath),
            pathFilter,
        });
    }

    /**
     * Stats only index paths. A full vault walk on iOS can sit for minutes
     * with no UI update and looks like a hung sync.
     */
    private async statTrackedVaultFiles(
        index: Map<string, GitIndexEntry>
    ): Promise<Map<string, VaultFileMeta>> {
        const files = new Map<string, VaultFileMeta>();
        let n = 0;
        for (const repoPath of index.keys()) {
            const vaultPath = this.getRelativeVaultPath(repoPath);
            if (!(await this.adapter.exists(vaultPath))) continue;
            const stat = await this.adapter.stat(vaultPath);
            if (stat?.type !== "file") continue;
            files.set(repoPath, { size: stat.size, mtimeMs: stat.mtime });
            n += 1;
            if (n % 50 === 0) {
                this.plugin.crashLog?.log("computeStatus-stat", { n });
                await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 0);
                });
            }
        }
        return files;
    }

    private async readIndexEntriesFromVault(): Promise<GitIndexEntry[]> {
        const indexPath = normalizePath(`${this.getGitDirVaultPath()}/index`);
        if (!(await this.adapter.exists(indexPath))) return [];
        try {
            return parseGitIndex(
                new Uint8Array(await this.adapter.readBinary(indexPath))
            );
        } catch {
            return [];
        }
    }

    private readIndexEntries() {
        const indexPath = `${MEM_GITDIR}/index`;
        if (!this.lg2.fs.analyzePath(indexPath).exists) return [];
        return parseGitIndex(this.lg2.fs.readFile(indexPath));
    }

    /**
     * Index vs HEAD using vault objects (loose, then pack). Does not start
     * wasm or copy packs into MEMFS.
     */
    private async diffIndexToHead(
        index: Map<string, GitIndexEntry>
    ): Promise<ParsedNameStatusEntry[]> {
        const head = await this.readHeadBlobMap();
        if (head == undefined) return [];
        const staged: ParsedNameStatusEntry[] = [];
        for (const [path, entry] of index) {
            const previous = head.get(path);
            if (previous == undefined) {
                staged.push({ type: "A", path });
            } else if (previous !== entry.hash) {
                staged.push({ type: "M", path });
            }
        }
        for (const path of head.keys()) {
            if (!index.has(path)) {
                staged.push({ type: "D", path });
            }
        }
        return staged;
    }

    private async readHeadBlobMap(): Promise<Map<string, string> | undefined> {
        const commitHash = await this.resolveHeadCommitHash();
        if (commitHash == undefined) return undefined;
        const commit = await this.readGitObject(commitHash);
        if (commit == undefined || commit.type !== "commit") {
            this.plugin.crashLog?.log("status-head-packed");
            return undefined;
        }
        const parsed = parseCommitObject(
            new TextDecoder("utf-8").decode(commit.payload)
        );
        if (parsed == undefined) return undefined;
        const blobs = new Map<string, string>();
        const ok = await this.walkLooseTree(parsed.tree, "", blobs);
        return ok ? blobs : undefined;
    }

    private async resolveHeadCommitHash(): Promise<string | undefined> {
        const headPath = normalizePath(`${this.getGitDirVaultPath()}/HEAD`);
        if (!(await this.adapter.exists(headPath))) return undefined;
        const head = (await this.readVaultText(headPath)).trim();
        const ref = head.match(/^ref:\s+(.*)$/)?.[1];
        if (!ref) {
            return /^[0-9a-f]{40}$/i.test(head)
                ? head.toLowerCase()
                : undefined;
        }
        const refPath = normalizePath(`${this.getGitDirVaultPath()}/${ref}`);
        if (await this.adapter.exists(refPath)) {
            const value = (await this.readVaultText(refPath)).trim();
            return /^[0-9a-f]{40}$/i.test(value)
                ? value.toLowerCase()
                : undefined;
        }
        const packed = await this.readPackedRefsFromVault();
        return packed.get(ref);
    }

    private async readPackedRefsFromVault(): Promise<Map<string, string>> {
        const packedPath = normalizePath(
            `${this.getGitDirVaultPath()}/packed-refs`
        );
        if (!(await this.adapter.exists(packedPath))) return new Map();
        return parsePackedRefs(await this.readVaultText(packedPath));
    }

    private async resolveVaultRef(rev: string): Promise<string | undefined> {
        const trimmed = rev.trim();
        if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
        if (trimmed === "HEAD") return this.resolveHeadCommitHash();
        const candidates = [
            trimmed,
            `refs/heads/${trimmed}`,
            `refs/remotes/${trimmed}`,
            `refs/tags/${trimmed}`,
            `refs/${trimmed}`,
        ];
        const packed = await this.readPackedRefsFromVault();
        for (const name of candidates) {
            const refPath = normalizePath(
                `${this.getGitDirVaultPath()}/${name}`
            );
            if (await this.adapter.exists(refPath)) {
                const value = (await this.readVaultText(refPath)).trim();
                if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
                if (value.startsWith("ref: ")) {
                    return this.resolveVaultRef(value.substring(5).trim());
                }
            }
            const packedHash = packed.get(name);
            if (packedHash) return packedHash;
        }
        return undefined;
    }

    private async listLooseRefs(prefix: string): Promise<Map<string, string>> {
        const refs = new Map<string, string>();
        const root = normalizePath(`${this.getGitDirVaultPath()}/${prefix}`);
        if (!(await this.adapter.exists(root))) return refs;
        const pending = [root];
        while (pending.length > 0) {
            const dir = pending.pop()!;
            const listing = await this.adapter.list(dir);
            for (const folder of listing.folders) pending.push(folder);
            for (const file of listing.files) {
                const value = (await this.readVaultText(file)).trim();
                if (!/^[0-9a-f]{40}$/i.test(value)) continue;
                const relative = file.startsWith(`${root}/`)
                    ? file.substring(root.length + 1)
                    : file;
                refs.set(relative, value.toLowerCase());
            }
        }
        return refs;
    }

    private async countUnpushedLooseCommits(
        head: string,
        tracking: string
    ): Promise<number | undefined> {
        let current: string | undefined = head;
        let count = 0;
        const seen = new Set<string>();
        while (current && current !== tracking) {
            if (seen.has(current)) return undefined;
            seen.add(current);
            const object = await this.readGitObject(current);
            if (object == undefined || object.type !== "commit") {
                return undefined;
            }
            count += 1;
            const parsed = parseCommitObject(
                new TextDecoder("utf-8").decode(object.payload)
            );
            current = parsed?.parents[0];
        }
        return current === tracking ? count : undefined;
    }

    private async countUnpushedFromBranchLog(
        branch: string,
        tracking: string
    ): Promise<number | undefined> {
        const logPath = normalizePath(
            `${this.getGitDirVaultPath()}/logs/refs/heads/${branch}`
        );
        if (!(await this.adapter.exists(logPath))) return undefined;
        return countUnpushedFromReflog(
            await this.readVaultText(logPath),
            tracking
        );
    }

    private async walkLooseTree(
        hash: string,
        prefix: string,
        blobs: Map<string, string>
    ): Promise<boolean> {
        const object = await this.readGitObject(hash);
        if (object == undefined || object.type !== "tree") {
            this.plugin.crashLog?.log("status-head-packed");
            return false;
        }
        for (const entry of parseGitTree(object.payload)) {
            const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            if ((entry.mode & 0o170000) === 0o040000) {
                if (!(await this.walkLooseTree(entry.hash, path, blobs))) {
                    return false;
                }
            } else if ((entry.mode & 0o170000) !== 0o160000) {
                blobs.set(path, entry.hash);
            }
        }
        return true;
    }

    private async readGitObject(
        hash: string
    ): Promise<{ type: string; payload: Uint8Array } | undefined> {
        const loose = await this.readLooseObject(hash);
        if (loose) return loose;
        return this.readPackedObject(hash);
    }

    private async readLooseObject(
        hash: string
    ): Promise<{ type: string; payload: Uint8Array } | undefined> {
        const objectPath = normalizePath(
            `${this.getGitDirVaultPath()}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`
        );
        if (!(await this.adapter.exists(objectPath))) return undefined;
        try {
            return await inflateGitObject(
                new Uint8Array(await this.adapter.readBinary(objectPath))
            );
        } catch {
            return undefined;
        }
    }

    private async readPackedObject(
        hash: string
    ): Promise<{ type: string; payload: Uint8Array } | undefined> {
        const packDir = normalizePath(
            `${this.getGitDirVaultPath()}/objects/pack`
        );
        if (!(await this.adapter.exists(packDir))) return undefined;
        const listing = await this.adapter.list(packDir);
        const packs = listPackPairs(listing.files);
        if (packs.length === 0) return undefined;
        return this.packStore.get(hash, packs, (vaultPath) =>
            this.readVaultBytes(vaultPath)
        );
    }

    private async readVaultBytes(vaultPath: string): Promise<Uint8Array> {
        return new Uint8Array(await this.adapter.readBinary(vaultPath));
    }

    private async readVaultText(vaultPath: string): Promise<string> {
        const data = new Uint8Array(await this.adapter.readBinary(vaultPath));
        return new TextDecoder("utf-8").decode(data);
    }

    private async hashVaultFile(repoPath: string): Promise<string> {
        const data = new Uint8Array(
            await this.adapter.readBinary(this.getRelativeVaultPath(repoPath))
        );
        // Status runs on the plugin thread. A CPU worker here can stall
        // ChromeDriver execute/sync: the renderer waits on the promise and
        // never sees the worker's ready ping.
        return hashGitBlob(data);
    }

    async getStagedFiles(
        dir = "."
    ): Promise<{ vaultPath: string; path: string }[]> {
        const status = await this.status(
            dir === "." ? undefined : { path: dir }
        );
        return status.staged.map(({ path, vaultPath }) => ({
            path,
            vaultPath,
        }));
    }

    async getUnstagedFiles(dir = "."): Promise<UnstagedFile[]> {
        const status = await this.status(
            dir === "." ? undefined : { path: dir }
        );
        return status.changed.map((file) => ({
            path: file.path,
            type:
                file.workingDir === "D"
                    ? "D"
                    : file.workingDir === "U"
                      ? "A"
                      : "M",
        }));
    }

    async getUntrackedPaths(opts?: {
        path?: string;
        status?: Status;
    }): Promise<string[]> {
        // Deliberately without listing every file: directories that only
        // contain untracked files are collapsed to `dir/`, matching native
        // git and allowing efficient recursive deletion.
        const status = opts?.status ?? (await this.computeStatus(opts?.path));
        const untracked = status.changed
            .filter((file) => file.workingDir === "U" && file.index === "U")
            .map((file) => file.path)
            .filter(
                (path) =>
                    opts?.path == undefined || path.startsWith(`${opts.path}/`)
            );
        const tracked = (await this.readIndexEntriesFromVault())
            .filter((entry) => entry.stage === 0)
            .map((entry) => entry.path);
        return collapseUntrackedDirectories(untracked, tracked);
    }

    // ------------------------------------------------------------------
    // Staging
    // ------------------------------------------------------------------

    async stage(filepath: string, relativeToVault: boolean): Promise<void> {
        try {
            const gitPath = this.getRelativeRepoPath(filepath, relativeToVault);
            await this.addPaths([gitPath]);
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async stageAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        try {
            const current =
                status ??
                (await this.status(
                    dir == undefined || dir === "." ? undefined : { path: dir }
                ));
            await this.addPaths(current.changed.map((file) => file.path));
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    /**
     * Stages paths by writing blobs and a v2/v3 index in TypeScript.
     *
     * lg2's `add` calls `git_index_add_all`, which diffs the entire index
     * against the MEMFS worktree before applying pathspecs. That is unsafe
     * on the partial worktree this engine keeps (only changed files are
     * imported; everything else looks deleted) and is what produced
     * `THROW: memory access out of bounds` on large vaults.
     */
    private async addPaths(paths: string[]): Promise<void> {
        const unique: string[] = [];
        const seen = new Set<string>();
        for (const path of paths) {
            const repoPath = this.normalizeRepoPath(path);
            if (repoPath == undefined) continue;
            if (this.isExcludedWorktreePath(repoPath)) continue;
            if (seen.has(repoPath)) continue;
            seen.add(repoPath);
            unique.push(repoPath);
        }
        if (unique.length === 0) return;
        this.plugin.crashLog?.log("stage-start", {
            files: unique.length,
            vault: this.useVaultGit(),
        });
        if (Platform.isMobileApp) {
            new Notice(`Git: staging ${unique.length} files…`, 8000);
        }
        if (!this.useVaultGit()) {
            await this.ensureReady();
        }
        const lfsRules = await this.readLfsAttributeRules();
        let entries = this.useVaultGit()
            ? await this.readIndexEntriesFromVault()
            : this.readIndexEntries();
        const concurrency = Platform.isMobileApp ? 2 : BLOB_WRITE_CONCURRENCY;
        const ops = await runPool(unique, concurrency, (repoPath) =>
            this.stagePathOp(repoPath, lfsRules)
        );
        for (const op of ops) {
            switch (op.kind) {
                case "remove":
                    entries = removeIndexPath(entries, op.path);
                    break;
                case "upsert":
                    entries = upsertStagedFile(entries, op.entry);
                    break;
                case "skip":
                    break;
                default: {
                    const _exhaustive: never = op;
                    throw new Error(
                        `unhandled stage operation ${JSON.stringify(_exhaustive)}`
                    );
                }
            }
        }
        this.plugin.crashLog?.log("stage-index");
        await this.persistIndex(entries);
        this.plugin.crashLog?.log("stage-done", { files: unique.length });
    }

    /** Stages paths from the in-memory worktree (used during rebase replay). */
    private async stageMemfsPaths(paths: string[]): Promise<void> {
        if (paths.length === 0) return;
        await this.ensureReady();
        let entries = this.readIndexEntries();
        for (const repoPath of paths) {
            const normalized = this.normalizeRepoPath(repoPath);
            if (normalized == undefined) continue;
            const memPath = `${MEM_ROOT}/${normalized}`;
            if (!this.lg2.fs.analyzePath(memPath).exists) {
                entries = removeIndexPath(entries, normalized);
                continue;
            }
            const data = this.lg2.fs.readFile(memPath);
            entries = await this.stageBlob(
                entries,
                normalized,
                data,
                Date.now()
            );
        }
        await this.persistIndex(entries);
    }

    private async stagePathOp(
        repoPath: string,
        lfsRules: LfsAttributeRule[]
    ): Promise<StageOp> {
        const vaultPath = this.getRelativeVaultPath(repoPath);
        if (!(await this.adapter.exists(vaultPath))) {
            return { kind: "remove", path: repoPath };
        }
        const stat = await this.adapter.stat(vaultPath);
        if (stat?.type !== "file") return { kind: "skip" };
        const data = new Uint8Array(await this.adapter.readBinary(vaultPath));
        let blobData = data;
        if (isLfsTracked(repoPath, lfsRules)) {
            const pointerText = serializeLfsPointer(
                hashLfsContent(data),
                data.byteLength
            );
            blobData = new TextEncoder().encode(pointerText);
        }
        const hash = this.useVaultGit()
            ? await this.writeLooseObject("blob", blobData)
            : await writeGitLooseBlob(this.lg2.fs, MEM_GITDIR, blobData);
        return {
            kind: "upsert",
            entry: {
                path: repoPath,
                hash,
                size: blobData.byteLength,
                mtimeSeconds: Math.floor(stat.mtime / 1000),
                stage: 0,
                mode: GIT_FILEMODE_BLOB,
            },
        };
    }

    private async stageBlob(
        entries: GitIndexEntry[],
        repoPath: string,
        data: Uint8Array,
        mtimeMs: number
    ): Promise<GitIndexEntry[]> {
        const hash = await writeGitLooseBlob(this.lg2.fs, MEM_GITDIR, data);
        return upsertStagedFile(entries, {
            path: repoPath,
            hash,
            size: data.byteLength,
            mtimeSeconds: Math.floor(mtimeMs / 1000),
            stage: 0,
            mode: GIT_FILEMODE_BLOB,
        });
    }

    /**
     * Two-phase persist: sync newly written loose objects first, then
     * replace `index` via `index.lock` so a crash cannot leave the vault
     * pointing at blobs that were never flushed.
     */
    private async persistIndex(entries: GitIndexEntry[]): Promise<void> {
        const data = await this.cpu.writeGitIndex(entries);
        if (this.useVaultGit()) {
            await this.writeIndexToVault(data);
            return;
        }
        await this.gitDirMirror!.syncOut();
        const indexPath = `${MEM_GITDIR}/index`;
        const lockPath = `${MEM_GITDIR}/index.lock`;
        try {
            this.lg2.fs.writeFile(lockPath, data);
            if (this.lg2.fs.analyzePath(indexPath).exists) {
                this.lg2.fs.unlink(indexPath);
            }
            this.lg2.fs.rename(lockPath, indexPath);
        } catch (error) {
            if (this.lg2.fs.analyzePath(lockPath).exists) {
                this.lg2.fs.unlink(lockPath);
            }
            throw error;
        }
        await this.gitDirMirror!.syncOut();
    }

    private async writeIndexToVault(data: Uint8Array): Promise<void> {
        const gitDir = this.getGitDirVaultPath();
        const indexPath = normalizePath(`${gitDir}/index`);
        const lockPath = normalizePath(`${gitDir}/index.lock`);
        await this.adapter.writeBinary(lockPath, toArrayBuffer(data));
        try {
            await this.adapter.writeBinary(indexPath, toArrayBuffer(data));
        } finally {
            if (await this.adapter.exists(lockPath)) {
                await this.adapter.remove(lockPath);
            }
        }
    }

    private useVaultGit(): boolean {
        return Platform.isMobileApp;
    }

    /**
     * Repository-relative path with `..` rejected. Returns undefined for
     * empty / `.` inputs that are not real files.
     */
    private normalizeRepoPath(path: string): string | undefined {
        const trimmed = path
            .replace(/\\/g, "/")
            .replace(/\/{2,}/g, "/")
            .replace(/^\.\//, "")
            .replace(/\/$/, "");
        if (trimmed === "" || trimmed === ".") return undefined;
        if (trimmed.startsWith("/") || trimmed.includes("\0")) {
            throw new Error(`refusing to stage unsafe path '${path}'`);
        }
        const parts = trimmed.split("/");
        if (
            parts.some((part) => part === "" || part === "." || part === "..")
        ) {
            throw new Error(`refusing to stage unsafe path '${path}'`);
        }
        return trimmed;
    }

    async unstage(filepath: string, relativeToVault: boolean): Promise<void> {
        try {
            const gitPath = this.getRelativeRepoPath(filepath, relativeToVault);
            await this.unstagePaths((path) => path === gitPath);
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async unstageAll({
        dir,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        try {
            if (dir == undefined || dir === ".") {
                await this.resetIndexToHead();
            } else {
                await this.unstagePaths(
                    (path) => path === dir || path.startsWith(`${dir}/`)
                );
            }
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    /**
     * Restores each path in the index from HEAD. Unlike `reset HEAD` +
     * re-add, this leaves other staged files (including staged content that
     * no longer matches the worktree) untouched.
     */
    private async unstagePaths(
        shouldUnstage: (path: string) => boolean
    ): Promise<void> {
        await this.ensureReady();
        let entries = this.readIndexEntries();
        const targets = [
            ...new Set(
                entries.map((entry) => entry.path).filter(shouldUnstage)
            ),
        ];
        if (targets.length === 0) return;
        if (!(await this.headExists())) {
            for (const path of targets) {
                entries = removeIndexPath(entries, path);
            }
            await this.persistIndex(entries);
            return;
        }
        const headEntries = await this.lookupHeadFiles(targets);
        for (const path of targets) {
            const head = headEntries.get(path);
            if (!head) {
                entries = removeIndexPath(entries, path);
            } else {
                entries = upsertStagedFile(entries, head);
            }
        }
        await this.persistIndex(entries);
    }

    /**
     * Looks up HEAD blobs for `paths` via `ls-tree`, falling back to
     * `rev-parse HEAD:path` when lg2 has no ls-tree command.
     */
    private async lookupHeadFiles(
        paths: string[]
    ): Promise<Map<string, GitIndexEntry>> {
        const found = new Map<string, GitIndexEntry>();
        for (let i = 0; i < paths.length; i += PATH_BATCH_SIZE) {
            const batch = paths.slice(i, i + PATH_BATCH_SIZE);
            const listed = await this.readGitDir(
                ["ls-tree", "HEAD", "--", ...batch],
                { ignoreErrors: true }
            );
            if (!containsLg2Error(listed.stderr)) {
                for (const row of parseLsTree(listed.stdout)) {
                    if (row.type === "tree") continue;
                    found.set(row.path, {
                        path: row.path,
                        hash: row.hash,
                        size: 0,
                        mtimeSeconds: 0,
                        stage: 0,
                        mode: row.mode,
                    });
                }
            }
        }
        const missing = paths.filter((path) => !found.has(path));
        await runPool(missing, BLOB_WRITE_CONCURRENCY, async (path) => {
            const hash = await this.revParse(`HEAD:${path}`);
            if (!hash) return;
            found.set(path, {
                path,
                hash,
                size: 0,
                mtimeSeconds: 0,
                stage: 0,
                mode: GIT_FILEMODE_BLOB,
            });
        });
        const resolved = [...found.values()];
        await runPool(resolved, BLOB_WRITE_CONCURRENCY, async (entry) => {
            entry.size = await this.objectSize(entry.hash);
        });
        return found;
    }

    private async objectSize(hash: string): Promise<number> {
        const sized = await this.readGitDir(["cat-file", "-s", hash], {
            ignoreErrors: true,
        });
        const parsed = Number.parseInt(sized.stdout.trim(), 10);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
        return 0;
    }

    private async resetIndexToHead(): Promise<void> {
        if (await this.headExists()) {
            await this.mutate(["reset", "HEAD"], { worktree: "none" });
        } else {
            // Unborn HEAD: there is no commit to reset to, so clearing the
            // index file empties the staging area instead.
            await this.ensureReady();
            const indexPath = `${MEM_GITDIR}/index`;
            if (this.lg2.fs.analyzePath(indexPath).exists) {
                this.lg2.fs.unlink(indexPath);
                await this.syncOut();
            }
        }
    }

    private async headExists(): Promise<boolean> {
        const result = await this.readGitDir(["rev-parse", "HEAD"], {
            ignoreErrors: true,
        });
        return /^[0-9a-f]{40}$/m.test(result.stdout);
    }

    async discard(filepath: string): Promise<void> {
        try {
            await this.ensureOdb();
            await this.lg2.run(MEM_ROOT, ["checkout", "--", filepath]);
            await this.worktreeMirror!.exportFiles([filepath]);
            await this.gitDirMirror!.syncOut();
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async discardAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        try {
            const currentStatus = status ?? (await this.status());
            const files = currentStatus.changed
                .filter(
                    (file) =>
                        file.workingDir !== "U" &&
                        (dir == undefined || file.path.startsWith(dir))
                )
                .map((file) => file.path);
            await this.ensureOdb();
            for (let i = 0; i < files.length; i += PATH_BATCH_SIZE) {
                const batch = files.slice(i, i + PATH_BATCH_SIZE);
                if (batch.length === 0) continue;
                await this.lg2.run(MEM_ROOT, ["checkout", "--", ...batch]);
                await this.worktreeMirror!.exportFiles(batch);
            }
            await this.gitDirMirror!.syncOut();
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    // ------------------------------------------------------------------
    // Committing
    // ------------------------------------------------------------------

    async commitAll({
        message,
        amend,
        status,
    }: {
        message: string;
        status?: Status;
        unstagedFiles?: UnstagedFile[];
        amend?: boolean;
    }): Promise<number | undefined> {
        this.silenceErrors += 1;
        try {
            await this.checkAuthorInfo();
            await this.stageAll({ status });
            return await this.commit({ message, amend });
        } finally {
            this.silenceErrors -= 1;
        }
    }

    async commit({
        message,
        amend,
    }: {
        message: string;
        amend?: boolean;
    }): Promise<number | undefined> {
        return this.withGitOperation(GitOperation.commit, async () => {
            try {
                await this.checkAuthorInfo();
                const formattedMessage =
                    await this.formatCommitMessage(message);
                const mergeHead = normalizePath(
                    `${this.getGitDirVaultPath()}/MERGE_HEAD`
                );
                const mergeInProgress = await this.adapter.exists(mergeHead);
                if (this.useVaultGit() && !amend && !mergeInProgress) {
                    return await this.commitToVault(formattedMessage);
                }
                return await this.commitWithLg2(
                    formattedMessage,
                    amend === true
                );
            } catch (error) {
                this.reportError(error);
                throw error;
            }
        });
    }

    private async commitWithLg2(
        formattedMessage: string,
        amend: boolean
    ): Promise<number | undefined> {
        const status = await this.status();
        if (status.staged.length === 0 && !amend) {
            return 0;
        }
        if (amend) {
            const parentExists = await this.readGitDir(
                ["rev-parse", "HEAD~1"],
                { ignoreErrors: true }
            );
            if (!/^[0-9a-f]{40}$/m.test(parentExists.stdout)) {
                throw new Error(
                    "Amending the initial commit is not supported with the wasm-git engine."
                );
            }
        }
        await this.ensureOdb();
        try {
            if (amend) {
                await this.lg2.run(MEM_ROOT, ["reset", "--soft", "HEAD~1"]);
            }
            await this.lg2.run(MEM_ROOT, ["commit", "-m", formattedMessage]);
        } catch (error) {
            this.gitDirLoaded = false;
            this.gitOdbLoaded = false;
            throw error;
        }
        await this.gitDirMirror!.syncOut();
        this.plugin.localStorage.setConflict(false);
        return status.staged.length;
    }

    /**
     * Writes a commit from the vault index without starting wasm.
     * iOS jetsams if `commit` copies `.git` into MEMFS.
     */
    private async commitToVault(
        formattedMessage: string
    ): Promise<number | undefined> {
        this.plugin.crashLog?.log("commit-vault-start");
        if (Platform.isMobileApp) {
            new Notice("Git: committing…", 8000);
        }
        const entries = await this.readIndexEntriesFromVault();
        const index = new Map(
            entries
                .filter((entry) => entry.stage === 0)
                .map((entry) => [entry.path, entry])
        );
        const parent = await this.resolveHeadCommitHash();
        const headBlobs = await this.readHeadBlobMap();
        const changed = countIndexDiff(index, headBlobs);
        const { tree, objects } = await this.cpu.writeTreeFromIndex(entries);
        for (const object of objects) {
            await this.writeCompressedLooseObject(
                object.hash,
                object.compressed
            );
        }
        this.plugin.crashLog?.log("commit-vault-tree", { tree, changed });
        if (parent != undefined && changed === 0) {
            const parentCommit = await this.readGitObject(parent);
            if (parentCommit?.type === "commit") {
                const parsed = parseCommitObject(
                    new TextDecoder("utf-8").decode(parentCommit.payload)
                );
                if (parsed?.tree === tree) {
                    this.plugin.crashLog?.log("commit-vault-empty");
                    return 0;
                }
            }
        }
        const author = await this.readAuthorSignature();
        const payload = serializeGitCommit({
            tree,
            parents: parent == undefined ? [] : [parent],
            author,
            committer: author,
            message: formattedMessage,
        });
        const hash = await this.writeLooseObject("commit", payload);
        await this.updateBranchRef(hash);
        this.plugin.crashLog?.log("commit-vault-done", { hash });
        this.app.workspace.trigger("obsidian-git:head-change");
        return changed;
    }

    private async readAuthorSignature(): Promise<GitSignature> {
        const name = await this.getConfig("user.name");
        const email = await this.getConfig("user.email");
        if (!name || !email) {
            throw Error(
                "Git author name and email are not set. Please set both fields in the settings."
            );
        }
        return {
            name,
            email,
            epochSeconds: Math.floor(Date.now() / 1000),
            tz: gitTimezoneOffset(),
        };
    }

    private async writeLooseObject(
        type: string,
        payload: Uint8Array
    ): Promise<string> {
        const { hash, compressed } = await this.cpu.gitObjectStore(
            type,
            payload
        );
        await this.writeCompressedLooseObject(hash, compressed);
        return hash;
    }

    private async writeCompressedLooseObject(
        hash: string,
        compressed: Uint8Array
    ): Promise<void> {
        const vaultPath = normalizePath(
            looseObjectVaultPath(this.getGitDirVaultPath(), hash)
        );
        if (await this.adapter.exists(vaultPath)) return;
        await this.ensureVaultDir(parentOfVault(vaultPath));
        await this.adapter.writeBinary(vaultPath, toArrayBuffer(compressed));
    }

    private async ensureVaultDir(path: string): Promise<void> {
        if (path === "" || (await this.adapter.exists(path))) return;
        await this.ensureVaultDir(parentOfVault(path));
        await this.adapter.mkdir(path);
    }

    private async updateBranchRef(commitHash: string): Promise<void> {
        const gitDir = this.getGitDirVaultPath();
        const headPath = normalizePath(`${gitDir}/HEAD`);
        const head = (await this.readVaultText(headPath)).trim();
        const ref = head.match(/^ref:\s+(.*)$/)?.[1];
        const body = `${commitHash}\n`;
        const bytes = new TextEncoder().encode(body);
        if (ref) {
            const refPath = normalizePath(`${gitDir}/${ref}`);
            await this.ensureVaultDir(parentOfVault(refPath));
            await this.adapter.writeBinary(refPath, toArrayBuffer(bytes));
            return;
        }
        await this.adapter.writeBinary(headPath, toArrayBuffer(bytes));
    }

    private async checkAuthorInfo(): Promise<void> {
        const name = await this.getConfig("user.name");
        const email = await this.getConfig("user.email");
        if (!name || !email) {
            throw Error(
                "Git author name and email are not set. Please set both fields in the settings."
            );
        }
    }

    // ------------------------------------------------------------------
    // Remote operations
    // ------------------------------------------------------------------

    async pull(): Promise<FileStatusResult[] | undefined> {
        const progressNotice = this.showNotice("Initializing pull");
        return this.withGitOperation(GitOperation.pull, async () => {
            try {
                await this.checkAuthorInfo();
                const localCommit = await this.revParse("HEAD");
                await this.fetchInternal(undefined, progressNotice);
                const branchInfo = await this.branchInfo();
                if (!branchInfo.tracking) {
                    throw new Error(
                        "No upstream branch is set. Please set one in the settings or via the 'Edit remotes' command."
                    );
                }

                const trackingCommit = await this.revParse(branchInfo.tracking);
                if (localCommit !== trackingCommit) {
                    await this.integrateFetched(
                        this.plugin.settings.syncMethod ?? "merge",
                        branchInfo
                    );
                }

                progressNotice?.hide();
                const upstreamCommit = await this.revParse("HEAD");
                const changedFiles =
                    localCommit && upstreamCommit
                        ? await this.getFileChangesCount(
                              localCommit,
                              upstreamCommit
                          )
                        : [];
                this.showNotice("Finished pull", false);
                return changedFiles.map<FileStatusResult>((file) => ({
                    path: file.path,
                    workingDir: "P",
                    index: "P",
                    vaultPath: this.getRelativeVaultPath(file.path),
                }));
            } catch (error) {
                progressNotice?.hide();
                this.reportError(error);
                throw error;
            }
        });
    }

    private async integrateFetched(
        method: SyncMethod,
        branchInfo: BranchInfo
    ): Promise<void> {
        switch (method) {
            case "merge":
                await this.mergeTracking(branchInfo);
                return;
            case "rebase":
                await this.rebaseTracking(branchInfo);
                return;
            case "reset":
                await this.resetTracking(branchInfo);
                return;
            default: {
                const _exhaustive: never = method;
                throw new Error(`Unknown sync method: ${String(_exhaustive)}`);
            }
        }
    }

    private async mergeTracking(branchInfo: BranchInfo): Promise<void> {
        const mergeResult = await this.withAuthRetry(() =>
            this.mutate(["merge", branchInfo.tracking!], {
                ignoreErrors: true,
            })
        );
        const conflicted = this.parseMergeConflicts(mergeResult.stderr);
        if (conflicted.length > 0) {
            await this.handleMergeConflicts(conflicted, branchInfo);
        } else if (/Bad news:|\s\[-?\d+\]/m.test(mergeResult.stderr)) {
            throw new Error(
                `Pull failed (merge): ${mergeResult.stderr.trim()}`
            );
        }
    }

    private async rebaseTracking(branchInfo: BranchInfo): Promise<void> {
        await this.syncIn();
        try {
            await rebaseOnto(
                this.createRebaseHost(),
                branchInfo.tracking!,
                this.plugin.settings.mergeStrategy
            );
            this.app.workspace.trigger("obsidian-git:head-change");
        } catch (error) {
            if (error instanceof RebaseConflictError) {
                this.plugin.localStorage.setConflict(true);
                await this.syncOut();
                await this.plugin.handleConflict(
                    error.conflicted.map((path) =>
                        this.getRelativeVaultPath(path)
                    )
                );
                throw new Error(`Pull failed (rebase): ${error.message}`);
            }
            throw new Error(
                `Pull failed (rebase): ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        } finally {
            await this.syncOut();
        }
    }

    private async resetTracking(branchInfo: BranchInfo): Promise<void> {
        try {
            await this.mutate(["reset", branchInfo.tracking!]);
        } catch (error) {
            throw new Error(
                `Sync failed (reset): ${error instanceof Error ? error.message : String(error)}`
            );
        }
        this.app.workspace.trigger("obsidian-git:head-change");
    }

    private createRebaseHost(): RebaseHost {
        return {
            listCommits: async (range) => {
                const result = await this.lg2.run(
                    MEM_ROOT,
                    ["rev-list", range],
                    { ignoreErrors: true }
                );
                return result.stdout
                    .split("\n")
                    .filter((line) => /^[0-9a-f]{40}$/.test(line))
                    .reverse();
            },
            readCommit: async (hash) => {
                const result = await this.lg2.run(
                    MEM_ROOT,
                    ["cat-file", "-p", hash],
                    { ignoreErrors: true }
                );
                return parseCommitObject(result.stdout);
            },
            nameStatus: async (from, to) => {
                const result = await this.lg2.run(
                    MEM_ROOT,
                    ["diff", "--name-status", from, to],
                    { ignoreErrors: true }
                );
                return parseNameStatus(result.stdout);
            },
            readBlob: async (rev, path) => {
                const result = await this.lg2.run(
                    MEM_ROOT,
                    ["cat-file", "-p", `${rev}:${path}`],
                    { ignoreErrors: true }
                );
                if (containsLg2Error(result.stderr)) return undefined;
                return result.stdout;
            },
            readWorktree: (path) => {
                const memPath = `${MEM_ROOT}/${path}`;
                if (!this.lg2.fs.analyzePath(memPath).exists) return undefined;
                if (this.lg2.fs.isDir(this.lg2.fs.stat(memPath).mode)) {
                    return undefined;
                }
                return this.lg2.fs.readFile(memPath, { encoding: "utf8" });
            },
            writeWorktree: (path, content) => {
                const memPath = `${MEM_ROOT}/${path}`;
                this.ensureMemDir(parentMemPath(memPath));
                this.lg2.fs.writeFile(memPath, content);
            },
            unlinkWorktree: (path) => {
                const memPath = `${MEM_ROOT}/${path}`;
                if (this.lg2.fs.analyzePath(memPath).exists) {
                    this.lg2.fs.unlink(memPath);
                }
            },
            resetHard: async (rev) => {
                const hard = await this.lg2.run(
                    MEM_ROOT,
                    ["reset", "--hard", rev],
                    { ignoreErrors: true }
                );
                if (!containsLg2Error(hard.stderr)) return;
                await this.lg2.run(MEM_ROOT, ["reset", rev]);
                await this.lg2.run(MEM_ROOT, ["checkout", "--force", "HEAD"], {
                    ignoreErrors: true,
                });
            },
            add: async (paths) => {
                await this.stageMemfsPaths(paths);
            },
            commit: async (message) => {
                await this.lg2.run(MEM_ROOT, ["commit", "-m", message]);
            },
        };
    }

    private parseMergeConflicts(stderr: string): string[] {
        const conflicted: string[] = [];
        for (const line of stderr.split("\n")) {
            const match = line.match(/^conflict: a:(.*) o:(.*) t:(.*)$/);
            if (!match) continue;
            const path = [match[2], match[3], match[1]].find(
                (candidate) => candidate && candidate !== "NULL"
            );
            if (path && !conflicted.includes(path)) {
                conflicted.push(path);
            }
        }
        return conflicted;
    }

    /**
     * Applies the configured merge strategy to conflicted files. Files with
     * standard conflict markers are auto-resolved for the "ours"/"theirs"
     * strategies; everything else is handed to the user like on desktop.
     */
    private async handleMergeConflicts(
        conflicted: string[],
        branchInfo: BranchInfo
    ): Promise<void> {
        const strategy = this.plugin.settings.mergeStrategy;
        if (strategy !== "none") {
            const unresolved: string[] = [];
            for (const path of conflicted) {
                const memPath = `${MEM_ROOT}/${path}`;
                if (!this.lg2.fs.analyzePath(memPath).exists) {
                    unresolved.push(path);
                    continue;
                }
                const content = this.lg2.fs.readFile(memPath, {
                    encoding: "utf8",
                });
                const resolved = resolveConflictMarkers(content, strategy);
                if (resolved == undefined) {
                    unresolved.push(path);
                    continue;
                }
                this.lg2.fs.writeFile(memPath, resolved);
            }
            if (unresolved.length === 0) {
                await this.worktreeMirror!.exportFiles(conflicted);
                await this.addPaths(conflicted);
                await this.mutate(
                    ["commit", "-m", `Merge branch '${branchInfo.tracking}'`],
                    { worktree: "none" }
                );
                return;
            }
        }
        await this.syncOut();
        this.plugin.localStorage.setConflict(true);
        await this.plugin.handleConflict(
            conflicted.map((path) => this.getRelativeVaultPath(path))
        );
        throw new Error(
            `You have conflicts in ${conflicted.length} ${
                conflicted.length === 1 ? "file" : "files"
            }`
        );
    }

    async push(): Promise<number | undefined | null> {
        if (!(await this.canPush())) {
            return 0;
        }
        const progressNotice = this.showNotice("Initializing push");
        return this.withGitOperation(GitOperation.push, async () => {
            try {
                const branchInfo = await this.branchInfo();
                const remote = await this.getCurrentRemote();
                if (remote !== "origin") {
                    throw new Error(
                        "The wasm-git engine can only push to the 'origin' remote."
                    );
                }
                let numChangedFiles = 0;
                if (branchInfo.current && branchInfo.tracking) {
                    const trackingOid = await this.revParse(
                        branchInfo.tracking
                    );
                    if (trackingOid) {
                        numChangedFiles = (
                            await this.getFileChangesCount(
                                branchInfo.current,
                                branchInfo.tracking
                            )
                        ).length;
                    }
                }
                await this.withAuthRetry(async () => {
                    await this.uploadLfsForPush();
                    return this.mutate(["push"], { worktree: "none" });
                });
                if (branchInfo.current && !branchInfo.tracking) {
                    // lg2's push always pushes the current branch to the
                    // same-named branch on origin; record that as upstream.
                    await this.setConfig(
                        `branch.${branchInfo.current}.remote`,
                        "origin"
                    );
                    await this.setConfig(
                        `branch.${branchInfo.current}.merge`,
                        `refs/heads/${branchInfo.current}`
                    );
                }
                progressNotice?.hide();
                return numChangedFiles;
            } catch (error) {
                progressNotice?.hide();
                if (!(error instanceof NoNetworkError)) {
                    this.reportError(error);
                }
                throw error;
            }
        });
    }

    async fetch(remote?: string): Promise<void> {
        const progressNotice = this.showNotice("Initializing fetch");
        try {
            await this.fetchInternal(remote, progressNotice);
            progressNotice?.hide();
        } catch (error) {
            progressNotice?.hide();
            this.reportError(error);
            throw error;
        }
    }

    private async fetchInternal(
        remote: string | undefined,
        progressNotice: Notice | undefined
    ): Promise<void> {
        const remoteName = remote ?? (await this.getCurrentRemote());
        await this.withAuthRetry(() =>
            this.mutate(["fetch", remoteName], {
                worktree: "none",
                onProgress: (line) => {
                    if (
                        progressNotice &&
                        (line.startsWith("Received") ||
                            line.startsWith("remote:"))
                    ) {
                        progressNotice.setMessage(`Fetching: ${line}`);
                    }
                },
            })
        );
    }

    async getUnpushedCommits(): Promise<number> {
        const branchInfo = await this.branchInfoFromVault();
        if (!branchInfo.current || !branchInfo.tracking) {
            return 0;
        }
        const head = await this.resolveVaultRef("HEAD");
        const tracking = await this.resolveVaultRef(branchInfo.tracking);
        if (!head) return 0;
        if (!tracking) return 1;
        if (head === tracking) return 0;
        const walked = await this.countUnpushedLooseCommits(head, tracking);
        if (walked != undefined) return walked;
        const fromLog = await this.countUnpushedFromBranchLog(
            branchInfo.current,
            tracking
        );
        if (fromLog != undefined) return fromLog;
        return 1;
    }

    async canPush(): Promise<boolean> {
        const branchInfo = await this.branchInfoFromVault();
        if (!branchInfo.current) return false;
        const current = await this.resolveVaultRef(branchInfo.current);
        if (!current) return false;
        if (!branchInfo.tracking) return true;
        const tracking = await this.resolveVaultRef(branchInfo.tracking);
        if (!tracking) return true;
        return current !== tracking;
    }

    // ------------------------------------------------------------------
    // Repository and branches
    // ------------------------------------------------------------------

    async checkRequirements(): Promise<"valid" | "missing-repo"> {
        const headExists = await this.adapter.exists(
            normalizePath(`${this.getGitDirVaultPath()}/HEAD`)
        );
        return headExists ? "valid" : "missing-repo";
    }

    async branchInfo(): Promise<BranchInfo & { remote: string }> {
        try {
            return await this.branchInfoFromVault();
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    /**
     * Branch name, remotes, and tracking from `.git` text files. Does not
     * start wasm. Commit used to call this via `hasTooBigFiles` and then
     * `gitDir-syncIn` jetsamed iOS.
     */
    private async branchInfoFromVault(): Promise<
        BranchInfo & { remote: string }
    > {
        const current = await this.readCurrentBranchFromVault();
        const packed = await this.readPackedRefsFromVault();
        const looseHeads = await this.listLooseRefs("refs/heads");
        const branches = [
            ...new Set([...looseHeads.keys(), ...packedHeadNames(packed)]),
        ].sort();
        let tracking: string | undefined;
        let remote = "origin";
        if (current) {
            remote =
                (await this.getConfig(`branch.${current}.remote`)) ?? "origin";
            const mergeRef = await this.getConfig(`branch.${current}.merge`);
            const trackingBranch = mergeRef?.startsWith("refs/heads/")
                ? mergeRef.substring("refs/heads/".length)
                : mergeRef;
            tracking = trackingBranch
                ? `${remote}/${trackingBranch}`
                : undefined;
        }
        return { current, tracking, branches, remote };
    }

    async getCurrentRemote(): Promise<string> {
        const branchInfo = await this.branchInfo();
        return branchInfo.remote;
    }

    async checkout(branch: string, remote?: string): Promise<void> {
        try {
            const args = ["checkout"];
            if (remote) args.push("--force");
            args.push(remote ? `${remote}/${branch}` : branch);
            await this.mutate(args);
            if (remote) {
                // Checking out `remote/branch` leaves a local branch behind;
                // make sure HEAD points at the plain branch name.
                await this.mutate(["checkout", branch]);
            }
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async createBranch(branch: string): Promise<void> {
        try {
            await this.mutate(["checkout", "-b", branch], { worktree: "none" });
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async deleteBranch(branch: string, force: boolean): Promise<void> {
        try {
            await this.ensureReady();
            const branchInfo = await this.branchInfo();
            if (branchInfo.current === branch) {
                throw new Error(
                    `Cannot delete branch '${branch}' while it is checked out.`
                );
            }
            if (!branchInfo.branches.includes(branch)) {
                throw new Error(`Branch '${branch}' not found.`);
            }
            if (!force && !(await this.branchIsMerged(branch))) {
                throw new Error(
                    `The branch '${branch}' is not fully merged. Use force delete to delete it anyway.`
                );
            }
            // lg2 has no `branch` command, so the ref is removed directly:
            // as a loose ref file and, if present, from packed-refs.
            const looseRef = `${MEM_GITDIR}/refs/heads/${branch}`;
            if (this.lg2.fs.analyzePath(looseRef).exists) {
                this.lg2.fs.unlink(looseRef);
            }
            const packedRefsPath = `${MEM_GITDIR}/packed-refs`;
            if (this.lg2.fs.analyzePath(packedRefsPath).exists) {
                const packed = this.lg2.fs.readFile(packedRefsPath, {
                    encoding: "utf8",
                });
                const filtered = packed
                    .split("\n")
                    .filter((line) => !line.endsWith(` refs/heads/${branch}`))
                    .join("\n");
                this.lg2.fs.writeFile(packedRefsPath, filtered);
            }
            await this.syncOut();
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async branchIsMerged(branch: string): Promise<boolean> {
        const result = await this.readGitDir(
            ["rev-list", branch, "--not", "HEAD"],
            { ignoreErrors: true }
        );
        return !/^[0-9a-f]{40}$/m.test(result.stdout);
    }

    async init(): Promise<void> {
        try {
            await this.ensureReady();
            await this.mutate(["init", "."], { worktree: "none" });
            this.gitDirLoaded = true;
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async clone(url: string, _dir: string, depth?: number): Promise<void> {
        const progressNotice = this.showNotice("Initializing clone");
        try {
            if (depth != undefined) {
                new Notice(
                    "Shallow clones are not supported by the wasm-git engine. Performing a full clone instead."
                );
            }
            // The base path may have been changed right before this call;
            // rebuild the mirrors so they match the clone target.
            if (!this.lg2.initialized) {
                await this.lg2.init();
            }
            this.buildMirrors();
            await this.syncIn();
            const fs = this.lg2.fs;
            const cloneDir = "/clone-tmp";
            await this.withAuthRetry(() =>
                this.lg2.run("/", ["clone", url, cloneDir], {
                    onProgress: (line) => {
                        if (progressNotice && line.startsWith("net")) {
                            progressNotice.setMessage(`Cloning: ${line}`);
                        }
                    },
                })
            );
            if (fs.analyzePath(`${MEM_GITDIR}/HEAD`).exists) {
                throw new Error(
                    "A git repository already exists at the clone target."
                );
            }
            const head = fs
                .readFile(`${cloneDir}/.git/HEAD`, { encoding: "utf8" })
                .trim();
            const branch = head.match(/^ref: refs\/heads\/(.*)$/)?.[1];
            if (fs.analyzePath(MEM_GITDIR).exists) {
                // The mirror pre-creates the (empty) directory; remove it so
                // the cloned .git can be moved into place.
                removeMemTree(fs, MEM_GITDIR);
            }
            fs.rename(`${cloneDir}/.git`, MEM_GITDIR);
            removeMemTree(fs, cloneDir);
            // Materialize the working tree in place. This intentionally
            // overwrites clashing vault files, matching the previous
            // isomorphic-git behavior of cloning into a non-empty vault.
            await this.lg2.run(MEM_ROOT, [
                "checkout",
                "--force",
                branch ?? "HEAD",
            ]);
            this.gitDirLoaded = true;
            this.gitOdbLoaded = true;
            await this.syncOut();
            progressNotice?.hide();
        } catch (error) {
            progressNotice?.hide();
            this.reportError(error);
            throw error;
        }
    }

    // ------------------------------------------------------------------
    // Config and remotes
    // ------------------------------------------------------------------

    async setConfig(
        path: string,
        value: string | number | boolean | undefined
    ): Promise<void> {
        try {
            await this.ensureReady();
            if (value == undefined) {
                // lg2's config command cannot unset values; edit the config
                // file directly instead.
                const configPath = `${MEM_GITDIR}/config`;
                if (this.lg2.fs.analyzePath(configPath).exists) {
                    const content = this.lg2.fs.readFile(configPath, {
                        encoding: "utf8",
                    });
                    this.lg2.fs.writeFile(
                        configPath,
                        removeConfigKey(content, path)
                    );
                    await this.syncOut();
                }
            } else {
                await this.mutate(["config", path, String(value)], {
                    worktree: "none",
                });
            }
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async getConfig(path: string): Promise<string | undefined> {
        const fromVault = await this.readConfigFromVault(path);
        if (fromVault != undefined || !this.lg2.initialized) {
            return fromVault;
        }
        await this.ensureReady();
        const result = await this.lg2.run(MEM_ROOT, ["config", path], {
            ignoreErrors: true,
        });
        const value = result.stdout;
        if (value === "" || value.startsWith("Unable to get configuration")) {
            return undefined;
        }
        return value;
    }

    private async readConfigFromVault(
        dottedKey: string
    ): Promise<string | undefined> {
        const configPath = normalizePath(`${this.getGitDirVaultPath()}/config`);
        if (!(await this.adapter.exists(configPath))) return undefined;
        return parseGitConfigValue(
            await this.readVaultText(configPath),
            dottedKey
        );
    }

    async setRemote(name: string, url: string): Promise<void> {
        try {
            await this.writeVaultGitConfig((content) => {
                let next = upsertGitConfigValue(
                    content,
                    `remote.${name}.url`,
                    url
                );
                if (!parseGitConfigValue(next, `remote.${name}.fetch`)) {
                    next = upsertGitConfigValue(
                        next,
                        `remote.${name}.fetch`,
                        `+refs/heads/*:refs/remotes/${name}/*`
                    );
                }
                return next;
            });
        } catch (error) {
            this.reportError(error);
            throw error;
        }
    }

    async getRemotes(): Promise<string[]> {
        const configPath = normalizePath(`${this.getGitDirVaultPath()}/config`);
        if (!(await this.adapter.exists(configPath))) return [];
        return listGitConfigSubsections(
            await this.readVaultText(configPath),
            "remote"
        );
    }

    async getRemoteUrl(remote: string): Promise<string | undefined> {
        return this.getConfig(`remote.${remote}.url`);
    }

    async removeRemote(remoteName: string): Promise<void> {
        await this.writeVaultGitConfig((content) =>
            removeGitConfigSection(content, "remote", remoteName)
        );
    }

    private async writeVaultGitConfig(
        mutate: (content: string) => string
    ): Promise<void> {
        const configPath = normalizePath(`${this.getGitDirVaultPath()}/config`);
        const current = (await this.adapter.exists(configPath))
            ? await this.readVaultText(configPath)
            : "";
        const next = mutate(current);
        await this.adapter.writeBinary(
            configPath,
            toArrayBuffer(new TextEncoder().encode(next))
        );
        this.gitDirLoaded = false;
    }

    async getRemoteBranches(remote: string): Promise<string[]> {
        try {
            const result = await this.withAuthRetry(() =>
                this.readGitDir(["ls-remote", remote])
            );
            const branches = parseLsRemote(result.stdout)
                .filter((ref) => ref.refName.startsWith("refs/heads/"))
                .map(
                    (ref) =>
                        `${remote}/${ref.refName.substring("refs/heads/".length)}`
                );
            if (branches.length > 0) return branches;
        } catch {
            // Offline or unauthenticated: fall back to the locally known
            // remote-tracking branches below.
        }
        const refs = await this.readGitDir(["for-each-ref"], {
            ignoreErrors: true,
        });
        return parseForEachRef(refs.stdout)
            .filter(
                (ref) =>
                    ref.refName.startsWith(`refs/remotes/${remote}/`) &&
                    !ref.refName.endsWith("/HEAD")
            )
            .map((ref) => ref.refName.substring("refs/remotes/".length));
    }

    async updateUpstreamBranch(remoteBranch: string): Promise<void> {
        const [remote, branch] = splitRemoteBranch(remoteBranch);
        const branchInfo = await this.branchInfo();
        if (!branchInfo.current) {
            throw new Error("No branch is currently checked out.");
        }
        if (remote !== "origin" || branch !== branchInfo.current) {
            // lg2's push has no refspec support: it always pushes the
            // current branch to its namesake on origin. Still record the
            // requested upstream so pull merges the right branch.
            new Notice(
                "Note: the wasm-git engine always pushes the current branch to its namesake on 'origin'."
            );
        }
        await this.setConfig(`branch.${branchInfo.current}.remote`, remote);
        await this.setConfig(
            `branch.${branchInfo.current}.merge`,
            `refs/heads/${branch ?? branchInfo.current}`
        );
        await this.withAuthRetry(() =>
            this.mutate(["push"], { worktree: "none" })
        );
    }

    // ------------------------------------------------------------------
    // History and diffs
    // ------------------------------------------------------------------

    async log(
        file?: string,
        relativeToVault = true,
        limit?: number,
        ref?: string
    ): Promise<LogEntry[]> {
        const args = ["log"];
        if (limit != undefined) {
            args.push("-n", String(limit));
        }
        if (ref != undefined) {
            args.push(ref);
        }
        if (file != undefined) {
            args.push("--", this.getRelativeRepoPath(file, relativeToVault));
        }
        const result = await this.readGitDir(args, { ignoreErrors: true });
        const entries = parseLog(result.stdout);

        const logEntries: LogEntry[] = [];
        for (const entry of entries) {
            let files: DiffFile[] = [];
            const parent = await this.readGitDir(
                ["rev-parse", `${entry.hash}~1`],
                { ignoreErrors: true }
            );
            const parentHash = parent.stdout.match(/^[0-9a-f]{40}$/m)?.[0];
            if (parentHash) {
                const diff = await this.readGitDir(
                    ["diff", "--name-status", parentHash, entry.hash],
                    { ignoreErrors: true }
                );
                files = parseNameStatus(diff.stdout).map((item) => ({
                    path: item.path,
                    status: item.type,
                    vaultPath: this.getRelativeVaultPath(item.path),
                    hash: entry.hash,
                }));
            }
            logEntries.push({
                hash: entry.hash,
                date: entry.date.toISOString(),
                message: entry.message,
                body: entry.body,
                refs: [],
                diff: { changed: files.length, files },
                author: {
                    name: entry.authorName,
                    email: entry.authorEmail,
                },
            });
        }
        return logEntries;
    }

    async getFileChangesCount(
        commitHash1: string,
        commitHash2: string
    ): Promise<WalkDifference[]> {
        const result = await this.readGitDir(
            ["diff", "--name-status", commitHash1, commitHash2],
            { ignoreErrors: true }
        );
        return parseNameStatus(result.stdout);
    }

    async getDiffString(
        filePath: string,
        stagedChanges = false,
        hash?: string
    ): Promise<string> {
        if (hash) {
            const parent = await this.readGitDir(["rev-parse", `${hash}~1`], {
                ignoreErrors: true,
            });
            const parentHash = parent.stdout.match(/^[0-9a-f]{40}$/m)?.[0];
            if (parentHash) {
                const result = await this.readGitDir(
                    ["diff", "-p", parentHash, hash],
                    { ignoreErrors: true }
                );
                return extractFileDiff(result.stdout, filePath) ?? "";
            }
            // Root commit: synthesize an "added file" patch.
            const content = await this.readGitDir(
                ["cat-file", "-p", `${hash}:${filePath}`],
                { ignoreErrors: true }
            );
            return buildAddedFilePatch(filePath, content.stdout);
        }
        if (stagedChanges) {
            const result = await this.readGitDir(["diff", "--cached"], {
                ignoreErrors: true,
            });
            return extractFileDiff(result.stdout, filePath) ?? "";
        }
        await this.ensureOdb();
        await this.worktreeMirror!.importFiles([filePath]);
        // Path-limited `diff` is not reliable on lg2; import only this file
        // and extract its hunk from the full diff. Missing tracked files
        // show as deletions and are ignored by extractFileDiff.
        const result = await this.lg2.run(MEM_ROOT, ["diff"], {
            ignoreErrors: true,
        });
        return extractFileDiff(result.stdout, filePath) ?? "";
    }

    async getLastCommitTime(): Promise<Date | undefined> {
        const head = await this.resolveHeadCommitHash();
        if (!head) return undefined;
        const object = await this.readGitObject(head);
        if (object?.type === "commit") {
            const parsed = parseCommitObject(
                new TextDecoder("utf-8").decode(object.payload)
            );
            if (parsed) {
                return new Date(parsed.committer.epochSeconds * 1000);
            }
        }
        const logPath = normalizePath(`${this.getGitDirVaultPath()}/logs/HEAD`);
        if (!(await this.adapter.exists(logPath))) return undefined;
        const lines = (await this.readVaultText(logPath))
            .split("\n")
            .filter((line) => line.length > 0);
        for (let i = lines.length - 1; i >= 0; i--) {
            const epoch = parseReflogUnixSeconds(lines[i]!);
            if (epoch != undefined) return new Date(epoch * 1000);
        }
        return undefined;
    }

    async revParse(rev: string): Promise<string | undefined> {
        const result = await this.readGitDir(["rev-parse", rev], {
            ignoreErrors: true,
        });
        return result.stdout.match(/^[0-9a-f]{40}$/m)?.[0];
    }

    async catFileCommit(hash: string): Promise<ParsedCommitObject | undefined> {
        const result = await this.readGitDir(["cat-file", "-p", hash], {
            ignoreErrors: true,
        });
        return parseCommitObject(result.stdout);
    }

    // ------------------------------------------------------------------
    // Extended features unique to the wasm-git engine on mobile
    // ------------------------------------------------------------------

    /** Stashes all tracked changes in the working directory. */
    async stashPush(): Promise<string> {
        const result = await this.mutate(["stash", "push"]);
        return result.stdout;
    }

    /** Applies and drops the most recent stash. */
    async stashPop(): Promise<string> {
        const result = await this.mutate(["stash", "pop"]);
        return result.stdout;
    }

    /** Applies a stash by index without dropping it. */
    async stashApply(index = 0): Promise<string> {
        const result = await this.mutate(["stash", "apply", String(index)]);
        return result.stdout;
    }

    /** Drops a stash by index. */
    async stashDrop(index = 0): Promise<string> {
        const result = await this.mutate(["stash", "drop", String(index)]);
        return result.stdout;
    }

    /** Lists all stashes (`stash@{n}: message` per line). */
    async stashList(): Promise<string[]> {
        const result = await this.readGitDir(["stash", "list"], {
            ignoreErrors: true,
        });
        return result.stdout.split("\n").filter((line) => line.length > 0);
    }

    /**
     * Reverts the given commit in the working tree and index. The revert is
     * left staged for the user to commit; sequencer state files are cleaned
     * up so later commands are not blocked by an "unexpected state".
     */
    async revert(rev: string): Promise<void> {
        await this.mutate(["revert", rev]);
        for (const stateFile of ["REVERT_HEAD", "MERGE_MSG"]) {
            const path = `${MEM_GITDIR}/${stateFile}`;
            if (this.lg2.fs.analyzePath(path).exists) {
                this.lg2.fs.unlink(path);
            }
        }
        await this.syncOut();
    }

    /** Creates a (lightweight or annotated) tag at HEAD. */
    async tagCreate(name: string, message?: string): Promise<void> {
        const args = message ? ["tag", name, message] : ["tag", name];
        await this.mutate(args, { worktree: "none" });
    }

    /** Deletes a tag. */
    async tagDelete(name: string): Promise<void> {
        await this.mutate(["tag", "-d", name], { worktree: "none" });
    }

    /** Lists all tag names. */
    async tagList(): Promise<string[]> {
        const refs = await this.readGitDir(["for-each-ref"], {
            ignoreErrors: true,
        });
        return parseForEachRef(refs.stdout)
            .filter((ref) => ref.refName.startsWith("refs/tags/"))
            .map((ref) => ref.refName.substring("refs/tags/".length));
    }

    /**
     * Line-by-line blame in the porcelain-shaped {@link Blame} format used
     * by line authoring. Returns `"untracked"` when the path is not in the
     * index. wasm-git's blame has no `-C`/`-w` flags, so movement tracking
     * and whitespace ignoring are accepted for API compatibility only.
     */
    async blame(
        filePath: string,
        _trackMovement?: "inactive" | "same-commit" | "all-commits",
        _ignoreWhitespace?: boolean
    ): Promise<Blame | "untracked"> {
        const repoPath = this.getRelativeRepoPath(filePath);
        if (!(await this.isTracked(repoPath))) return "untracked";
        await this.ensureReady();
        await this.worktreeMirror!.importFiles([repoPath]);
        const result = await this.lg2.run(MEM_ROOT, ["blame", repoPath]);
        const lines = parseBlame(result.stdout);
        const commits = new Map<string, ParsedCommitObject>();
        const fullHashes = new Map<string, string>();
        for (const line of lines) {
            if (commits.has(line.hash)) continue;
            const full = (await this.revParse(line.hash)) ?? line.hash;
            fullHashes.set(line.hash, full);
            const commit = await this.catFileCommit(full);
            if (commit) commits.set(line.hash, commit);
        }
        return toPorcelainBlame(lines, commits, fullHashes);
    }

    async isTracked(path: string): Promise<boolean> {
        const repoPath = this.getRelativeRepoPath(path);
        const tracked = await this.lsFiles();
        return tracked.includes(repoPath);
    }

    async hashObject(filepath: string): Promise<string> {
        const repoPath = this.getRelativeRepoPath(filepath);
        await this.ensureReady();
        await this.worktreeMirror!.importFiles([repoPath]);
        const hashed = await this.lg2.run(MEM_ROOT, ["hash-object", repoPath], {
            ignoreErrors: true,
        });
        const hash = hashed.stdout.match(/^[0-9a-f]{40}$/m)?.[0];
        if (hash) return hash;
        const head = await this.revParse("HEAD");
        return head ?? "";
    }

    async submoduleAwareHeadRevisonInContainingDirectory(
        _filepath: string
    ): Promise<string> {
        return (await this.revParse("HEAD")) ?? "";
    }

    async getSubmodulePaths(): Promise<string[]> {
        return Promise.resolve([]);
    }

    async getSubmoduleOfFile(
        _repositoryRelativeFile: string
    ): Promise<{ submodule: string; relativeFilepath: string } | undefined> {
        return Promise.resolve(undefined);
    }

    async isFileTrackedByLFS(filePath: string): Promise<boolean> {
        const repoPath = this.getRelativeRepoPath(filePath);
        const rules = await this.readLfsAttributeRules();
        return isLfsTracked(repoPath, rules);
    }

    async show(
        commitHash: string,
        file: string,
        relativeToVault = true
    ): Promise<string> {
        const repoPath = this.getRelativeRepoPath(file, relativeToVault);
        // lg2's cat-file does not implement the `:path` index revision.
        // Resolve the staged blob via `ls-files -s` when no commit is given.
        if (commitHash === "") {
            const indexed = await this.readIndexFile(repoPath);
            if (indexed == undefined) {
                throw new Error(`exists on disk, but not in '${repoPath}'`);
            }
            return indexed;
        }
        const result = await this.readGitDir([
            "cat-file",
            "-p",
            `${commitHash}:${repoPath}`,
        ]);
        return result.stdout;
    }

    async diff(
        file: string,
        commit1: string,
        commit2: string
    ): Promise<string> {
        const result = await this.readGitDir(["diff", "-p", commit1, commit2], {
            ignoreErrors: true,
        });
        return extractFileDiff(result.stdout, file) ?? "";
    }

    /**
     * Applies a unified diff to the index (`git apply --cached`).
     * lg2 has no `apply` command, so the patch is applied in TypeScript to
     * the current index blob and written with the same blob/index engine as
     * `add` — never `lg2 add`, which OOB-traps on a sparse MEMFS worktree.
     */
    async applyPatch(patch: string): Promise<void> {
        const repoPath = extractPatchPath(patch);
        if (repoPath == undefined) {
            throw new Error("Patch is missing a +++ b/<path> header");
        }
        const safe = this.normalizeRepoPath(repoPath);
        if (safe == undefined) {
            throw new Error(`Patch path '${repoPath}' is not a file path`);
        }
        await this.ensureReady();
        const source = (await this.readIndexFile(safe)) ?? "";
        const patched = applyUnifiedPatch(source, patch);
        const data = new TextEncoder().encode(patched);
        let entries = this.readIndexEntries();
        entries = await this.stageBlob(entries, safe, data, Date.now());
        await this.persistIndex(entries);
    }

    /**
     * Soft-resets onto the tracking branch and recommits unpushed work as
     * one commit, reusing the previous HEAD message. No-op when there is
     * no tracking branch, fewer than two unpushed commits, staged but
     * uncommitted changes, or a merge in the unpushed range.
     */
    async squashAllUnpushedCommits(): Promise<void> {
        const branchInfo = await this.branchInfo();
        if (!branchInfo.tracking || !branchInfo.current) return;
        const remoteBranches = await this.getRemoteBranches(
            splitRemoteBranch(branchInfo.tracking)[0]
        );
        if (!remoteBranches.includes(branchInfo.tracking)) return;
        const status = await this.status();
        if (status.staged.length > 0) return;
        const unpushed = await this.getUnpushedCommits();
        if (unpushed < 2) return;
        const history = await this.log(undefined, false, unpushed);
        if (history.some((entry) => entry.message.startsWith("Merge"))) {
            return;
        }
        const oldHead = await this.revParse("HEAD");
        const tracking = await this.revParse(branchInfo.tracking);
        if (!oldHead || !tracking) return;
        const previous = await this.catFileCommit(oldHead);
        if (!previous) return;
        await this.withGitOperation(GitOperation.commit, async () => {
            await this.mutate(["reset", "--soft", tracking], {
                worktree: "none",
            });
            await this.mutate(["commit", "-m", previous.message.trim()], {
                worktree: "none",
            });
            this.app.workspace.trigger("obsidian-git:head-change");
        });
    }

    /** `git describe --tags` output, or undefined when nothing describes HEAD. */
    async describe(): Promise<string | undefined> {
        const result = await this.readGitDir(["describe", "--tags"], {
            ignoreErrors: true,
        });
        const description = result.stdout.trim();
        return description.length > 0 ? description : undefined;
    }

    /** All paths currently tracked in the index. */
    async lsFiles(): Promise<string[]> {
        const entries = await this.readIndexEntriesFromVault();
        return [
            ...new Set(
                entries.filter((entry) => entry.stage === 0).map((e) => e.path)
            ),
        ];
    }

    /**
     * Runs a raw lg2 command for the command palette. Returns the combined
     * output; never throws so the palette can display errors verbatim.
     */
    async rawCommand(command: string): Promise<string> {
        const args = splitCommandLine(command);
        if (args.length === 0) return "";
        await this.syncIn();
        await this.ensureOdb();
        let result;
        try {
            result = await this.lg2.run(MEM_ROOT, args, {
                ignoreErrors: true,
            });
        } finally {
            await this.syncOut();
        }
        return [result.stdout, result.stderr]
            .filter((part) => part.length > 0)
            .join("\n");
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    async updateBasePath(basePath: string): Promise<void> {
        this.plugin.settings.basePath = basePath;
        if (this.lg2.initialized) {
            this.buildMirrors();
            resetMemRepo(this.lg2);
        }
        return Promise.resolve();
    }

    private async readLfsAttributeRules(): Promise<LfsAttributeRule[]> {
        if (this.useVaultGit() || !this.lg2.initialized) {
            const rules: LfsAttributeRule[] = [];
            const vaultPath =
                this.plugin.settings.basePath === ""
                    ? ".gitattributes"
                    : `${this.plugin.settings.basePath}/.gitattributes`;
            if (await this.adapter.exists(vaultPath)) {
                rules.push(
                    ...parseGitAttributes(await this.readVaultText(vaultPath))
                );
            }
            const infoPath = normalizePath(
                `${this.getGitDirVaultPath()}/info/attributes`
            );
            if (await this.adapter.exists(infoPath)) {
                rules.push(
                    ...parseGitAttributes(await this.readVaultText(infoPath))
                );
            }
            return rules;
        }
        await this.ensureReady();
        const rules: LfsAttributeRule[] = [];
        const memAttributes = `${MEM_ROOT}/.gitattributes`;
        if (this.lg2.fs.analyzePath(memAttributes).exists) {
            rules.push(
                ...parseGitAttributes(
                    this.lg2.fs.readFile(memAttributes, { encoding: "utf8" })
                )
            );
        } else {
            const vaultPath =
                this.plugin.settings.basePath === ""
                    ? ".gitattributes"
                    : `${this.plugin.settings.basePath}/.gitattributes`;
            if (await this.adapter.exists(vaultPath)) {
                rules.push(
                    ...parseGitAttributes(await this.readVaultText(vaultPath))
                );
            }
        }
        const infoAttributes = `${MEM_GITDIR}/info/attributes`;
        if (this.lg2.fs.analyzePath(infoAttributes).exists) {
            rules.push(
                ...parseGitAttributes(
                    this.lg2.fs.readFile(infoAttributes, {
                        encoding: "utf8",
                    })
                )
            );
        }
        return rules;
    }

    private listWorktreeFiles(): string[] {
        const files: string[] = [];
        const walk = (dir: string, relative: string): void => {
            if (!this.lg2.fs.analyzePath(dir).exists) return;
            for (const name of this.lg2.fs.readdir(dir)) {
                if (name === "." || name === "..") continue;
                if (relative === "" && name === ".git") continue;
                const childRel = relative === "" ? name : `${relative}/${name}`;
                const child = `${dir}/${name}`;
                if (this.lg2.fs.isDir(this.lg2.fs.stat(child).mode)) {
                    walk(child, childRel);
                } else {
                    files.push(childRel);
                }
            }
        };
        walk(MEM_ROOT, "");
        return files;
    }

    private async smudgeLfsWorktree(): Promise<void> {
        const rules = await this.readLfsAttributeRules();
        if (rules.length === 0) return;
        const pointers: { path: string; pointer: LfsPointer }[] = [];
        for (const path of this.listWorktreeFiles()) {
            if (!isLfsTracked(path, rules)) continue;
            const memPath = `${MEM_ROOT}/${path}`;
            if (!this.lg2.fs.analyzePath(memPath).exists) continue;
            if (this.lg2.fs.isDir(this.lg2.fs.stat(memPath).mode)) continue;
            const text = new TextDecoder().decode(
                this.lg2.fs.readFile(memPath)
            );
            const pointer = parseLfsPointer(text);
            if (pointer) pointers.push({ path, pointer });
        }
        if (pointers.length === 0) return;
        const objects = await this.downloadLfsObjects(
            pointers.map((entry) => entry.pointer)
        );
        for (const entry of pointers) {
            const data = objects.get(entry.pointer.sha256);
            if (data) {
                this.lg2.fs.writeFile(`${MEM_ROOT}/${entry.path}`, data);
            }
        }
    }

    private async uploadLfsForPush(): Promise<void> {
        await this.syncIn();
        const pointers = await this.collectPushLfsPointers();
        if (pointers.length === 0) return;
        const endpoint = await this.getLfsBatchEndpoint();
        if (endpoint == undefined) return;
        const getAuth = () => this.httpBridge.getAuthHeader();
        const batch = await lfsBatch(endpoint, "upload", pointers, getAuth);
        for (const object of batch) {
            if (object.error) {
                throw new Error(
                    `Git LFS upload failed for ${object.oid}: ${object.error.message}`
                );
            }
            const upload = object.actions?.upload;
            if (!upload) continue;
            const pointer = pointers.find((item) => item.sha256 === object.oid);
            if (!pointer) continue;
            const body = this.readLfsObjectBytes(pointer);
            if (!body) continue;
            await lfsTransfer(
                upload.href,
                "PUT",
                upload.header,
                toArrayBuffer(body),
                getAuth
            );
        }
    }

    private readLfsObjectBytes(pointer: LfsPointer): Uint8Array | undefined {
        const rules = this.readLfsAttributeRulesSync();
        for (const path of this.listWorktreeFiles()) {
            if (!isLfsTracked(path, rules)) continue;
            const memPath = `${MEM_ROOT}/${path}`;
            if (!this.lg2.fs.analyzePath(memPath).exists) continue;
            const data = this.lg2.fs.readFile(memPath);
            if (hashLfsContent(data) === pointer.sha256) return data;
        }
        return undefined;
    }

    private readLfsAttributeRulesSync(): LfsAttributeRule[] {
        const rules: LfsAttributeRule[] = [];
        const memAttributes = `${MEM_ROOT}/.gitattributes`;
        if (this.lg2.fs.analyzePath(memAttributes).exists) {
            rules.push(
                ...parseGitAttributes(
                    this.lg2.fs.readFile(memAttributes, { encoding: "utf8" })
                )
            );
        }
        const infoAttributes = `${MEM_GITDIR}/info/attributes`;
        if (this.lg2.fs.analyzePath(infoAttributes).exists) {
            rules.push(
                ...parseGitAttributes(
                    this.lg2.fs.readFile(infoAttributes, {
                        encoding: "utf8",
                    })
                )
            );
        }
        return rules;
    }

    private async downloadLfsObjects(
        pointers: LfsPointer[]
    ): Promise<Map<string, Uint8Array>> {
        const downloaded = new Map<string, Uint8Array>();
        const endpoint = await this.getLfsBatchEndpoint();
        if (endpoint == undefined) return downloaded;
        const getAuth = () => this.httpBridge.getAuthHeader();
        const unique = uniquePointers(pointers);
        const batch = await lfsBatch(endpoint, "download", unique, getAuth);
        for (const object of batch) {
            if (object.error) {
                throw new Error(
                    `Git LFS download failed for ${object.oid}: ${object.error.message}`
                );
            }
            const download = object.actions?.download;
            if (!download) continue;
            const data = await lfsTransfer(
                download.href,
                "GET",
                download.header,
                undefined,
                getAuth
            );
            downloaded.set(object.oid, data);
        }
        return downloaded;
    }

    private async collectPushLfsPointers(): Promise<LfsPointer[]> {
        const branchInfo = await this.branchInfo();
        const range = branchInfo.tracking
            ? `${branchInfo.tracking}..HEAD`
            : "HEAD";
        const listed = await this.lg2.run(MEM_ROOT, ["rev-list", range], {
            ignoreErrors: true,
        });
        const hashes = listed.stdout
            .split("\n")
            .filter((line) => /^[0-9a-f]{40}$/.test(line));
        const pointers = new Map<string, LfsPointer>();
        for (const hash of hashes) {
            const commit = parseCommitObject(
                (
                    await this.lg2.run(MEM_ROOT, ["cat-file", "-p", hash], {
                        ignoreErrors: true,
                    })
                ).stdout
            );
            if (!commit) continue;
            const parent = commit.parents[0];
            const diff = await this.lg2.run(
                MEM_ROOT,
                parent
                    ? ["diff", "--name-status", parent, hash]
                    : ["diff", "--name-status", hash],
                { ignoreErrors: true }
            );
            for (const file of parseNameStatus(diff.stdout)) {
                if (file.type === "D") continue;
                const blob = await this.lg2.run(
                    MEM_ROOT,
                    ["cat-file", "-p", `${hash}:${file.path}`],
                    { ignoreErrors: true }
                );
                if (containsLg2Error(blob.stderr)) continue;
                const pointer = parseLfsPointer(blob.stdout);
                if (pointer) pointers.set(pointer.sha256, pointer);
            }
        }
        return [...pointers.values()];
    }

    private async getLfsBatchEndpoint(): Promise<string | undefined> {
        const remotes = parseRemoteVerbose(
            (
                await this.lg2.run(MEM_ROOT, ["remote", "show", "-v"], {
                    ignoreErrors: true,
                })
            ).stdout
        );
        const remoteUrl = remotes.get("origin") ?? [...remotes.values()][0];
        if (!remoteUrl) return undefined;
        let configured: string | undefined;
        const lfsConfig = `${MEM_ROOT}/.lfsconfig`;
        if (this.lg2.fs.analyzePath(lfsConfig).exists) {
            configured = parseLfsConfigUrl(
                this.lg2.fs.readFile(lfsConfig, { encoding: "utf8" })
            );
        }
        return lfsBatchEndpoint(remoteUrl, configured);
    }

    private ensureMemDir(path: string): void {
        if (
            path === "" ||
            path === "/" ||
            this.lg2.fs.analyzePath(path).exists
        ) {
            return;
        }
        this.ensureMemDir(parentMemPath(path));
        this.lg2.fs.mkdir(path);
    }

    /** Reads the staged blob for `repoPath`, or undefined if it is untracked. */
    private async readIndexFile(repoPath: string): Promise<string | undefined> {
        const listed = await this.readGitDir(["ls-files", "-s"], {
            ignoreErrors: true,
        });
        const escaped = repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const hash = listed.stdout.match(
            new RegExp(`^[0-7]+ ([0-9a-f]{40})\\s+${escaped}$`, "m")
        )?.[1];
        if (hash) {
            const blob = await this.readGitDir(["cat-file", "-p", hash], {
                ignoreErrors: true,
            });
            return blob.stdout;
        }
        // lg2 may omit -s details or pathspecs; HEAD:path is the usual
        // index content when nothing is staged.
        const fromHead = await this.readGitDir(
            ["cat-file", "-p", `HEAD:${repoPath}`],
            { ignoreErrors: true }
        );
        return fromHead.stdout.length > 0 ? fromHead.stdout : undefined;
    }

    updateGitPath(_: string): Promise<void> {
        // wasm-git bundles its own git implementation.
        return Promise.resolve();
    }

    unload(): void {
        this.lg2.unload();
        this.cpu.terminate();
        this.worktreeMirror = undefined;
        this.gitDirMirror = undefined;
        this.gitDirLoaded = false;
        this.gitOdbLoaded = false;
        this.ensureReadyPromise = undefined;
        this.packStore.clear();
    }

    private reportError(error: unknown): void {
        if (this.silenceErrors > 0) return;
        this.plugin.displayError(error);
    }

    private showNotice(message: string, infinity = true): Notice | undefined {
        if (!this.plugin.settings.disablePopups) {
            return new Notice(
                message,
                infinity ? this.noticeLength : undefined
            );
        }
        return undefined;
    }
}

function packedHeadNames(packed: Map<string, string>): string[] {
    const names: string[] = [];
    for (const ref of packed.keys()) {
        if (ref.startsWith("refs/heads/")) {
            names.push(ref.substring("refs/heads/".length));
        }
    }
    return names;
}

type StageOp =
    | { kind: "skip" }
    | { kind: "remove"; path: string }
    | { kind: "upsert"; entry: GitIndexEntry };

function parentMemPath(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.substring(0, index);
}

function parentOfVault(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "" : path.substring(0, index);
}

function uniquePointers(pointers: LfsPointer[]): LfsPointer[] {
    const unique = new Map<string, LfsPointer>();
    for (const pointer of pointers) {
        unique.set(pointer.sha256, pointer);
    }
    return [...unique.values()];
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
}

function resetMemRepo(lg2: Lg2): void {
    if (lg2.fs.analyzePath(MEM_ROOT).exists) {
        removeMemTree(lg2.fs, MEM_ROOT);
    }
}

function removeMemTree(
    fs: {
        readdir(path: string): string[];
        stat(path: string): { mode: number };
        isDir(mode: number): boolean;
        unlink(path: string): void;
        rmdir(path: string): void;
    },
    path: string
): void {
    for (const name of fs.readdir(path)) {
        if (name === "." || name === "..") continue;
        const child = `${path}/${name}`;
        if (fs.isDir(fs.stat(child).mode)) {
            removeMemTree(fs, child);
        } else {
            fs.unlink(child);
        }
    }
    fs.rmdir(path);
}

function buildAddedFilePatch(path: string, content: string): string {
    if (content.length === 0) {
        return `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
    }
    const lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const body = lines.map((line) => `+${line}`).join("\n");
    return (
        `diff --git a/${path} b/${path}\n` +
        `new file mode 100644\n` +
        `--- /dev/null\n` +
        `+++ b/${path}\n` +
        `@@ -0,0 +1,${lines.length} @@\n` +
        body +
        "\n"
    );
}
