import esbuild from "esbuild";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * wasm-git's Emscripten glue treats `process.versions.node` as Node unless
 * `process.type === "renderer"`. Obsidian's plugin thread is a renderer, but
 * a blob worker is not: Electron (and some mobile WebViews) still expose
 * `process`, so the worker runs `import("node:module")` and dies.
 *
 * Obsidian never runs this plugin in Node. Force the web/worker path.
 */
const WASM_GIT_NODE_GUARD =
    'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer"';
const WASM_GIT_NODE_IMPORT =
    'if(ENVIRONMENT_IS_NODE){const{createRequire}=await import("node:module");var require=createRequire(import.meta.url)}';
const WASM_GIT_NODE_REQUIRE =
    'if(ENVIRONMENT_IS_NODE){var require=()=>{throw new Error("node require is not available")}}';

function rewriteWasmGitForWeb(contents, filePath) {
    if (
        !contents.includes(WASM_GIT_NODE_GUARD) ||
        !contents.includes(WASM_GIT_NODE_IMPORT)
    ) {
        throw new Error(`wasm-git Node worker guards not found in ${filePath}`);
    }
    return contents
        .replace(WASM_GIT_NODE_GUARD, "var ENVIRONMENT_IS_NODE=false")
        .replace(WASM_GIT_NODE_IMPORT, WASM_GIT_NODE_REQUIRE);
}

export function wasmGitWebOnlyPlugin() {
    return {
        name: "wasm-git-web-only",
        setup(build) {
            build.onLoad({ filter: /lg2_async\.js$/ }, async (args) => {
                const contents = await fs.readFile(args.path, "utf8");
                return {
                    contents: rewriteWasmGitForWeb(contents, args.path),
                    loader: "js",
                };
            });
        },
    };
}

function stubWasmPlugin() {
    return {
        name: "stub-wasm-in-worker",
        setup(workerBuild) {
            workerBuild.onLoad({ filter: /\.wasm$/ }, () => ({
                contents: "export default new Uint8Array();",
                loader: "js",
            }));
        },
    };
}

export async function bundleGitWorker(entry, stubWasm) {
    const result = await esbuild.build({
        absWorkingDir: dirname,
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2018",
        logLevel: "silent",
        // wasm-git still names node builtins in dead Node branches.
        external: [
            "node:module",
            "node:crypto",
            "node:fs",
            "node:url",
            "node:path",
            "ws",
            "worker_threads",
        ],
        plugins: [
            wasmGitWebOnlyPlugin(),
            ...(stubWasm ? [stubWasmPlugin()] : []),
        ],
    });
    return result.outputFiles?.[0]?.text ?? "";
}
