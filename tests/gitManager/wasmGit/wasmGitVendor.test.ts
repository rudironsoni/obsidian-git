import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * esbuild.workers.mjs rewrites these exact strings so blob workers never
 * `import("node:module")`. If wasm-git changes them, that plugin must update.
 */
const WASM_GIT_NODE_GUARD =
    'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer"';
const WASM_GIT_NODE_IMPORT =
    'if(ENVIRONMENT_IS_NODE){const{createRequire}=await import("node:module");var require=createRequire(import.meta.url)}';

describe("wasm-git vendor glue", () => {
    it("still has the Node import the worker bundler strips", () => {
        const contents = readFileSync("vendor/wasm-git/lg2_async.js", "utf8");
        expect(contents).toContain(WASM_GIT_NODE_GUARD);
        expect(contents).toContain(WASM_GIT_NODE_IMPORT);
    });
});
