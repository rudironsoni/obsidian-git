import { handleGitWorkerRequest } from "./gitWorkerHandlers";
import { setWorkerHttp, workerLg2Init, workerLg2Run } from "./gitWorkerLg2";
import type {
    GitHttpRequest,
    GitWorkerHttpResponseMsg,
    GitWorkerJob,
    GitWorkerReply,
    GitWorkerResult,
} from "./gitWorkerProtocol";

interface GitWorkerScope {
    addEventListener(
        type: "message",
        listener: (
            event: MessageEvent<GitWorkerJob | GitWorkerHttpResponseMsg>
        ) => void
    ): void;
    postMessage(message: unknown): void;
}

const scope = self as unknown as GitWorkerScope;
let nextHttpId = 1;
const pendingHttp = new Map<
    number,
    {
        resolve: (body: Uint8Array) => void;
        reject: (error: Error) => void;
    }
>();

setWorkerHttp(requestHttpFromHost);

scope.addEventListener("message", (event) => {
    const data = event.data;
    if ("kind" in data && data.kind === "httpResponse") {
        const pending = pendingHttp.get(data.id);
        if (!pending) return;
        pendingHttp.delete(data.id);
        if (data.ok) pending.resolve(new Uint8Array(data.body));
        else pending.reject(new Error(data.error));
        return;
    }
    void handleJob(data)
        .then((result) => {
            const reply: GitWorkerReply = { id: data.id, ok: true, result };
            scope.postMessage(reply);
        })
        .catch((error: unknown) => {
            const reply: GitWorkerReply = {
                id: data.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
            scope.postMessage(reply);
        });
});

async function handleJob(job: GitWorkerJob): Promise<GitWorkerResult> {
    const { request } = job;
    if (request.op === "lg2Init") {
        if (!job.wasm) throw new Error("lg2Init is missing wasm bytes");
        await workerLg2Init(job.wasm);
        return { op: "lg2Init" };
    }
    if (request.op === "lg2Run") {
        const ran = await workerLg2Run(request);
        return {
            op: "lg2Run",
            stdout: ran.result.stdout,
            stderr: ran.result.stderr,
            dump: ran.dump,
        };
    }
    return handleGitWorkerRequest(request);
}

function requestHttpFromHost(request: GitHttpRequest): Promise<Uint8Array> {
    const id = nextHttpId;
    nextHttpId += 1;
    return new Promise((resolve, reject) => {
        pendingHttp.set(id, { resolve, reject });
        scope.postMessage({ kind: "httpRequest", id, request });
    });
}
