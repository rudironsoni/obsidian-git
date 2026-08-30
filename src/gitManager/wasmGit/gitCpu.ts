import { handleGitWorkerRequest } from "./gitWorkerHandlers";
import { sendGitHttpRequest } from "./httpBridge";
import type {
    GitCpuRequest,
    GitWorkerHttpRequestMsg,
    GitWorkerJob,
    GitWorkerReadyMsg,
    GitWorkerReply,
    GitWorkerRequest,
    GitWorkerResult,
} from "./gitWorkerProtocol";
import {
    GIT_CPU_WORKER_SOURCE,
    GIT_LG2_WORKER_SOURCE,
} from "./gitWorkerSource";
import type { GitIndexEntry } from "./gitIndex";
import type { MemDump } from "./memDump";
import wasmBinary from "wasm-git/lg2_async.wasm";

const WORKER_READY_MS = 15_000;

type WorkerEvent = GitWorkerReply | GitWorkerHttpRequestMsg | GitWorkerReadyMsg;

/**
 * Runs CPU git work and `lg2` commands off the plugin thread.
 * Staging uses a small CPU worker (no wasm-git glue). lg2 loads only
 * for push/pull/clone. Blob URLs stay alive: iOS WebKit drops the
 * worker if the URL is revoked in the same turn as `new Worker`.
 */
export class GitCpu {
    getAuthHeader: () => string | undefined = () => undefined;
    onEvent:
        | ((event: string, data?: Record<string, unknown>) => void)
        | undefined;

    private cpuWorker: Worker | undefined;
    private cpuWorkerUrl: string | undefined;
    private cpuReady: Promise<Worker | undefined> | undefined;
    private lg2Worker: Worker | undefined;
    private lg2WorkerUrl: string | undefined;
    private lg2ReadyPromise: Promise<Worker | undefined> | undefined;
    private lg2ModuleReady = false;
    private nextId = 1;
    private readonly pending = new Map<
        number,
        {
            resolve: (result: GitWorkerResult) => void;
            reject: (error: Error) => void;
        }
    >();

    async hashGitBlob(content: Uint8Array): Promise<string> {
        const result = await this.callCpu({ op: "hashGitBlob", content });
        if (result.op !== "hashGitBlob") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return result.hash;
    }

