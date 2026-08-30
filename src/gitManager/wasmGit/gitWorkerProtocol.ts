import type { GitIndexEntry } from "./gitIndex";
import type { MemDump } from "./memDump";

export interface GitHttpRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: ArrayBuffer;
}

export type GitCpuRequest =
    | { op: "hashGitBlob"; content: Uint8Array }
    | { op: "gitObjectStore"; type: string; payload: Uint8Array }
    | { op: "writeTreeFromIndex"; entries: GitIndexEntry[] }
    | { op: "writeGitIndex"; entries: GitIndexEntry[] };

export type GitWorkerRequest =
    | GitCpuRequest
    | { op: "lg2Init" }
    | {
          op: "lg2Run";
          cwd: string;
          args: string[];
          dump: MemDump;
          ignoreErrors?: boolean;
      };

export type GitWorkerResult =
    | { op: "hashGitBlob"; hash: string }
    | {
          op: "gitObjectStore";
          hash: string;
          compressed: Uint8Array;
      }
    | {
          op: "writeTreeFromIndex";
          tree: string;
          objects: { hash: string; compressed: Uint8Array }[];
      }
    | { op: "writeGitIndex"; data: Uint8Array }
    | { op: "lg2Init" }
    | {
          op: "lg2Run";
          stdout: string;
          stderr: string;
          dump: MemDump;
      };

export interface GitWorkerJob {
    kind?: "job";
    id: number;
    request: GitWorkerRequest;
    wasm?: ArrayBuffer;
}

export type GitWorkerReply =
    | { kind?: "reply"; id: number; ok: true; result: GitWorkerResult }
    | { kind?: "reply"; id: number; ok: false; error: string };

export type GitWorkerHttpRequestMsg = {
    kind: "httpRequest";
    id: number;
    request: GitHttpRequest;
};

export type GitWorkerHttpResponseMsg =
    | { kind: "httpResponse"; id: number; ok: true; body: ArrayBuffer }
    | { kind: "httpResponse"; id: number; ok: false; error: string };
