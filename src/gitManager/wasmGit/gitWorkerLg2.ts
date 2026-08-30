import type { Lg2Module } from "wasm-git/lg2_async.js";
import initLg2 from "wasm-git/lg2_async.js";
import { containsLg2Error, isWasmTrap, type Lg2Result } from "./lg2Errors";
import {
    dumpMemRoots,
    LG2_DUMP_ROOTS,
    loadMemDump,
    type MemDump,
} from "./memDump";
import type { GitHttpRequest } from "./gitWorkerProtocol";

let module: Lg2Module | undefined;
let stdout: string[] = [];
let stderr: string[] = [];
let http: ((request: GitHttpRequest) => Promise<Uint8Array>) | undefined;

export function setWorkerHttp(
    send: (request: GitHttpRequest) => Promise<Uint8Array>
): void {
    http = send;
}

export async function workerLg2Init(wasm: ArrayBuffer): Promise<void> {
    if (module) return;
    const bytes = new Uint8Array(wasm);
    const loaded = await initLg2({
        print: (text) => stdout.push(text),
        printErr: (text) => stderr.push(text),
        instantiateWasm: (imports, successCallback) => {
            void WebAssembly.instantiate(bytes, imports)
                .then((result) =>
                    successCallback(result.instance, result.module)
                )
                .catch((error) => {
                    throw error;
                });
            return {};
        },
    });
    attachWorkerHttp(loaded);
    loaded.FS.writeFile(
        "/home/web_user/.gitconfig",
        "[core]\n\tautocrlf = false\n"
    );
    module = loaded;
}

export async function workerLg2Run(args: {
    cwd: string;
    args: string[];
    dump: MemDump;
    ignoreErrors?: boolean;
}): Promise<{ result: Lg2Result; dump: MemDump }> {
    if (!module) {
        throw new Error("wasm-git module is not initialized");
    }
    loadMemDump(module.FS, args.dump);
    stdout = [];
    stderr = [];
    try {
        module.FS.chdir(args.cwd);
        await module.callMain(args.args.slice());
    } catch (error) {
        stderr.push(
            "THROW: " + (error instanceof Error ? error.message : String(error))
        );
        if (isWasmTrap(error)) {
            module = undefined;
        }
    }
    const result: Lg2Result = {
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
    };
    if (!args.ignoreErrors && containsLg2Error(result.stderr)) {
        throw new Error(
            `git ${args.args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`
        );
    }
    if (!module) {
        throw new Error("wasm-git module is not initialized");
    }
    return { result, dump: dumpMemRoots(module.FS, LG2_DUMP_ROOTS) };
}

function attachWorkerHttp(mod: Lg2Module): void {
    let next = 1;
    const connections = new Map<
        number,
        {
            url: string;
            method: string;
            headers: Record<string, string>;
            chunks: Uint8Array[];
            response?: Uint8Array;
            offset: number;
            failed: boolean;
        }
    >();
    mod.emscriptenhttpconnect = (url, _bufferSize, method, headers) => {
        const id = next++;
        connections.set(id, {
            url,
            method: method ?? "GET",
            headers: headers ?? {},
            chunks: [],
            offset: 0,
            failed: false,
        });
        return Promise.resolve(id);
    };
    mod.emscriptenhttpwrite = (id, buffer, length) => {
        const connection = connections.get(id);
        if (!connection) return;
        connection.chunks.push(mod.HEAPU8.slice(buffer, buffer + length));
    };
    mod.emscriptenhttpread = async (id, buffer, bufferSize) => {
        const connection = connections.get(id);
        if (!connection || connection.failed || !http) return 0;
        if (!connection.response) {
            try {
                let body: ArrayBuffer | undefined;
                if (connection.chunks.length > 0) {
                    const total = connection.chunks.reduce(
                        (sum, chunk) => sum + chunk.byteLength,
                        0
                    );
                    const merged = new Uint8Array(total);
                    let offset = 0;
                    for (const chunk of connection.chunks) {
                        merged.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    body = merged.buffer;
                }
                connection.response = await http({
                    url: connection.url,
                    method: connection.method,
                    headers: connection.headers,
                    body,
                });
            } catch {
                connection.failed = true;
                return 0;
            }
        }
        const remaining = connection.response.length - connection.offset;
        const n = Math.min(remaining, bufferSize);
        mod.HEAPU8.set(
            connection.response.subarray(
                connection.offset,
                connection.offset + n
            ),
            buffer
        );
        connection.offset += n;
        return n;
    };
    mod.emscriptenhttpfree = (id) => {
        connections.delete(id);
    };
}