    async gitObjectStore(
        type: string,
        payload: Uint8Array
    ): Promise<{ hash: string; compressed: Uint8Array }> {
        const result = await this.callCpu({
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
        const result = await this.callCpu({
            op: "writeTreeFromIndex",
            entries,
        });
        if (result.op !== "writeTreeFromIndex") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return { tree: result.tree, objects: result.objects };
    }

    async writeGitIndex(entries: GitIndexEntry[]): Promise<Uint8Array> {
        const result = await this.callCpu({ op: "writeGitIndex", entries });
        if (result.op !== "writeGitIndex") {
            throw new Error(`git worker returned ${result.op}`);
        }
        return result.data;
    }

    canRunLg2(): boolean {
        return Boolean(GIT_LG2_WORKER_SOURCE) && typeof Worker !== "undefined";
    }

    async ensureLg2(): Promise<boolean> {
        if (!this.canRunLg2()) return false;
        const worker = await this.getLg2Worker();
        if (!worker) return false;
        if (this.lg2ModuleReady) return true;
        const wasmBytes = new Uint8Array(wasmBinary);
        const wasm = new ArrayBuffer(wasmBytes.byteLength);
        new Uint8Array(wasm).set(wasmBytes);
        const result = await this.post(worker, { op: "lg2Init" }, [wasm], wasm);
        if (result.op !== "lg2Init") {
            throw new Error(`git worker returned ${result.op}`);
        }
        this.lg2ModuleReady = true;
        return true;
    }

    async runLg2(args: {
        cwd: string;
        args: string[];
        dump: MemDump;
        ignoreErrors?: boolean;
    }): Promise<{ stdout: string; stderr: string; dump: MemDump }> {
        const worker = await this.getLg2Worker();
        if (!worker) {
            throw new Error("lg2 worker is not available");
        }
        const result = await this.post(worker, {
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
        this.dropCpuWorker();
        this.dropLg2Worker();
        for (const { reject } of this.pending.values()) {
            reject(new Error("git worker stopped"));
        }
        this.pending.clear();
    }

    private async callCpu(request: GitCpuRequest): Promise<GitWorkerResult> {
        const worker = await this.getCpuWorker();
        if (!worker) {
            return handleGitWorkerRequest(request);
        }
        return this.post(worker, request);
    }

    private async getCpuWorker(): Promise<Worker | undefined> {
        if (!this.cpuReady) {
            this.cpuReady = this.startWorker(
                GIT_CPU_WORKER_SOURCE,
                "cpu-worker"
            ).then((started) => {
                this.cpuWorker = started?.worker;
                this.cpuWorkerUrl = started?.url;
                return this.cpuWorker;
            });
        }
        return this.cpuReady;
    }

    private async getLg2Worker(): Promise<Worker | undefined> {
        if (!this.lg2ReadyPromise) {
            this.lg2ReadyPromise = this.startWorker(
                GIT_LG2_WORKER_SOURCE,
                "lg2-worker"
            ).then((started) => {
                this.lg2Worker = started?.worker;
                this.lg2WorkerUrl = started?.url;
                return this.lg2Worker;
            });
        }
        return this.lg2ReadyPromise;
    }

    private async startWorker(
        source: string | undefined,
        name: string
    ): Promise<{ worker: Worker; url: string } | undefined> {
        if (!source) return undefined;
        if (typeof Worker === "undefined") return undefined;
        this.onEvent?.("worker-start", { name, bytes: source.length });
        const blob = new Blob([source], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        try {
            await this.waitUntilReady(worker, name);
        } catch (error) {
            worker.terminate();
            URL.revokeObjectURL(url);
            this.onEvent?.("worker-start-failed", {
                name,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        worker.addEventListener(
            "message",
            (event: MessageEvent<WorkerEvent>) => {
                this.onMessage(event.data);
            }
        );
        worker.addEventListener("error", (event) => {
            this.onEvent?.("worker-error", {
                name,
                message: event.message,
            });
            if (name === "cpu-worker") this.dropCpuWorker();
            else this.dropLg2Worker();
        });
        this.onEvent?.("worker-ready", { name });
        return { worker, url };
    }

    private waitUntilReady(worker: Worker, name: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                reject(
                    new Error(
                        `${name} did not become ready within ${WORKER_READY_MS}ms`
                    )
                );
            }, WORKER_READY_MS);
            const onMessage = (event: MessageEvent<WorkerEvent>) => {
                if (event.data.kind !== "ready") return;
                window.clearTimeout(timer);
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                resolve();
            };
            const onError = (event: ErrorEvent) => {
                window.clearTimeout(timer);
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
                reject(new Error(`${name} failed: ${event.message}`));
            };
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", onError);
        });
    }

    private post(
        worker: Worker,
        request: GitWorkerRequest,
        transfer?: Transferable[],
        wasm?: ArrayBuffer
    ): Promise<GitWorkerResult> {
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
                reject(new Error("git worker postMessage failed"));
            }
        });
    }

    private onMessage(data: WorkerEvent): void {
        if (data.kind === "ready") return;
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
        const worker = this.lg2Worker;
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

    private dropCpuWorker(): void {
        const worker = this.cpuWorker;
        const url = this.cpuWorkerUrl;
        this.cpuWorker = undefined;
        this.cpuWorkerUrl = undefined;
        this.cpuReady = undefined;
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        this.failPending("cpu worker failed");
    }

    private dropLg2Worker(): void {
        const worker = this.lg2Worker;
        const url = this.lg2WorkerUrl;
        this.lg2Worker = undefined;
        this.lg2WorkerUrl = undefined;
        this.lg2ReadyPromise = undefined;
        this.lg2ModuleReady = false;
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        this.failPending("lg2 worker failed");
    }

    private failPending(message: string): void {
        for (const [id, { reject }] of this.pending) {
            this.pending.delete(id);
            reject(new Error(message));
        }
    }
}
