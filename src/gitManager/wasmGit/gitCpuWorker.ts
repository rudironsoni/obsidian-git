import { handleGitWorkerRequest } from "./gitWorkerHandlers";
import type {
    GitCpuRequest,
    GitWorkerJob,
    GitWorkerReply,
} from "./gitWorkerProtocol";

interface GitWorkerScope {
    addEventListener(
        type: "message",
        listener: (event: MessageEvent<GitWorkerJob>) => void
    ): void;
    postMessage(message: unknown): void;
}

const scope = self as unknown as GitWorkerScope;

function isCpuRequest(
    request: GitWorkerJob["request"]
): request is GitCpuRequest {
    return (
        request.op === "hashGitBlob" ||
        request.op === "gitObjectStore" ||
        request.op === "writeTreeFromIndex" ||
        request.op === "writeGitIndex"
    );
}

scope.addEventListener("message", (event) => {
    const job = event.data;
    if (!isCpuRequest(job.request)) {
        const reply: GitWorkerReply = {
            id: job.id,
            ok: false,
            error: `cpu worker cannot run ${job.request.op}`,
        };
        scope.postMessage(reply);
        return;
    }
    void handleGitWorkerRequest(job.request)
        .then((result) => {
            const reply: GitWorkerReply = { id: job.id, ok: true, result };
            scope.postMessage(reply);
        })
        .catch((error: unknown) => {
            const reply: GitWorkerReply = {
                id: job.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
            scope.postMessage(reply);
        });
});

scope.postMessage({ kind: "ready" });
