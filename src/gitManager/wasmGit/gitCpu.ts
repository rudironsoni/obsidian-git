import { handleGitWorkerRequest } from "./gitWorkerHandlers";
import { sendGitHttpRequest } from "./httpBridge";
import type {
    GitWorkerHttpRequestMsg,
    GitWorkerJob,
    GitWorkerReply,
    GitWorkerRequest,
    GitWorkerResult,
} from "./gitWorkerProtocol";
import { GIT_WORKER_SOURCE } from "./gitWorkerSource";
import type { GitIndexEntry } from "./gitIndex";
import type { MemDump } from "./memDump";
import wasmBinary from "wasm-git/lg2_async.wasm";

/**
 * Runs CPU git work and `lg2` commands off the plugin thread when a
 * Worker is available. Vault I/O and `requestUrl` stay on the plugin thread.
 */
export class GitCpu {
    getAuthHeader: () => string | undefined = () => undefined;

    private worker: Worker | undefined;
    private lg2Ready = false;
    private nextId = 1;
    private readonly pending = new Map<
        number,
        {
            resolve: (result: GitWorkerResult) => void;
            reject: (error: Error) => void;
        }
    >();

    async hashGitBlob(content: Uint8Array): Promise<string> {
        const result = await this.call({ op: "hashGitBlob", content });
        if (result.op !== "hashGitBlob") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return result.hash;
    }

    async gitObjectStore(
        type: string,
        payload: Uint8Array
    ): Promise<{ hash: string; compressed: Uint8Array }> {
        const result = await this.call({
            op: "gitObjectStore",
            type,
            payload,
        });
        if (result.op !== "gitObjectStore") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return { hash: result.hash, compressed: result.compressed };
    }

    async writeTreeFromIndex(entries: GitIndexEntry[]): Promise<{
        tree: string;
        objects: { hash: string; compressed: Uint8Array }[];
    }> {
        const result = await this.call({
            op: "writeTreeFromIndex",
            entries,
        });
        if (result.op !== "writeTreeFromIndex") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return { tree: result.tree, objects: result.objects };
    }

    async writeGitIndex(entries: GitIndexEntry[]): Promise<Uint8Array> {
        const result = await this.call({ op: "writeGitIndex", entries });
        if (result.op !== "writeGitIndex") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return result.data;
    }

    canRunLg2(): boolean {
        return Boolean(GIT_WORKER_SOURCE) && typeof Worker !== "undefined";
    }

    async ensureLg2(): Promise<boolean> {
        if (!this.canRunLg2()) return false;
        if (this.lg2Ready) return true;
        const wasmBytes = new Uint8Array(wasmBinary);
        const wasm = new ArrayBuffer(wasmBytes.byteLength);
        new Uint8Array(wasm).set(wasmBytes);
        const result = await this.call({ op: "lg2Init" }, [wasm], wasm);
        if (result.op !== "lg2Init") {
            throw new Error(`git worker returned ${result.op}`);
        }
        this.lg2Ready = true;
        return true;
    }

    async runLg2(args: {
        cwd: string;
        args: string[];
        dump: MemDump;
        ignoreErrors?: boolean;
    }): Promise<{ stdout: string; stderr: string; dump: MemDump }> {
        const result = await this.call({
            op: "lg2Run",
            cwd: args.cwd,
            args: args.args,
            dump: args.dump,
            ignoreErrors: args.ignoreErrors,
        });
        if (result.op !== "lg2Run") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            dump: result.dump,
        };
    }

    terminate(): void {
        const worker = this.worker;
        this.worker = undefined;
        this.lg2Ready = false;
        if (worker) worker.terminate();
        for (const { reject } of this.pending.values()) {
            reject(new Error("git worker stopped"));
        }
        this.pending.clear();
    }

    private async call(
        request: GitWorkerRequest,
        transfer?: Transferable[],
        wasm?: ArrayBuffer
    ): Promise<GitWorkerResult> {
        const worker = this.ensureWorker();
        if (!worker) {
            if (request.op === "lg2Init" || request.op === "lg2Run") {
                throw new Error("lg2 worker is not available");
            }
            return handleGitWorkerRequest(request);
        }
        const id = this.nextId;
        this.nextId += 1;
        const job: GitWorkerJob = { kind: "job", id, request, wasm };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                if (transfer && transfer.length > 0) {
                    worker.postMessage(job, transfer);
                } else {
                    worker.postMessage(job);
                }
            } catch {
                this.pending.delete(id);
                this.dropWorker();
                reject(new Error("git worker postMessage failed"));
            }
        });
    }

    private ensureWorker(): Worker | undefined {
        if (this.worker) return this.worker;
        if (!GIT_WORKER_SOURCE) return undefined;
        if (typeof Worker === "undefined") return undefined;
        try {
            const blob = new Blob([GIT_WORKER_SOURCE], {
                type: "text/javascript",
            });
            const url = URL.createObjectURL(blob);
            const worker = new Worker(url);
            URL.revokeObjectURL(url);
            worker.addEventListener(
                "message",
                (
                    event: MessageEvent<
                        GitWorkerReply | GitWorkerHttpRequestMsg
                    >
                ) => {
                    this.onMessage(event.data);
                }
            );
            worker.addEventListener("error", () => {
                this.dropWorker();
            });
            this.worker = worker;
            return worker;
        } catch {
            return undefined;
        }
    }

    private onMessage(data: GitWorkerReply | GitWorkerHttpRequestMsg): void {
        if (data.kind === "httpRequest") {
            void this.handleHttpRequest(data);
            return;
        }
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.ok) {
            pending.resolve(data.result);
        } else {
            pending.reject(new Error(data.error));
        }
    }

    private async handleHttpRequest(
        message: GitWorkerHttpRequestMsg
    ): Promise<void> {
        const worker = this.worker;
        if (!worker) return;
        try {
            const body = await sendGitHttpRequest(
                message.request,
                this.getAuthHeader
            );
            const copy = new Uint8Array(body.byteLength);
            copy.set(body);
            worker.postMessage(
                {
                    kind: "httpResponse",
                    id: message.id,
                    ok: true,
                    body: copy.buffer,
                },
                [copy.buffer]
            );
        } catch (error) {
            worker.postMessage({
                kind: "httpResponse",
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private dropWorker(): void {
        const worker = this.worker;
        this.worker = undefined;
        this.lg2Ready = false;
        if (worker) worker.terminate();
        for (const [id, { reject }] of this.pending) {
            this.pending.delete(id);
            reject(new Error("git worker failed"));
        }
    }
}
