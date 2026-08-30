import { writeGitIndex } from "./gitIndex";
import { hashGitBlob } from "./gitObject";
import { gitObjectStore, writeTreeObjects } from "./gitWrite";
import type { GitCpuRequest, GitWorkerResult } from "./gitWorkerProtocol";

export async function handleGitWorkerRequest(
    request: GitCpuRequest
): Promise<GitWorkerResult> {
    switch (request.op) {
        case "hashGitBlob":
            return {
                op: "hashGitBlob",
                hash: await hashGitBlob(request.content),
            };
        case "gitObjectStore": {
            const stored = await gitObjectStore(request.type, request.payload);
            return {
                op: "gitObjectStore",
                hash: stored.hash,
                compressed: stored.compressed,
            };
        }
        case "writeTreeFromIndex": {
            const built = await writeTreeObjects(request.entries);
            return {
                op: "writeTreeFromIndex",
                tree: built.tree,
                objects: built.objects,
            };
        }
        case "writeGitIndex":
            return {
                op: "writeGitIndex",
                data: await writeGitIndex(request.entries),
            };
        default: {
            const _exhaustive: never = request;
            throw new Error(
                `unhandled git worker op ${JSON.stringify(_exhaustive)}`
            );
        }
    }
}
